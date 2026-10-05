import { ProxyError, parseUpstreamError } from './errors.js';
import { sleep } from './util.js';

/**
 * POST a JSON body to an upstream provider with bounded pre-stream retries.
 * Retries stop once a successful response body is returned to the caller.
 *
 * @param {{url:string, headers:Record<string,string>, body:unknown, config:ReturnType<import('./config.js').loadConfig>, logger:ReturnType<import('./logging.js').createLogger>, signal?:AbortSignal, provider:string}} options
 */
export async function postJsonWithRetry(options) {
  const payload = JSON.stringify(options.body);
  let lastError;

  for (let attempt = 0; attempt <= options.config.maxRetries; attempt += 1) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error('Request aborted');
    try {
      options.logger.debug('upstream request', {
        provider: options.provider,
        url: options.url,
        attempt,
        body: summarizeRequest(options.body),
      });
      const response = await fetchWithHeaderTimeout(
        options.url,
        {
          method: 'POST',
          headers: options.headers,
          body: payload,
          signal: options.signal,
        },
        options.config.requestTimeoutMs,
      );

      if (response.ok) return response;

      const errorText = await readBoundedText(response, 2 * 1024 * 1024, {
        idleTimeoutMs: options.config.streamIdleTimeoutMs,
        signal: options.signal,
      });
      const error = parseUpstreamError(errorText, response.status);
      error.retryAfter = response.headers.get('retry-after');
      lastError = error;

      if (!isRetryableStatus(response.status) || attempt >= options.config.maxRetries) {
        throw error;
      }

      const delay = retryDelay(response.headers.get('retry-after'), options.config.retryBaseMs, attempt);
      options.logger.warn('retryable upstream status', {
        provider: options.provider,
        status: response.status,
        attempt,
        delay,
      });
      await sleep(delay, options.signal);
    } catch (error) {
      if (error instanceof ProxyError) {
        if (!isRetryableStatus(error.status) || attempt >= options.config.maxRetries) throw error;
        lastError = error;
      } else {
        if (options.signal?.aborted) throw options.signal.reason ?? error;
        lastError = new ProxyError(`Could not reach ${options.provider} upstream: ${error.message}`, {
          status: 502,
          type: 'api_error',
          cause: error,
        });
        if (attempt >= options.config.maxRetries) throw lastError;
      }
      const delay = options.config.retryBaseMs * 2 ** attempt + Math.floor(Math.random() * 100);
      options.logger.warn('retryable upstream transport error', {
        provider: options.provider,
        attempt,
        delay,
        error: lastError.message,
      });
      await sleep(delay, options.signal);
    }
  }

  throw lastError ?? new ProxyError('Upstream request failed', { status: 502 });
}


/**
 * Read a bounded successful JSON response.
 * @param {Response} response
 * @param {number} limit
 */
export async function readJsonResponse(response, limit, options = {}) {
  if (!response.body) throw new ProxyError('Upstream returned an empty response body', { status: 502 });
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    throw new ProxyError(`Upstream response exceeded ${limit} bytes`, { status: 502 });
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await readBodyChunk(reader, options.idleTimeoutMs, options.signal);
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new ProxyError(`Upstream response exceeded ${limit} bytes`, { status: 502 });
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {}
    throw error;
  } finally {
    reader.releaseLock();
  }
  const text = new TextDecoder().decode(concatBytes(chunks, total));
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ProxyError(`Upstream returned malformed JSON: ${error.message}`, {
      status: 502,
      type: 'api_error',
      cause: error,
    });
  }
}

function concatBytes(chunks, total) {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function fetchWithHeaderTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new ProxyError(`Upstream did not return headers within ${timeoutMs} ms`, { status: 504 })),
    timeoutMs,
  );

  const onAbort = () => controller.abort(init.signal.reason ?? new Error('Request aborted'));
  init.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
    init.signal?.removeEventListener('abort', onAbort);
  }
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function retryDelay(retryAfter, base, attempt) {
  if (retryAfter) {
    if (/^\d+(?:\.\d+)?$/.test(retryAfter.trim())) {
      return Math.min(120_000, Math.max(0, Math.round(Number(retryAfter) * 1000)));
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(120_000, Math.max(0, date - Date.now()));
  }
  return Math.min(120_000, base * 2 ** attempt + Math.floor(Math.random() * 100));
}

async function readBoundedText(response, limit, options = {}) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let out = '';
  try {
    while (true) {
      const { value, done } = await readBodyChunk(reader, options.idleTimeoutMs, options.signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        out += '\n[upstream error body truncated]';
        break;
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
    return out;
  } finally {
    try {
      await reader.cancel();
    } catch {}
    reader.releaseLock();
  }
}


function readBodyChunk(reader, timeoutMs = 300_000, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const timer = setTimeout(
      () =>
        finish(
          reject,
          new ProxyError(`Upstream response body was idle for more than ${timeoutMs} ms`, {
            status: 504,
            type: 'api_error',
          }),
        ),
      timeoutMs,
    );
    const onAbort = () => finish(reject, signal.reason ?? new Error('Aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function summarizeRequest(body) {
  return {
    model: body?.model,
    stream: body?.stream,
    inputItems: Array.isArray(body?.input) ? body.input.length : undefined,
    messages: Array.isArray(body?.messages) ? body.messages.length : undefined,
    tools: Array.isArray(body?.tools) ? body.tools.length : undefined,
    maxOutputTokens: body?.max_output_tokens ?? body?.max_completion_tokens,
  };
}

