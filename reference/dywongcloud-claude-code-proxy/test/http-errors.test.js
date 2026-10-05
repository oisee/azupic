import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { postJsonWithRetry, readJsonResponse } from '../src/http.js';
import { createLogger } from '../src/logging.js';
import { createProxyServer, listen } from '../src/server.js';
import { readRequestJson, startHttpServer } from './helpers.js';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

test('upstream client honors a retryable status before stream commitment', async (t) => {
  let attempts = 0;
  const upstream = await startHttpServer(async (request, response) => {
    await readRequestJson(request);
    attempts += 1;
    if (attempts === 1) {
      response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
      response.end(JSON.stringify({ error: { message: 'try again', type: 'rate_limit_error' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: [DONE]\n\n');
  });
  t.after(() => upstream.close());

  const response = await postJsonWithRetry({
    url: upstream.url,
    headers: { 'content-type': 'application/json' },
    body: { hello: 'world' },
    config: { maxRetries: 2, retryBaseMs: 1, requestTimeoutMs: 1000 },
    logger: quietLogger,
    provider: 'test',
  });
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
});

test('inbound proxy token protects non-health endpoints', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-proxy-auth-'));
  const env = {
    CCP_CONFIG_DIR: root,
    CCP_STATE_DIR: path.join(root, 'state'),
    CCP_PROXY_AUTH_TOKEN: 'this-is-a-long-local-proxy-token',
    CCP_LOG_STDERR: '0',
  };
  const config = loadConfig({ env });
  config.port = 0;
  const proxy = createProxyServer({ config, env, logger: createLogger(config) });
  await listen(proxy);
  t.after(() => new Promise((resolve) => proxy.server.close(resolve)));
  const address = proxy.server.address();
  const base = `http://127.0.0.1:${address.port}`;

  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const denied = await fetch(`${base}/models`);
  assert.equal(denied.status, 401);
  const allowed = await fetch(`${base}/models`, {
    headers: { 'x-api-key': env.CCP_PROXY_AUTH_TOKEN },
  });
  assert.equal(allowed.status, 200);
});

test('request body limit returns Anthropic request_too_large', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-size-'));
  const env = {
    CCP_CONFIG_DIR: root,
    CCP_STATE_DIR: path.join(root, 'state'),
    CCP_MAX_REQUEST_BYTES: '1024',
    CCP_LOG_STDERR: '0',
  };
  const config = loadConfig({ env });
  config.port = 0;
  const proxy = createProxyServer({ config, env, logger: createLogger(config) });
  await listen(proxy);
  t.after(() => new Promise((resolve) => proxy.server.close(resolve)));
  const address = proxy.server.address();

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(2000) }] }),
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.type, 'request_too_large');
});


test('successful JSON response bodies have an idle timeout after headers', async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
  });
  const response = new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
  await assert.rejects(
    () => readJsonResponse(response, 1024, { idleTimeoutMs: 20 }),
    /response body was idle/,
  );
});

test('loopback listener rejects DNS-rebinding Host headers and non-JSON POSTs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-loopback-hardening-'));
  const env = {
    CCP_CONFIG_DIR: root,
    CCP_STATE_DIR: path.join(root, 'state'),
    CCP_LOG_STDERR: '0',
  };
  const config = loadConfig({ env });
  config.port = 0;
  const proxy = createProxyServer({ config, env, logger: createLogger(config) });
  await listen(proxy);
  t.after(() => new Promise((resolve) => proxy.server.close(resolve)));
  const address = proxy.server.address();
  const endpoint = `http://127.0.0.1:${address.port}/v1/messages/count_tokens`;

  const reboundStatus = await new Promise((resolve, reject) => {
    const request = http.request(
      endpoint,
      {
        method: 'POST',
        headers: {
          host: 'attacker.example',
          'content-type': 'application/json',
        },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode));
      },
    );
    request.once('error', reject);
    request.end(JSON.stringify({ messages: [] }));
  });
  assert.equal(reboundStatus, 403);

  const simplePost = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify({ messages: [] }),
  });
  assert.equal(simplePost.status, 415);
  assert.equal((await simplePost.json()).error.type, 'invalid_request_error');
});

