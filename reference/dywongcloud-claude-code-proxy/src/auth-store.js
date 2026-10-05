import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { authFile } from './paths.js';
import { ProxyError } from './errors.js';
import { redactSecret } from './util.js';

const PROVIDER_ENV = {
  openai: ['CCP_OPENAI_API_KEY', 'OPENAI_API_KEY'],
  moonshot: ['CCP_MOONSHOT_API_KEY', 'MOONSHOT_API_KEY'],
  tokenhub: ['CCP_TOKENHUB_API_KEY', 'TOKENHUB_API_KEY'],
};
const KEYCHAIN_ACCOUNT = 'api-key';

/**
 * @param {'openai'|'moonshot'|'tokenhub'} provider
 * @param {ReturnType<import('./config.js').loadConfig>} config
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function resolveApiKey(provider, config, env = process.env) {
  for (const name of PROVIDER_ENV[provider]) {
    const value = env[name]?.trim();
    if (value) return { key: value, source: `environment variable ${name}` };
  }

  const configured = config[provider]?.apiKeyFromConfig?.trim();
  if (configured) return { key: configured, source: `config.json ${provider}.apiKey` };

  const stored = readStoredKey(provider, env);
  if (stored?.apiKey) return { key: stored.apiKey, source: stored.path };

  return null;
}

/** @param {'openai'|'moonshot'|'tokenhub'} provider */
export function providerKeyNames(provider) {
  return [...PROVIDER_ENV[provider]];
}

/**
 * @param {'openai'|'moonshot'|'tokenhub'} provider
 * @param {string} apiKey
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function storeApiKey(provider, apiKey, env = process.env) {
  const key = apiKey.trim();
  validateApiKey(provider, key);

  const backend = authBackend(env);
  if (backend === 'keychain') {
    storeInMacKeychain(provider, key);
    // Remove a stale file copy so only one credential source remains.
    try {
      fs.rmSync(authFile(provider, env), { force: true });
    } catch {}
    return `macOS Keychain (${keychainService(provider)})`;
  }

  const location = authFile(provider, env);
  fs.mkdirSync(path.dirname(location), { recursive: true, mode: 0o700 });
  const payload = {
    provider,
    apiKey: key,
    storedAt: new Date().toISOString(),
  };
  fs.writeFileSync(location, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(location, 0o600);
  } catch {
    // Windows does not implement POSIX modes. The file remains inside the
    // user's application data directory.
  }
  return location;
}

/** @param {'openai'|'moonshot'|'tokenhub'} provider @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] */
export function removeStoredApiKey(provider, env = process.env) {
  const removed = [];
  if (process.platform === 'darwin') {
    const result = spawnSync(
      'security',
      ['delete-generic-password', '-s', keychainService(provider), '-a', KEYCHAIN_ACCOUNT],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (result.status === 0) removed.push(`macOS Keychain (${keychainService(provider)})`);
    else if (!/could not be found|item not found/i.test(`${result.stderr}${result.stdout}`)) {
      throw new ProxyError(`Could not delete ${provider} key from macOS Keychain: ${result.stderr.trim()}`, {
        cause: result.error,
      });
    }
  }

  const location = authFile(provider, env);
  try {
    if (fs.existsSync(location)) removed.push(location);
    fs.rmSync(location, { force: true });
  } catch (error) {
    throw new ProxyError(`Could not remove ${location}: ${error.message}`, { cause: error });
  }
  return removed.length ? removed.join(' and ') : location;
}

/** @param {'openai'|'moonshot'|'tokenhub'} provider @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env] */
export function readStoredKey(provider, env = process.env) {
  const backend = authBackend(env);
  if (backend === 'keychain') {
    const key = readMacKeychain(provider);
    if (key) {
      return {
        provider,
        apiKey: key,
        path: `macOS Keychain (${keychainService(provider)})`,
      };
    }
  }

  const location = authFile(provider, env);
  try {
    const parsed = JSON.parse(fs.readFileSync(location, 'utf8'));
    if (parsed?.provider !== provider || typeof parsed?.apiKey !== 'string' || !parsed.apiKey.trim()) {
      throw new Error('stored credential file has an invalid shape');
    }
    return { ...parsed, path: location };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new ProxyError(`Could not read stored ${provider} credentials from ${location}: ${error.message}`, {
      status: 500,
      cause: error,
    });
  }
}

/** @param {'openai'|'moonshot'|'tokenhub'} provider @param {string} key */
export function validateApiKey(provider, key) {
  if (!key || key.length < 16 || /\s/.test(key)) {
    throw new ProxyError(`${provider} API key is empty or malformed`, {
      status: 400,
      type: 'invalid_request_error',
    });
  }
  // Provider key prefixes can change, so length/no-whitespace is the only hard local check.
  return key;
}

/**
 * @param {'openai'|'moonshot'|'tokenhub'} provider
 * @param {ReturnType<import('./config.js').loadConfig>} config
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function authStatus(provider, config, env = process.env) {
  const resolved = resolveApiKey(provider, config, env);
  if (!resolved) {
    return { authenticated: false, provider, key: null, source: null };
  }
  return {
    authenticated: true,
    provider,
    key: redactSecret(resolved.key),
    source: resolved.source,
  };
}

function authBackend(env) {
  const requested = String(env.CCP_AUTH_STORE ?? 'auto').toLowerCase();
  if (!['auto', 'file', 'keychain'].includes(requested)) {
    throw new ProxyError('CCP_AUTH_STORE must be auto, file, or keychain', { status: 400 });
  }
  if (requested === 'file') return 'file';
  if (requested === 'keychain' && process.platform !== 'darwin') {
    throw new ProxyError('CCP_AUTH_STORE=keychain is only supported on macOS', { status: 400 });
  }
  return process.platform === 'darwin' ? 'keychain' : 'file';
}

function keychainService(provider) {
  return `claude-code-proxy.${provider}-api-key`;
}

function readMacKeychain(provider) {
  const result = spawnSync(
    'security',
    ['find-generic-password', '-s', keychainService(provider), '-a', KEYCHAIN_ACCOUNT, '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.status === 0) return result.stdout.trim() || null;
  const detail = `${result.stderr}${result.stdout}`;
  if (/could not be found|item not found/i.test(detail)) return null;
  if (result.error?.code === 'ENOENT') return null;
  throw new ProxyError(`Could not read ${provider} key from macOS Keychain: ${detail.trim()}`, {
    cause: result.error,
  });
}

function storeInMacKeychain(provider, key) {
  const result = spawnSync(
    'security',
    [
      'add-generic-password',
      '-U',
      '-s',
      keychainService(provider),
      '-a',
      KEYCHAIN_ACCOUNT,
      '-l',
      `Claude Code Proxy ${provider} API key`,
      '-w',
      key,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (result.status !== 0) {
    throw new ProxyError(`Could not store ${provider} key in macOS Keychain: ${result.stderr.trim()}`, {
      cause: result.error,
    });
  }
}

