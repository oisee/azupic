import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logging.js';
import {
  accumulateTokenHubStream,
  createTokenHubProvider,
  tokenHubMessagesUrl,
  translateTokenHubRequest,
} from '../src/providers/tokenhub.js';
import { readRequestJson, startHttpServer } from './helpers.js';

function fixtureEnv(root, upstreamUrl) {
  return {
    CCP_CONFIG_DIR: root,
    CCP_STATE_DIR: path.join(root, 'state'),
    CCP_TOKENHUB_API_KEY: 'sk-tokenhub-test-abcdefghijklmnopqrstuvwxyz',
    CCP_TOKENHUB_BASE_URL: `${upstreamUrl}/v1`,
    CCP_LOG_STDERR: '0',
    CCP_MAX_RETRIES: '0',
  };
}

test('TokenHub request preserves native Anthropic fields and model routing', () => {
  const config = {
    tokenhub: { defaultMaxTokens: 131_072 },
  };
  const body = {
    model: 'tokenhub/deepseek-v4-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello', cache_control: { type: 'ephemeral' } }] }],
    system: [{ type: 'text', text: 'system', cache_control: { type: 'ephemeral' } }],
    tools: [{
      name: 'read_file',
      description: 'Read a file',
      input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      cache_control: { type: 'ephemeral' },
    }],
    tool_choice: { type: 'auto' },
    parallel_tool_calls: false,
    thinking: { type: 'enabled', budget_tokens: 4096 },
    output_config: { effort: 'high' },
    context_management: { edits: [] },
    stream: true,
  };
  const translated = translateTokenHubRequest(
    body,
    { provider: 'tokenhub', model: 'deepseek-v4-flash' },
    config,
  );
  assert.equal(translated.model, 'deepseek-v4-flash');
  assert.equal(translated.max_tokens, 131_072);
  assert.equal(translated.stream, true);
  assert.deepEqual(translated.system, body.system);
  assert.deepEqual(translated.messages, body.messages);
  assert.equal(translated.tools[0].cache_control.type, 'ephemeral');
  assert.equal(translated.tool_choice.disable_parallel_tool_use, true);
  assert.equal(translated.thinking.budget_tokens, 4096);
  assert.equal(translated.output_config.effort, 'high');
  assert.equal(translated.context_management, undefined);
});

test('TokenHub endpoint joining accepts standard, Token Plan, and full message URLs', () => {
  assert.equal(
    tokenHubMessagesUrl('https://tokenhub-intl.tencentcloudmaas.com/v1'),
    'https://tokenhub-intl.tencentcloudmaas.com/v1/messages',
  );
  assert.equal(
    tokenHubMessagesUrl('https://tokenhub-intl.tencentcloudmaas.com/plan/anthropic'),
    'https://tokenhub-intl.tencentcloudmaas.com/plan/anthropic/v1/messages',
  );
  assert.equal(
    tokenHubMessagesUrl('https://gateway.example/v1/messages'),
    'https://gateway.example/v1/messages',
  );
});

test('TokenHub provider uses x-api-key and returns native Anthropic SSE frames', async (t) => {
  let observed;
  const upstream = await startHttpServer(async (request, response) => {
    observed = {
      url: request.url,
      headers: request.headers,
      body: await readRequestJson(request),
    };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_th","type":"message","role":"assistant","model":"deepseek-v4-flash","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":7,"output_tokens":0,"cache_read_input_tokens":5,"cache_creation_input_tokens":2}}}\n\n');
    response.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
    response.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"TOKENHUB_OK"}}\n\n');
    response.write('event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n');
    response.write('event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":3}}\n\n');
    response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  t.after(() => upstream.close());

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-tokenhub-'));
  const env = fixtureEnv(root, upstream.url);
  const config = loadConfig({ env });
  const provider = createTokenHubProvider({ config, logger: createLogger(config), env });
  const execution = await provider.execute(
    {
      model: 'tokenhub/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 100,
      stream: true,
    },
    { provider: 'tokenhub', model: 'deepseek-v4-flash' },
    {
      headers: new Headers({
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'hunyuan-beta': 'interleaved-thinking-2025-05-14',
      }),
    },
  );

  const frames = [];
  for await (const frame of execution.nativeAnthropicFrames) frames.push(frame);
  assert.equal(observed.url, '/v1/messages');
  assert.equal(observed.headers['x-api-key'], env.CCP_TOKENHUB_API_KEY);
  assert.equal(observed.headers['anthropic-version'], '2023-06-01');
  assert.equal(observed.headers['anthropic-beta'], 'prompt-caching-2024-07-31');
  assert.equal(observed.headers['hunyuan-beta'], 'interleaved-thinking-2025-05-14');
  assert.equal(observed.headers.authorization, undefined);
  assert.equal(observed.body.model, 'deepseek-v4-flash');
  assert.equal(observed.body.stream, true);
  assert.deepEqual(frames.map((frame) => frame.payload.type), [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
});

test('TokenHub Anthropic stream accumulation preserves tools, thinking, and cache usage', async () => {
  async function* frames() {
    const events = [
      ['message_start', { type: 'message_start', message: { id: 'msg_1', model: 'hy3', usage: { input_tokens: 10, cache_token_usage: 4 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_1', name: 'Read', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"README.md"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    for (const [event, payload] of events) yield { event, data: JSON.stringify(payload), payload };
  }
  const message = await accumulateTokenHubStream(frames(), 'hy3');
  assert.equal(message.id, 'msg_1');
  assert.equal(message.model, 'hy3');
  assert.equal(message.content[0].thinking, 'reason');
  assert.equal(message.content[0].signature, 'sig');
  assert.deepEqual(message.content[1].input, { path: 'README.md' });
  assert.equal(message.stop_reason, 'tool_use');
  assert.equal(message.usage.input_tokens, 10);
  assert.equal(message.usage.cache_read_input_tokens, 4);
  assert.equal(message.usage.output_tokens, 8);
});

test('TokenHub Token Plan base joins the documented Anthropic message path', async (t) => {
  let observedPath;
  const upstream = await startHttpServer(async (request, response) => {
    observedPath = request.url;
    await readRequestJson(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'msg_plan',
      type: 'message',
      role: 'assistant',
      model: 'deepseek-v4-flash-202605',
      content: [{ type: 'text', text: 'PLAN_OK' }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 1 },
    }));
  });
  t.after(() => upstream.close());

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccp-tokenhub-plan-'));
  const env = {
    ...fixtureEnv(root, upstream.url),
    CCP_TOKENHUB_BASE_URL: `${upstream.url}/plan/anthropic`,
  };
  const config = loadConfig({ env });
  const provider = createTokenHubProvider({ config, logger: createLogger(config), env });
  const execution = await provider.execute(
    {
      model: 'tokenhub/deepseek-v4-flash-202605',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32,
      stream: false,
    },
    { provider: 'tokenhub', model: 'deepseek-v4-flash-202605' },
  );
  assert.equal(observedPath, '/plan/anthropic/v1/messages');
  assert.equal(execution.nativeAnthropicMessage.content[0].text, 'PLAN_OK');
});

