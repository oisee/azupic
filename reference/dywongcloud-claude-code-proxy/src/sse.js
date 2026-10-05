import { ProxyError } from './errors.js';

const encoder = new TextEncoder();

/** @param {string} event @param {unknown} data */
export function encodeSse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** @param {string} text */
export function encodeComment(text = 'ping') {
  return `: ${text.replace(/[\r\n]/g, ' ')}\n\n`;
}

/** @param {string} text */
export function toBytes(text) {
  return encoder.encode(text);
}

/**
 * Parse a WHATWG ReadableStream containing server-sent events.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @param {{maxBytes?: number, idleTimeoutMs?: number, signal?: AbortSignal}} [options]
 */
export async function* parseSse(stream, options = {}) {
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  const idleTimeoutMs = options.idleTimeoutMs ?? 300_000;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;

  try {
    while (true) {
      const result = await readWithTimeout(reader, idleTimeoutMs, options.signal);
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        throw new ProxyError(`Upstream streaming response exceeded ${maxBytes} bytes`, {
          status: 502,
          type: 'api_error',
        });
      }
      buffer += decoder.decode(result.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

      while (true) {
        const boundary = buffer.indexOf('\n\n');
        if (boundary < 0) break;
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseFrame(frame);
        if (parsed) yield parsed;
      }
    }

    buffer += decoder.decode();
    const final = buffer.trim();
    if (final) {
      const parsed = parseFrame(final);
      if (parsed) yield parsed;
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {}
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** @param {string} frame */
function parseFrame(frame) {
  let event = 'message';
  let id;
  const data = [];
  for (const line of frame.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
    else if (field === 'id') id = value;
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n'), id };
}

function readWithTimeout(reader, timeoutMs, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('Aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new ProxyError(`Upstream stream was idle for more than ${timeoutMs} ms`, {
          status: 504,
          type: 'api_error',
        }),
      );
    }, timeoutMs);

    const onAbort = () => reject(signal.reason ?? new Error('Aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });

    reader.read().then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** @param {string} data */
export function parseSseJson(data, context = 'upstream SSE event') {
  try {
    return JSON.parse(data);
  } catch (error) {
    throw new ProxyError(`Malformed JSON in ${context}: ${error.message}`, {
      status: 502,
      type: 'api_error',
      cause: error,
    });
  }
}

