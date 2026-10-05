import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeMoonshotJson,
  normalizeMoonshotStream,
  translateMoonshotRequest,
} from '../src/providers/moonshot.js';
import { collect, streamFromText } from './helpers.js';

const config = {
  moonshot: {
    reasoningEffort: 'max',
    mergeSystemIntoUserForK3: false,
  },
};

test('Kimi K3 request uses Moonshot Chat Completions and preserves the public system role', () => {
  const payload = translateMoonshotRequest(
    {
      model: 'moonshot/kimi-k3',
      max_tokens: 9999999,
      system: 'Use tools carefully.',
      messages: [{ role: 'user', content: 'hello' }],
      output_config: { effort: 'max' },
      tools: [{ name: 'Bash', input_schema: { type: 'object', properties: {} } }],
    },
    { model: 'kimi-k3' },
    config,
  );
  assert.equal(payload.model, 'kimi-k3');
  assert.equal(payload.reasoning_effort, 'max');
  assert.equal(payload.max_completion_tokens, 1_048_576);
  assert.equal(payload.messages[0].role, 'system');
  assert.equal(payload.messages[0].content, 'Use tools carefully.');
  assert.equal(payload.tools[0].function.name, 'Bash');
});




test('K3 system merge remains available for stricter compatible gateways', () => {
  const payload = translateMoonshotRequest(
    {
      model: 'moonshot/kimi-k3',
      max_tokens: 100,
      system: 'Use tools carefully.',
      messages: [{ role: 'user', content: 'hello' }],
    },
    { model: 'kimi-k3' },
    { moonshot: { ...config.moonshot, mergeSystemIntoUserForK3: true } },
  );
  assert.ok(!payload.messages.some((message) => message.role === 'system'));
  assert.match(payload.messages[0].content, /System instructions:/);
});

test('Moonshot K3 rejects public image URLs instead of proxy-fetching them', () => {
  assert.throws(
    () =>
      translateMoonshotRequest(
        {
          model: 'kimi-k3',
          max_tokens: 100,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } },
              ],
            },
          ],
        },
        { model: 'kimi-k3' },
        config,
      ),
    /allowed protocols: data:, ms:/,
  );
});

test('thinking disabled requests low K3 effort and suppresses visible reasoning downstream', () => {
  const payload = translateMoonshotRequest(
    {
      model: 'kimi-k3',
      max_tokens: 100,
      thinking: { type: 'disabled' },
      stop_sequences: ['STOP'],
      messages: [{ role: 'user', content: 'hello' }],
    },
    { model: 'kimi-k3' },
    config,
  );
  assert.equal(payload.reasoning_effort, 'low');
  assert.deepEqual(payload.stop, ['STOP']);
});





test('non-streaming Moonshot Chat JSON is normalized as a gateway fallback', async () => {
  const normalized = await collect(
    normalizeMoonshotJson({
      choices: [
        {
          message: {
            reasoning_content: 'reason',
            content: 'answer',
            tool_calls: [
              { id: 'call_json', type: 'function', function: { name: 'Bash', arguments: '{"command":"pwd"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 4, completion_tokens: 3 },
    }),
  );
  assert.ok(normalized.some((event) => event.type === 'block_delta' && event.delta === 'reason'));
  assert.ok(normalized.some((event) => event.type === 'block_delta' && event.delta === 'answer'));
  assert.ok(normalized.some((event) => event.type === 'block_start' && event.name === 'Bash'));
  assert.equal(normalized.at(-1).stopReason, 'tool_use');
});

test('fragmented Moonshot function names are complete before tool block start', async () => {
  const chunks = [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_2', function: { name: 'Web', arguments: '' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: 'Search', arguments: '' } }] }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":"x"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } },
  ];
  const wire = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  const normalized = await collect(
    normalizeMoonshotStream(streamFromText(wire), {
      maxBytes: 1024 * 1024,
      idleTimeoutMs: 1000,
      emitThinking: true,
    }),
  );
  const start = normalized.find((event) => event.type === 'block_start' && event.kind === 'tool');
  assert.equal(start.name, 'WebSearch');
});

test('Moonshot stream preserves final usage chunk after finish_reason', async () => {
  const chunks = [
    { id: 'x', choices: [{ index: 0, delta: { reasoning_content: 'think ' }, finish_reason: null }] },
    { id: 'x', choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] },
    {
      id: 'x',
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Bash', arguments: '{"command":"pwd"}' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    },
    { id: 'x', choices: [], usage: { prompt_tokens: 12, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 5 } } },
  ];
  const wire = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
  const normalized = await collect(
    normalizeMoonshotStream(streamFromText(wire), {
      maxBytes: 1024 * 1024,
      idleTimeoutMs: 1000,
      emitThinking: true,
    }),
  );
  assert.ok(normalized.some((event) => event.type === 'block_delta' && event.deltaType === 'thinking'));
  assert.ok(normalized.some((event) => event.type === 'block_delta' && event.deltaType === 'text'));
  assert.ok(normalized.some((event) => event.type === 'block_start' && event.kind === 'tool'));
  assert.deepEqual(normalized.find((event) => event.type === 'usage').usage, {
    input_tokens: 12,
    output_tokens: 8,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: 0,
  });
  assert.equal(normalized.at(-1).type, 'message_done');
  assert.equal(normalized.at(-1).stopReason, 'tool_use');
});


test('Moonshot stream rejects clean EOF without finish_reason', async () => {
  const wire = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] })}

data: [DONE]

`;
  await assert.rejects(
    () =>
      collect(
        normalizeMoonshotStream(streamFromText(wire), {
          maxBytes: 1024 * 1024,
          idleTimeoutMs: 1000,
          emitThinking: true,
        }),
      ),
    /before a finish_reason/,
  );
});

