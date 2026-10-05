/**
 * Error type carrying an Anthropic-compatible error class and HTTP status.
 */
export class ProxyError extends Error {
  /**
   * @param {string} message
   * @param {{status?: number, type?: string, retryAfter?: string | null, cause?: unknown, details?: unknown}} [options]
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'ProxyError';
    this.status = options.status ?? 500;
    this.type = options.type ?? statusToAnthropicType(this.status);
    this.retryAfter = options.retryAfter ?? null;
    this.details = options.details;
  }
}

/** @param {number} status */
export function statusToAnthropicType(status) {
  if (status === 400 || status === 404 || status === 405 || status === 415 || status === 422) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 413) return 'request_too_large';
  if (status === 429) return 'rate_limit_error';
  if (status >= 500) return 'api_error';
  return 'api_error';
}

/** @param {unknown} error */
export function normalizeError(error) {
  if (error instanceof ProxyError) return error;
  if (error instanceof Error) {
    return new ProxyError(error.message || 'Unexpected proxy error', { cause: error });
  }
  return new ProxyError('Unexpected proxy error', { details: error });
}

/** @param {ProxyError | Error | unknown} error */
export function anthropicErrorBody(error) {
  const normalized = normalizeError(error);
  return {
    type: 'error',
    error: {
      type: normalized.type,
      message: normalized.message,
    },
  };
}

/**
 * Best-effort extraction of an upstream API error without leaking an entire
 * response body into user-facing errors.
 *
 * @param {string} text
 * @param {number} status
 */
export function parseUpstreamError(text, status) {
  let message = text.trim();
  let type;
  let code;
  try {
    const parsed = JSON.parse(text);
    const candidate = parsed?.error ?? parsed;
    message =
      candidate?.message ??
      candidate?.detail ??
      candidate?.error ??
      parsed?.message ??
      message;
    type = candidate?.type ?? parsed?.type;
    code = candidate?.code ?? parsed?.code;
  } catch {
    // Plain-text upstream error; keep the bounded text below.
  }

  if (typeof message !== 'string' || message.trim() === '') {
    message = `Upstream request failed with HTTP ${status}`;
  }
  if (message.length > 2000) message = `${message.slice(0, 2000)}…`;

  const inferredStatus = inferStatusFromUpstream(status, code, type, message);
  return new ProxyError(message, {
    status: inferredStatus,
    type: statusToAnthropicType(inferredStatus),
    details: { upstreamStatus: status, upstreamType: type, upstreamCode: code },
  });
}

/**
 * @param {number} status
 * @param {unknown} code
 * @param {unknown} type
 * @param {string} message
 */
function inferStatusFromUpstream(status, code, type, message) {
  if (status >= 400 && status < 500) return status;
  const businessStatus = String(code ?? '').match(/^([45]\d{2})\d{3}$/)?.[1];
  if (businessStatus) return Number(businessStatus);
  const haystack = `${String(code ?? '')} ${String(type ?? '')} ${message}`.toLowerCase();
  if (haystack.includes('context_length') || haystack.includes('context window') || haystack.includes('too many tokens')) {
    return 413;
  }
  if (haystack.includes('rate_limit') || haystack.includes('quota') || haystack.includes('too many requests')) {
    return 429;
  }
  if (haystack.includes('authentication') || haystack.includes('invalid api key')) return 401;
  if (haystack.includes('permission') || haystack.includes('forbidden')) return 403;
  return status >= 400 && status < 600 ? status : 502;
}

