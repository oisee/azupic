import { randomBytes } from 'node:crypto';

export function randomId(prefix = 'msg') {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('Aborted'));
      return;
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason ?? new Error('Aborted'));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function stripContextSuffix(model) {
  return String(model ?? '')
    .trim()
    .replace(/\[(?:1m|\d+k)\]$/i, '');
}

export function redactSecret(secret) {
  if (!secret) return '(not set)';
  if (secret.length <= 8) return `${secret.slice(0, 2)}…${secret.slice(-1)}`;
  return `${secret.slice(0, 5)}…${secret.slice(-4)}`;
}

export function isLoopbackAddress(address) {
  const normalized = String(address).toLowerCase();
  return normalized === '127.0.0.1' || normalized === '::1' || normalized === 'localhost';
}

export function parseBoolean(value, fallback = false) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function parseInteger(value, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

export function compactObject(value) {
  if (Array.isArray(value)) return value.map(compactObject);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, compactObject(entry)]),
  );
}

export function boundedJson(value, limit = 4096) {
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function normalizeBaseUrl(url, defaultValue) {
  const raw = String(url || defaultValue).trim().replace(/\/+$/, '');
  // Throws on invalid URLs early.
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TypeError(`Unsupported URL protocol: ${parsed.protocol}`);
  }
  return parsed.toString().replace(/\/$/, '');
}

export function stableStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (key, val) => {
    if (val && typeof val === 'object') {
      if (seen.has(val)) return '[Circular]';
      seen.add(val);
      if (!Array.isArray(val)) {
        return Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)));
      }
    }
    return val;
  });
}

