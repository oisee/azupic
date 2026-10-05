import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { authStatus, removeStoredApiKey, resolveApiKey, storeApiKey } from '../src/auth-store.js';
import { loadConfig } from '../src/config.js';
import { main } from '../src/cli.js';
import { startHttpServer } from './helpers.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-config-'));
  const env = { CCP_CONFIG_DIR: root, CCP_STATE_DIR: path.join(root, 'state') };
  return { root, env };
}

test('configuration uses env > file > defaults', () => {
  const { root, env } = fixture();
  fs.writeFileSync(
    path.join(root, 'config.json'),
    JSON.stringify({
      port: 19999,
      defaultProvider: 'moonshot',
      openai: { baseUrl: 'https://example.test/v1', defaultModel: 'from-file' },
    }),
  );
  const config = loadConfig({
    env: { ...env, PORT: '18888', CCP_OPENAI_DEFAULT_MODEL: 'from-env' },
  });
  assert.equal(config.port, 18888);
  assert.equal(config.defaultProvider, 'moonshot');
  assert.equal(config.openai.baseUrl, 'https://example.test/v1');
  assert.equal(config.openai.defaultModel, 'from-env');
  assert.equal(config.openai.encryptedReasoning, true);
  assert.equal(config.moonshot.baseUrl, 'https://api.moonshot.ai/v1');
  assert.equal(config.moonshot.mergeSystemIntoUserForK3, false);
  assert.equal(config.tokenhub.baseUrl, 'https://tokenhub-intl.tencentcloudmaas.com/v1');
  assert.equal(config.tokenhub.defaultModel, 'deepseek-v4-flash');
  assert.equal(config.tokenhub.requestTimeoutMs, 600000);
});

test('stored API key is resolved and environment overrides it', () => {
  const { env } = fixture();
  const config = loadConfig({ env });
  const location = storeApiKey('openai', 'sk-test-abcdefghijklmnopqrstuvwxyz', env);
  assert.ok(fs.existsSync(location));
  assert.equal(resolveApiKey('openai', config, env).key, 'sk-test-abcdefghijklmnopqrstuvwxyz');
  assert.match(authStatus('openai', config, env).key, /^sk-te…/);

  const envOverride = { ...env, OPENAI_API_KEY: 'sk-env-abcdefghijklmnopqrstuvwxyz' };
  assert.equal(resolveApiKey('openai', config, envOverride).key, 'sk-env-abcdefghijklmnopqrstuvwxyz');
  assert.match(resolveApiKey('openai', config, envOverride).source, /OPENAI_API_KEY/);

  removeStoredApiKey('openai', env);
  assert.equal(resolveApiKey('openai', config, env), null);
});


test('TokenHub credentials support storage and environment precedence', () => {
  const { env } = fixture();
  const config = loadConfig({ env });
  const location = storeApiKey('tokenhub', 'sk-tokenhub-file-abcdefghijklmnopqrstuvwxyz', env);
  assert.ok(fs.existsSync(location));
  assert.equal(resolveApiKey('tokenhub', config, env).key, 'sk-tokenhub-file-abcdefghijklmnopqrstuvwxyz');
  const override = { ...env, TOKENHUB_API_KEY: 'sk-tokenhub-env-abcdefghijklmnopqrstuvwxyz' };
  assert.equal(resolveApiKey('tokenhub', config, override).key, 'sk-tokenhub-env-abcdefghijklmnopqrstuvwxyz');
  removeStoredApiKey('tokenhub', env);
});

test('non-loopback binding requires an inbound proxy token', () => {
  const { env } = fixture();
  assert.throws(
    () => loadConfig({ env: { ...env, CCP_BIND_ADDRESS: '0.0.0.0' } }),
    /CCP_PROXY_AUTH_TOKEN/,
  );
  const config = loadConfig({
    env: { ...env, CCP_BIND_ADDRESS: '0.0.0.0', CCP_PROXY_AUTH_TOKEN: 'long-enough-token' },
  });
  assert.equal(config.bindAddress, '0.0.0.0');
});


test('browser CORS opt-in requires proxy authentication', () => {
  const { env } = fixture();
  assert.throws(
    () => loadConfig({ env: { ...env, CCP_CORS_ORIGIN: 'https://app.example' } }),
    /requires CCP_PROXY_AUTH_TOKEN/,
  );
  const config = loadConfig({
    env: {
      ...env,
      CCP_CORS_ORIGIN: 'https://app.example/path',
      CCP_PROXY_AUTH_TOKEN: 'a-long-local-token',
    },
  });
  assert.equal(config.corsOrigin, 'https://app.example');
});


test('TokenHub credential test queries the OpenAI-style model catalog with bearer auth', async (t) => {
  let observed;
  const upstream = await startHttpServer(async (request, response) => {
    observed = { path: request.url, headers: request.headers };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'deepseek-v4-flash', status: 'online' }] }));
  });
  t.after(() => upstream.close());
  const { env } = fixture();
  const code = await main(['tokenhub', 'auth', 'test'], {
    ...env,
    CCP_TOKENHUB_API_KEY: 'sk-tokenhub-test-abcdefghijklmnopqrstuvwxyz',
    CCP_TOKENHUB_BASE_URL: `${upstream.url}/v1`,
    CCP_LOG_STDERR: '0',
  });
  assert.equal(code, 0);
  assert.equal(observed.path, '/v1/models');
  assert.equal(observed.headers.authorization, 'Bearer sk-tokenhub-test-abcdefghijklmnopqrstuvwxyz');
  assert.equal(observed.headers['x-api-key'], undefined);
});

test('TokenHub Token Plan credential test uses the matching plan model catalog', async (t) => {
  let observed;
  const upstream = await startHttpServer(async (request, response) => {
    observed = { path: request.url, headers: request.headers };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'auto', status: 'online' }] }));
  });
  t.after(() => upstream.close());
  const { env } = fixture();
  const code = await main(['tokenhub', 'auth', 'test'], {
    ...env,
    CCP_TOKENHUB_API_KEY: 'sk-tp-test-abcdefghijklmnopqrstuvwxyz',
    CCP_TOKENHUB_BASE_URL: `${upstream.url}/plan/anthropic`,
    CCP_LOG_STDERR: '0',
  });
  assert.equal(code, 0);
  assert.equal(observed.path, '/plan/v3/models');
  assert.equal(observed.headers.authorization, 'Bearer sk-tp-test-abcdefghijklmnopqrstuvwxyz');
});

