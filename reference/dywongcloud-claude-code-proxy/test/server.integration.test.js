import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logging.js';
import { createProxyServer, listen } from '../src/server.js';
import { readRequestJson, startHttpServer } from './helpers.js';

test('proxy completes OpenAI non-streaming and Moonshot streaming requests end-to-end', async (t) => {
  const observed = [];
  const upstream = await startHttpServer(async (request, response) => {
    const body = await readRequestJson(request);
    observed.push({ path: request.url, authorization: request.headers.authorization, body });
    response.writeHead(200, { 'content-type': 'text/event-stream' });

    if (request.url === '/openai/v1/responses') {
      const events = [
        { type: 'response.output_text.delta', item_id: 'm1', content_index: 0, delta: 'OPENAI_OK' },
        { type: 'response.output_text.done', item_id: 'm1', content_index: 0 },
        { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2 } } },
      ];
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }

    if (request.url === '/moonshot/v1/chat/completions') {
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'thinking' }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'MOONSHOT_OK' }, finish_reason: 'stop' }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 6, completion_tokens: 3 } })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }

    response.writeHead(404).end();
  });
  t.after(() => upstream.close());

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-integration-'));
  const env = {
    CCP_CONFIG_DIR: root,
    CCP_STATE_DIR: path.join(root, 'state'),
    CCP_OPENAI_API_KEY: 'sk-openai-integration-abcdefghijklmnopqrstuvwxyz',
    CCP_MOONSHOT_API_KEY: 'moonshot-integration-abcdefghijklmnopqrstuvwxyz',
    CCP_OPENAI_BASE_URL: `${upstream.url}/openai/v1`,
    CCP_MOONSHOT_BASE_URL: `${upstream.url}/moonshot/v1`,
    CCP_LOG_STDERR: '0',
    CCP_MAX_RETRIES: '0',
  };
  const config = loadConfig({ env });
  config.port = 0;
  config.logFile = path.join(root, 'proxy.log');
  const proxy = createProxyServer({ config, env, logger: createLogger(config) });
  await listen(proxy);
  t.after(() => new Promise((resolve) => proxy.server.close(resolve)));
  const address = proxy.server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const openaiResponse = await fetch(`${base}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'session-integration' },
    body: JSON.stringify({
      model: 'openai/gpt-5.6-sol',
      max_tokens: 100,
      stream: false,
      system: 'Base OpenAI instructions.',
      messages: [
        { role: 'user', content: 'say ok' },
        { role: 'system', content: [{ type: 'text', text: 'Inline OpenAI reminder.' }] },
      ],
    }),
  });
  assert.equal(openaiResponse.status, 200);
  const openaiMessage = await openaiResponse.json();
  assert.equal(openaiMessage.content[0].text, 'OPENAI_OK');
  assert.equal(openaiMessage.usage.input_tokens, 5);

  const moonshotResponse = await fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'moonshot/kimi-k3',
      max_tokens: 100,
      stream: true,
      thinking: { type: 'enabled', budget_tokens: 20 },
      system: 'Base Moonshot instructions.',
      messages: [
        { role: 'user', content: 'say ok' },
        { role: 'system', content: 'Inline Moonshot reminder.' },
      ],
    }),
  });
  assert.equal(moonshotResponse.status, 200);
  const moonshotWire = await moonshotResponse.text();
  assert.match(moonshotWire, /thinking_delta/);
  assert.match(moonshotWire, /MOONSHOT_OK/);
  assert.match(moonshotWire, /"output_tokens":3/);
  assert.match(moonshotWire, /event: message_stop/);

  const countResponse = await fetch(`${base}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hello' }] }),
  });
  assert.equal(countResponse.status, 200);
  assert.ok((await countResponse.json()).input_tokens > 0);

  assert.equal(observed.length, 2);
  assert.equal(observed[0].authorization, `Bearer ${env.CCP_OPENAI_API_KEY}`);
  assert.equal(observed[0].body.model, 'gpt-5.6-sol');
  assert.equal(observed[0].body.prompt_cache_key, 'session-integration');
  assert.equal(
    observed[0].body.instructions,
    'Base OpenAI instructions.\n\nInline OpenAI reminder.',
  );
  assert.deepEqual(
    observed[0].body.input.filter((item) => item.type === 'message').map((item) => item.role),
    ['user'],
  );
  assert.equal(observed[1].authorization, `Bearer ${env.CCP_MOONSHOT_API_KEY}`);
  assert.equal(observed[1].body.model, 'kimi-k3');
  assert.equal(observed[1].body.messages[0].role, 'system');
  assert.equal(
    observed[1].body.messages[0].content,
    'Base Moonshot instructions.\n\nInline Moonshot reminder.',
  );
  assert.deepEqual(observed[1].body.messages.slice(1).map((message) => message.role), ['user']);

  const monitor = proxy.telemetry.snapshot();
  const tracked = monitor.sessions.find((session) => session.sessionId === 'session-integration');
  assert.ok(tracked, 'Claude Code session should be persisted in monitor history');
  assert.equal(tracked.completed, 1);
  assert.equal(tracked.inputTokens, 5);
  assert.equal(tracked.outputTokens, 2);
  assert.equal(monitor.totals.requests, 2);
  assert.equal(monitor.totals.completed, 2);
});

test('missing provider key returns an Anthropic authentication error', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-noauth-'));
  const env = { CCP_CONFIG_DIR: root, CCP_STATE_DIR: path.join(root, 'state'), CCP_LOG_STDERR: '0' };
  const config = loadConfig({ env });
  config.port = 0;
  const proxy = createProxyServer({ config, env, logger: createLogger(config) });
  await listen(proxy);
  t.after(() => new Promise((resolve) => proxy.server.close(resolve)));
  const address = proxy.server.address();

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'openai/gpt-5.6-sol',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.equal(body.error.type, 'authentication_error');
});

test('proxy preserves TokenHub native Anthropic streaming and tracks cache usage in the TUI store', async (t) => {
  let observed;
  const upstream = await startHttpServer(async (request, response) => {
    observed = {
      path: request.url,
      headers: request.headers,
      body: await readRequestJson(request),
    };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      ['message_start', {
        type: 'message_start',
        message: {
          id: 'msg_tokenhub_integration',
          type: 'message',
          role: 'assistant',
          model: 'deepseek-v4-flash',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 11,
            output_tokens: 0,
            cache_read_input_tokens: 7,
            cache_creation_input_tokens: 2,
          },
        },
      }],
      ['content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      }],
      ['content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'native thought' },
      }],
      ['content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'native-signature' },
      }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      }],
      ['content_block_delta', {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'TOKENHUB_PROXY_OK' },
      }],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      ['message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 5 },
      }],
      ['message_stop', { type: 'message_stop' }],
    ];
    for (const [event, data] of events) {
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
    response.end();
  });
  t.after(() => upstream.close());

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-tokenhub-integration-'));
  const env = {
    CCP_CONFIG_DIR: root,
    CCP_STATE_DIR: path.join(root, 'state'),
    CCP_TOKENHUB_API_KEY: 'sk-tokenhub-integration-abcdefghijklmnopqrstuvwxyz',
    CCP_TOKENHUB_BASE_URL: `${upstream.url}/v1`,
    CCP_LOG_STDERR: '0',
    CCP_MAX_RETRIES: '0',
  };
  const config = loadConfig({ env });
  config.port = 0;
  config.logFile = path.join(root, 'proxy.log');
  const proxy = createProxyServer({ config, env, logger: createLogger(config) });
  await listen(proxy);
  t.after(() => new Promise((resolve) => proxy.server.close(resolve)));
  const address = proxy.server.address();

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'x-claude-code-session-id': 'tokenhub-session',
    },
    body: JSON.stringify({
      model: 'tokenhub/deepseek-v4-flash[1m]',
      max_tokens: 4096,
      stream: true,
      thinking: { type: 'enabled', budget_tokens: 1024 },
      output_config: { effort: 'high' },
      system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });
  assert.equal(response.status, 200);
  const wire = await response.text();
  assert.match(wire, /native thought/);
  assert.match(wire, /native-signature/);
  assert.match(wire, /TOKENHUB_PROXY_OK/);
  assert.match(wire, /event: message_stop/);

  assert.equal(observed.path, '/v1/messages');
  assert.equal(observed.headers['x-api-key'], env.CCP_TOKENHUB_API_KEY);
  assert.equal(observed.headers.authorization, undefined);
  assert.equal(observed.headers['anthropic-version'], '2023-06-01');
  assert.equal(observed.headers['anthropic-beta'], 'prompt-caching-2024-07-31');
  assert.equal(observed.body.model, 'deepseek-v4-flash');
  assert.equal(observed.body.output_config.effort, 'high');
  assert.equal(observed.body.system[0].cache_control.type, 'ephemeral');

  const snapshot = proxy.telemetry.snapshot();
  const session = snapshot.sessions.find((item) => item.sessionId === 'tokenhub-session');
  assert.ok(session);
  assert.ok(session.providers.includes('tokenhub'));
  assert.equal(session.completed, 1);
  assert.equal(session.inputTokens, 11);
  assert.equal(session.outputTokens, 5);
  assert.equal(session.cacheReadTokens, 7);
  assert.equal(session.cacheCreationTokens, 2);
});


test('TokenHub in-stream Anthropic errors stay in-band and are recorded as failed', async (t) => {
  const upstream = await startHttpServer(async (request, response) => {
    await readRequestJson(request);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_error","type":"message","role":"assistant","model":"deepseek-v4-flash","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}\n\n');
    response.end('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"TokenHub stream quota reached","code":"429001","reqid":"req-tokenhub-error"}}\n\n');
  });
  t.after(() => upstream.close());

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-tokenhub-stream-error-'));
  const env = {
    CCP_CONFIG_DIR: root,
    CCP_STATE_DIR: path.join(root, 'state'),
    CCP_TOKENHUB_API_KEY: 'sk-tokenhub-error-abcdefghijklmnopqrstuvwxyz',
    CCP_TOKENHUB_BASE_URL: `${upstream.url}/v1`,
    CCP_LOG_STDERR: '0',
    CCP_MAX_RETRIES: '0',
  };
  const config = loadConfig({ env });
  config.port = 0;
  config.logFile = path.join(root, 'proxy.log');
  const proxy = createProxyServer({ config, env, logger: createLogger(config) });
  await listen(proxy);
  t.after(() => new Promise((resolve) => proxy.server.close(resolve)));
  const address = proxy.server.address();

  const response = await fetch(`http://127.0.0.1:${address.port}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-claude-code-session-id': 'tokenhub-error-session',
    },
    body: JSON.stringify({
      model: 'tokenhub/deepseek-v4-flash',
      max_tokens: 256,
      stream: true,
      messages: [{ role: 'user', content: 'trigger stream error' }],
    }),
  });
  assert.equal(response.status, 200);
  const wire = await response.text();
  assert.match(wire, /event: error/);
  assert.match(wire, /TokenHub stream quota reached/);

  const snapshot = proxy.telemetry.snapshot();
  const session = snapshot.sessions.find((item) => item.sessionId === 'tokenhub-error-session');
  assert.ok(session);
  assert.equal(session.completed, 0);
  assert.equal(session.failed, 1);
  assert.equal(snapshot.totals.failed, 1);
  const request = snapshot.recent.find((item) => item.sessionId === 'tokenhub-error-session');
  assert.equal(request.status, 429);
  assert.match(request.error, /TokenHub stream quota reached/);
});

