import http from 'node:http';
import { once } from 'node:events';
import { timingSafeEqual } from 'node:crypto';
import { URL } from 'node:url';
import {
  AnthropicEventEncoder,
  accumulateAnthropicMessage,
  validateAnthropicRequest,
} from './anthropic.js';
import { anthropicErrorBody, normalizeError, parseUpstreamError, ProxyError } from './errors.js';
import { createLogger } from './logging.js';
import { createMonitorStore } from './monitor-store.js';
import { createMoonshotProvider } from './providers/moonshot.js';
import { createOpenAIProvider } from './providers/openai.js';
import { createTokenHubProvider } from './providers/tokenhub.js';
import { modelCatalog, resolveRoute } from './router.js';
import { encodeSse } from './sse.js';
import { estimateAnthropicTokens } from './tokens.js';
import { isLoopbackAddress, randomId } from './util.js';
import { VERSION } from './version.js';

/**
 * @param {{config:ReturnType<import('./config.js').loadConfig>, env?:NodeJS.ProcessEnv|Record<string,string|undefined>, logger?:ReturnType<import('./logging.js').createLogger>, telemetry?:ReturnType<import('./monitor-store.js').createMonitorStore>}} options
 */
export function createProxyServer(options) {
  const config = options.config;
  const logger = options.logger ?? createLogger(config);
  const telemetry = options.telemetry ?? createMonitorStore(config);
  const providers = {
    openai: createOpenAIProvider({ config, logger, env: options.env }),
    moonshot: createMoonshotProvider({ config, logger, env: options.env }),
    tokenhub: createTokenHubProvider({ config, logger, env: options.env }),
  };

  const server = http.createServer((request, response) => {
    handleRequest(request, response, { config, logger, providers, telemetry }).catch((error) => {
      const normalized = normalizeError(error);
      logger.error('unhandled request error', { error: normalized.message, stack: normalized.stack });
      if (!response.headersSent) writeJsonError(response, normalized, randomId('req'), config);
      else response.destroy(normalized);
    });
  });

  server.requestTimeout = 0;
  server.headersTimeout = Math.max(60_000, config.requestTimeoutMs + 5_000);
  server.keepAliveTimeout = 65_000;
  server.once('close', () => telemetry.processStopped('server_close'));
  return { server, logger, config, telemetry };
}

/**
 * @param {ReturnType<typeof createProxyServer>} proxy
 */
export async function listen(proxy) {
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    proxy.server.once('error', onError);
    proxy.server.listen(proxy.config.port, proxy.config.bindAddress, () => {
      proxy.server.off('error', onError);
      resolve();
    });
  });
  const address = proxy.server.address();
  proxy.telemetry?.processStarted({
    version: VERSION,
    bindAddress: typeof address === 'object' && address ? address.address : proxy.config.bindAddress,
    port: typeof address === 'object' && address ? address.port : proxy.config.port,
  });
  return address;
}

async function handleRequest(request, response, context) {
  const requestId = randomId('req');
  requireSafeHost(request, context.config);
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  response.setHeader('x-request-id', requestId);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, corsHeaders(context.config));
    response.end();
    return;
  }

  if (request.method === 'GET' && url.pathname === '/healthz') {
    writeJson(response, 200, { ok: true, version: VERSION, providers: ['openai', 'moonshot', 'tokenhub'] }, requestId, context.config);
    return;
  }
  if (request.method === 'GET' && (url.pathname === '/models' || url.pathname === '/v1/models')) {
    requireProxyAuth(request, context.config);
    const catalog = modelCatalog(context.config);
    if (url.pathname === '/v1/models') {
      writeJson(
        response,
        200,
        {
          object: 'list',
          data: catalog.map((item) => ({ id: item.route, object: 'model', owned_by: item.provider })),
        },
        requestId,
        context.config,
      );
    } else {
      writeJson(response, 200, { models: catalog }, requestId, context.config);
    }
    return;
  }
  if (request.method === 'GET' && url.pathname === '/') {
    writeJson(
      response,
      200,
      {
        name: 'claude-code-proxy-openai-moonshot-tokenhub',
        version: VERSION,
        endpoints: ['/v1/messages', '/v1/messages/count_tokens', '/healthz', '/models'],
      },
      requestId,
      context.config,
    );
    return;
  }

  if (request.method !== 'POST') {
    throw new ProxyError(`Unsupported method ${request.method}`, { status: 405 });
  }
  requireProxyAuth(request, context.config);
  requireJsonContentType(request);

  if (url.pathname === '/v1/messages/count_tokens') {
    const body = await readJsonBody(request, context.config.maxRequestBytes);
    // The count endpoint accepts the same shape but does not require
    // max_tokens or a configured upstream credential.
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) {
      throw new ProxyError('messages must be an array', { status: 400 });
    }
    writeJson(response, 200, { input_tokens: estimateAnthropicTokens(body) }, requestId, context.config);
    return;
  }

  if (url.pathname !== '/v1/messages') {
    throw new ProxyError(`Unknown endpoint ${url.pathname}`, { status: 404 });
  }

  const body = validateAnthropicRequest(await readJsonBody(request, context.config.maxRequestBytes));
  const route = resolveRoute(body.model, context.config);
  const provider = context.providers[route.provider];
  if (!provider) throw new ProxyError(`No provider registered for ${route.provider}`, { status: 500 });

  const abortController = new AbortController();
  const abort = () => {
    if (!abortController.signal.aborted) abortController.abort(new Error('Downstream client disconnected'));
  };
  response.once('close', abort);

  const sessionId = requestSessionId(request, body);
  const agentId = requestAgentId(request, body);
  const startedAt = Date.now();
  context.logger.info('request started', {
    requestId,
    sessionId,
    agentId,
    provider: route.provider,
    requestedModel: body.model,
    upstreamModel: route.model,
    stream: body.stream === true,
  });
  context.telemetry?.requestStarted({
    requestId,
    sessionId,
    agentId,
    provider: route.provider,
    requestedModel: body.model,
    upstreamModel: route.model,
    stream: body.stream === true,
    endpoint: url.pathname,
    messageCount: body.messages.length,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
  });

  try {
    const execution = await provider.execute(body, route, {
      signal: abortController.signal,
      headers: new Headers(Object.entries(request.headers).filter(([, value]) => typeof value === 'string')),
    });
    let usage;
    let stopReason;
    if (execution.nativeAnthropicFrames) {
      const summary = await streamNativeAnthropicResponse(response, execution.nativeAnthropicFrames, {
        requestId,
        config: context.config,
        signal: abortController.signal,
      });
      usage = summary.usage;
      stopReason = summary.stopReason;
    } else if (execution.nativeAnthropicMessage) {
      const message = execution.nativeAnthropicMessage;
      usage = normalizeNativeUsage(message.usage);
      stopReason = message.stop_reason ?? 'end_turn';
      if (body.stream === true) {
        await streamNativeAnthropicMessage(response, message, {
          requestId,
          config: context.config,
          signal: abortController.signal,
        });
      } else {
        writeJson(response, 200, message, requestId, context.config);
      }
    } else if (body.stream === true) {
      const summary = await streamAnthropicResponse(response, execution.events, {
        requestId,
        requestModel: body.model,
        responseModel: execution.upstreamModel,
        config: context.config,
        logger: context.logger,
        signal: abortController.signal,
      });
      usage = summary.usage;
      stopReason = summary.stopReason;
    } else {
      const message = await accumulateAnthropicMessage(execution.events, {
        requestModel: body.model,
        responseModel: execution.upstreamModel,
      });
      usage = message.usage;
      stopReason = message.stop_reason;
      writeJson(response, 200, message, requestId, context.config);
    }
    context.telemetry?.requestFinished(requestId, {
      outcome: 'ok',
      status: 200,
      durationMs: Date.now() - startedAt,
      usage,
      stopReason,
    });
    context.logger.info('request completed', { requestId, sessionId, provider: route.provider, model: route.model, durationMs: Date.now() - startedAt, usage });
  } catch (error) {
    const normalized = normalizeError(error);
    const aborted = abortController.signal.aborted;
    context.telemetry?.requestFinished(requestId, {
      outcome: aborted ? 'aborted' : 'error',
      status: normalized.status,
      durationMs: Date.now() - startedAt,
      error: normalized.message,
    });
    if (aborted && !response.headersSent) return;
    context.logger.warn('request failed', {
      requestId,
      sessionId,
      provider: route.provider,
      model: route.model,
      status: normalized.status,
      durationMs: Date.now() - startedAt,
      error: normalized.message,
    });
    if (!response.headersSent) writeJsonError(response, normalized, requestId, context.config);
    else if (!response.writableEnded && !response.destroyed) {
      response.write(encodeSse('error', anthropicErrorBody(normalized)));
      response.end();
    }
  } finally {
    response.off('close', abort);
  }
}

function requestSessionId(request, body) {
  return headerString(request.headers['x-claude-code-session-id'])
    ?? headerString(request.headers['x-session-id'])
    ?? scalarMetadata(body?.metadata?.session_id)
    ?? 'unattributed';
}

function requestAgentId(request, body) {
  return headerString(request.headers['x-claude-code-agent-id'])
    ?? headerString(request.headers['x-claude-agent-id'])
    ?? scalarMetadata(body?.metadata?.agent_id);
}

function headerString(value) {
  if (Array.isArray(value)) value = value[0];
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return cleaned ? cleaned.slice(0, 160) : undefined;
}

function scalarMetadata(value) {
  if (!['string', 'number'].includes(typeof value)) return undefined;
  return headerString(String(value));
}

async function streamNativeAnthropicResponse(response, frames, options) {
  response.writeHead(200, {
    ...corsHeaders(options.config),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-request-id': options.requestId,
  });
  response.flushHeaders?.();

  const usage = normalizeNativeUsage();
  let stopReason = null;
  let terminal = false;
  let streamError = null;
  const iterator = frames[Symbol.asyncIterator]();

  while (true) {
    const result = await nextWithPings(iterator, response, options.config.pingIntervalMs, options.signal);
    if (result.done) break;
    const frame = result.value;
    if (frame.data === '[DONE]') continue;
    let payload;
    try {
      payload = JSON.parse(frame.data);
    } catch (error) {
      throw new ProxyError(`TokenHub returned malformed Anthropic SSE JSON: ${error.message}`, {
        status: 502,
        type: 'api_error',
        cause: error,
      });
    }
    const kind = payload?.type ?? frame.event;
    if (kind === 'message_start') mergeNativeUsage(usage, payload?.message?.usage);
    if (kind === 'message_delta') {
      mergeNativeUsage(usage, payload?.usage);
      stopReason = payload?.delta?.stop_reason ?? stopReason;
    }
    if (kind === 'message_stop') terminal = true;
    if (kind === 'error') {
      terminal = true;
      streamError = nativeAnthropicStreamError(payload);
    }
    await writeFrame(response, encodeNativeSseFrame(frame.event || kind || 'message', payload, frame.id), options.signal);
  }

  if (!terminal) {
    throw new ProxyError('TokenHub Anthropic stream ended before message_stop', {
      status: 502,
      type: 'api_error',
    });
  }
  response.end();
  if (streamError) throw streamError;
  return { usage, stopReason: stopReason ?? 'end_turn' };
}

function nativeAnthropicStreamError(payload) {
  return parseUpstreamError(JSON.stringify(payload), Number(payload?.status ?? 502));
}

async function streamNativeAnthropicMessage(response, message, options) {
  response.writeHead(200, {
    ...corsHeaders(options.config),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-request-id': options.requestId,
  });
  response.flushHeaders?.();

  const usage = normalizeNativeUsage(message?.usage);
  await writeFrame(response, encodeSse('message_start', {
    type: 'message_start',
    message: {
      id: message.id ?? randomId('msg'),
      type: 'message',
      role: 'assistant',
      model: message.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: 0,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
      },
    },
  }), options.signal);

  for (let index = 0; index < (message.content ?? []).length; index += 1) {
    const block = message.content[index];
    const start = nativeBlockStart(block);
    await writeFrame(response, encodeSse('content_block_start', {
      type: 'content_block_start', index, content_block: start,
    }), options.signal);
    for (const delta of nativeBlockDeltas(block)) {
      await writeFrame(response, encodeSse('content_block_delta', {
        type: 'content_block_delta', index, delta,
      }), options.signal);
    }
    await writeFrame(response, encodeSse('content_block_stop', {
      type: 'content_block_stop', index,
    }), options.signal);
  }

  await writeFrame(response, encodeSse('message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: message.stop_reason ?? 'end_turn',
      stop_sequence: message.stop_sequence ?? null,
    },
    usage: { output_tokens: usage.output_tokens },
  }), options.signal);
  await writeFrame(response, encodeSse('message_stop', { type: 'message_stop' }), options.signal);
  response.end();
}

function nativeBlockStart(block) {
  if (block?.type === 'text') return { ...block, text: '' };
  if (block?.type === 'thinking') return { ...block, thinking: '', signature: '' };
  if (block?.type === 'tool_use') return { ...block, input: {} };
  return block;
}

function nativeBlockDeltas(block) {
  if (block?.type === 'text') return block.text ? [{ type: 'text_delta', text: block.text }] : [];
  if (block?.type === 'thinking') {
    const out = [];
    if (block.thinking) out.push({ type: 'thinking_delta', thinking: block.thinking });
    if (block.signature) out.push({ type: 'signature_delta', signature: block.signature });
    return out;
  }
  if (block?.type === 'tool_use') {
    return [{ type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) }];
  }
  return [];
}

function encodeNativeSseFrame(event, payload, id) {
  const safeEvent = String(event || 'message').replace(/[\r\n]/g, '');
  const safeId = id == null ? '' : `id: ${String(id).replace(/[\r\n]/g, '')}\n`;
  return `${safeId}event: ${safeEvent}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function normalizeNativeUsage(value = {}) {
  return {
    input_tokens: nativeInteger(value.input_tokens ?? value.prompt_tokens),
    output_tokens: nativeInteger(value.output_tokens ?? value.completion_tokens),
    cache_creation_input_tokens: nativeInteger(
      value.cache_creation_input_tokens ?? value.cache_creation_tokens,
    ),
    cache_read_input_tokens: nativeInteger(
      value.cache_read_input_tokens
        ?? value.cache_token_usage
        ?? value.cache_tokens
        ?? value.cached_tokens
        ?? value.input_tokens_details?.cached_tokens
        ?? value.prompt_tokens_details?.cached_tokens,
    ),
  };
}

function mergeNativeUsage(target, value = {}) {
  const next = normalizeNativeUsage(value);
  for (const key of Object.keys(target)) {
    if (next[key] || target[key] === 0) target[key] = Math.max(target[key], next[key]);
  }
  return target;
}

function nativeInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

async function streamAnthropicResponse(response, events, options) {
  response.writeHead(200, {
    ...corsHeaders(options.config),
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
    'x-request-id': options.requestId,
  });
  response.flushHeaders?.();

  const encoder = new AnthropicEventEncoder({
    requestModel: options.requestModel,
    responseModel: options.responseModel,
  });
  for (const frame of encoder.start()) await writeFrame(response, frame, options.signal);

  const iterator = events[Symbol.asyncIterator]();
  while (true) {
    const result = await nextWithPings(iterator, response, options.config.pingIntervalMs, options.signal);
    if (result.done) break;
    for (const frame of encoder.apply(result.value)) await writeFrame(response, frame, options.signal);
  }
  if (!encoder.finished) {
    for (const frame of encoder.finish()) await writeFrame(response, frame, options.signal);
  }
  response.end();
  return { usage: { ...encoder.usage }, stopReason: encoder.stopReason };
}

async function nextWithPings(iterator, response, pingIntervalMs, signal) {
  const pending = iterator.next().then((value) => ({ kind: 'value', value }));
  let abortHandler;
  const abort = signal
    ? new Promise((_, reject) => {
        abortHandler = () => reject(signal.reason ?? new Error('Aborted'));
        if (signal.aborted) abortHandler();
        else signal.addEventListener('abort', abortHandler, { once: true });
      })
    : new Promise(() => {});

  try {
    while (true) {
      let timer;
      const ping = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'ping' }), pingIntervalMs);
        timer.unref?.();
      });
      const result = await Promise.race([pending, ping, abort]);
      clearTimeout(timer);
      if (result.kind === 'ping') {
        await writeFrame(response, encodeSse('ping', { type: 'ping' }), signal);
        continue;
      }
      return result.value;
    }
  } finally {
    if (abortHandler) signal?.removeEventListener('abort', abortHandler);
  }
}

async function writeFrame(response, frame, signal) {
  if (response.destroyed || response.writableEnded) {
    throw signal?.reason ?? new Error('Downstream response is no longer writable');
  }
  if (response.write(frame)) return;
  await once(response, 'drain', signal ? { signal } : undefined);
}

function requireJsonContentType(request) {
  const raw = String(request.headers['content-type'] ?? '');
  const mediaType = raw.split(';', 1)[0].trim().toLowerCase();
  if (mediaType !== 'application/json' && !mediaType.endsWith('+json')) {
    throw new ProxyError('Content-Type must be application/json', {
      status: 415,
      type: 'invalid_request_error',
    });
  }
}

function requireSafeHost(request, config) {
  if (!isLoopbackAddress(config.bindAddress) || config.proxyAuthToken) return;
  const rawHost = request.headers.host;
  if (typeof rawHost !== 'string' || !rawHost) {
    throw new ProxyError('Host header is required', { status: 400 });
  }
  let hostname;
  try {
    hostname = new URL(`http://${rawHost}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch (error) {
    throw new ProxyError(`Invalid Host header: ${error.message}`, { status: 400, cause: error });
  }
  if (!isLoopbackAddress(hostname)) {
    throw new ProxyError(
      'Rejected a non-loopback Host header on the unauthenticated loopback listener. ' +
        'Use localhost/127.0.0.1 or configure CCP_PROXY_AUTH_TOKEN.',
      { status: 403, type: 'permission_error' },
    );
  }
}

async function readJsonBody(request, limit) {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    throw new ProxyError(`Request body exceeds ${limit} bytes`, { status: 413, type: 'request_too_large' });
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > limit) {
      throw new ProxyError(`Request body exceeds ${limit} bytes`, { status: 413, type: 'request_too_large' });
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text || '{}');
  } catch (error) {
    throw new ProxyError(`Invalid JSON body: ${error.message}`, { status: 400, cause: error });
  }
}

function requireProxyAuth(request, config) {
  if (!config.proxyAuthToken) return;
  const authorization = request.headers.authorization;
  const bearer = typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : '';
  const candidate = String(request.headers['x-api-key'] ?? bearer ?? '');
  if (!constantTimeEqual(candidate, config.proxyAuthToken)) {
    throw new ProxyError('Invalid proxy authentication token', { status: 401, type: 'authentication_error' });
  }
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function writeJsonError(response, error, requestId, config) {
  const headers = {};
  if (error.retryAfter) headers['retry-after'] = error.retryAfter;
  writeJson(response, error.status ?? 500, anthropicErrorBody(error), requestId, config, headers);
}

function writeJson(response, status, body, requestId, config, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...corsHeaders(config),
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    ...extraHeaders,
  });
  response.end(payload);
}

function corsHeaders(config) {
  if (!config?.corsOrigin) return {};
  return {
    'access-control-allow-origin': config.corsOrigin,
    vary: 'Origin',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers':
      'content-type, authorization, x-api-key, anthropic-version, anthropic-beta, hunyuan-beta, x-claude-code-session-id, x-claude-code-agent-id',
  };
}

