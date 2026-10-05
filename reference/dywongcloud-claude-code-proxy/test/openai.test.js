import assert from 'node:assert/strict';
import test from 'node:test';
import {
  translateOpenAIRequest,
  normalizeOpenAIResponseJson,
  normalizeOpenAIResponseStream,
} from '../src/providers/openai.js';
import { accumulateAnthropicMessage } from '../src/anthropic.js';
import { collect, streamFromText } from './helpers.js';

const config = {
  openai: {
    reasoningEffort: 'high',
    reasoningSummary: 'auto',
    serviceTier: 'auto',
    store: false,
    encryptedReasoning: true,
  },
};

test('Anthropic request translates to public OpenAI Responses API', () => {
  const body = {
    model: 'openai/gpt-5.6-sol',
    max_tokens: 4096,
    system: [{ type: 'text', text: 'Be precise.' }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'YWJj' } },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/a' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello' }],
      },
    ],
    tools: [{ name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: {} } }],
    tool_choice: { type: 'auto', disable_parallel_tool_use: true },
    output_config: { effort: 'max' },
  };
  const headers = new Headers({ 'x-claude-code-session-id': 'session-123' });
  const payload = translateOpenAIRequest(
    body,
    { model: 'gpt-5.6-sol', serviceTier: undefined },
    config,
    headers,
  );
  assert.equal(payload.model, 'gpt-5.6-sol');
  assert.equal(payload.instructions, 'Be precise.');
  assert.equal(payload.reasoning.effort, 'max');
  assert.equal(payload.prompt_cache_key, 'session-123');
  assert.equal(payload.parallel_tool_calls, false);
  assert.deepEqual(payload.include, ['reasoning.encrypted_content']);
  assert.equal(payload.tools[0].name, 'Read');
  assert.ok(payload.input.some((item) => item.type === 'function_call'));
  assert.ok(payload.input.some((item) => item.type === 'function_call_output'));
  assert.match(JSON.stringify(payload.input), /data:image\/png;base64,YWJj/);
  assert.equal(payload.stop, undefined);
});



test('non-streaming OpenAI Responses JSON is normalized as a gateway fallback', async () => {
  const normalized = await collect(
    normalizeOpenAIResponseJson({
      id: 'resp_json',
      status: 'completed',
      output: [
        { id: 'r', type: 'reasoning', summary: [{ type: 'summary_text', text: 'summary' }] },
        { id: 'm', type: 'message', content: [{ type: 'output_text', text: 'answer' }] },
        { id: 'f', type: 'function_call', call_id: 'call_json', name: 'Read', arguments: '{"path":"a"}' },
      ],
      usage: { input_tokens: 9, output_tokens: 4 },
    }),
  );
  assert.ok(normalized.some((event) => event.type === 'block_delta' && event.delta === 'summary'));
  assert.ok(normalized.some((event) => event.type === 'block_delta' && event.delta === 'answer'));
  assert.ok(normalized.some((event) => event.type === 'block_start' && event.name === 'Read'));
  assert.equal(normalized.at(-1).stopReason, 'tool_use');
});

test('encrypted OpenAI reasoning round-trips through an Anthropic thinking signature', async () => {
  const response = {
    id: 'resp_reasoning',
    model: 'gpt-5.6-sol',
    status: 'completed',
    output: [
      {
        id: 'rs_1',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'inspect the file' }],
        encrypted_content: 'opaque-encrypted-reasoning',
      },
      {
        id: 'fc_1',
        type: 'function_call',
        call_id: 'call_1',
        name: 'Read',
        arguments: '{"path":"a"}',
      },
    ],
    usage: { input_tokens: 8, output_tokens: 3 },
  };
  const events = await collect(normalizeOpenAIResponseJson(response, { model: 'gpt-5.6-sol' }));
  const signatureEvent = events.find((event) => event.type === 'block_stop' && event.signature);
  assert.match(signatureEvent.signature, /^ccp:openai:v1:/);

  const message = await accumulateAnthropicMessage(
    (async function* () {
      yield* events;
    })(),
    { requestModel: 'openai/gpt-5.6-sol', responseModel: 'gpt-5.6-sol' },
  );
  const thinking = message.content.find((block) => block.type === 'thinking');
  assert.equal(thinking.signature, signatureEvent.signature);

  const followUp = translateOpenAIRequest(
    {
      model: 'openai/gpt-5.6-sol',
      messages: [
        { role: 'assistant', content: message.content },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'file contents' }] },
      ],
    },
    { model: 'gpt-5.6-sol' },
    config,
  );
  const reasoningIndex = followUp.input.findIndex((item) => item.type === 'reasoning');
  const callIndex = followUp.input.findIndex((item) => item.type === 'function_call');
  assert.ok(reasoningIndex >= 0 && reasoningIndex < callIndex);
  assert.equal(followUp.input[reasoningIndex].encrypted_content, 'opaque-encrypted-reasoning');

  const switchedModel = translateOpenAIRequest(
    { model: 'openai/gpt-5.6-mini', messages: [{ role: 'assistant', content: message.content }] },
    { model: 'gpt-5.6-mini' },
    config,
  );
  assert.equal(switchedModel.input.some((item) => item.type === 'reasoning'), false);
});

test('OpenAI SSE is normalized into thinking, text, tool and usage events', async () => {
  const events = [
    { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.6-sol' } },
    { type: 'response.reasoning_summary_text.delta', item_id: 'r1', summary_index: 0, delta: 'Think' },
    { type: 'response.reasoning_summary_text.done', item_id: 'r1', summary_index: 0 },
    {
      type: 'response.output_item.done',
      item: {
        id: 'r1',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'Think' }],
        encrypted_content: 'opaque-stream-state',
      },
    },
    { type: 'response.output_text.delta', item_id: 'm1', content_index: 0, delta: 'Hello' },
    { type: 'response.output_text.done', item_id: 'm1', content_index: 0 },
    { type: 'response.output_item.added', item: { id: 'fc1', type: 'function_call', call_id: 'call1', name: 'Read' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"file_' },
    { type: 'response.function_call_arguments.done', item_id: 'fc1', arguments: '{"file_path":"a"}' },
    {
      type: 'response.completed',
      response: { usage: { input_tokens: 10, output_tokens: 7, input_tokens_details: { cached_tokens: 4 } } },
    },
  ];
  const wire = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  const normalized = await collect(
    normalizeOpenAIResponseStream(streamFromText(wire), {
      maxBytes: 1024 * 1024,
      idleTimeoutMs: 1000,
      model: 'gpt-5.6-sol',
    }),
  );
  assert.ok(normalized.some((event) => event.type === 'block_delta' && event.deltaType === 'thinking'));
  assert.ok(normalized.some((event) => event.type === 'block_delta' && event.deltaType === 'text'));
  assert.ok(normalized.some((event) => event.type === 'block_start' && event.kind === 'tool'));
  assert.ok(
    normalized.some(
      (event) => event.type === 'block_stop' && event.signature?.startsWith('ccp:openai:v1:'),
    ),
  );
  assert.deepEqual(normalized.find((event) => event.type === 'usage').usage, {
    input_tokens: 10,
    output_tokens: 7,
    cache_read_input_tokens: 4,
    cache_creation_input_tokens: 0,
  });
  assert.equal(normalized.at(-1).stopReason, 'tool_use');
});

test('OpenAI tool arguments are buffered until a missing function name arrives', async () => {
  const events = [
    { type: 'response.function_call_arguments.delta', item_id: 'fc_late', delta: '{"path":' },
    { type: 'response.function_call_arguments.done', item_id: 'fc_late', arguments: '{"path":"a"}' },
    {
      type: 'response.output_item.done',
      item: {
        id: 'fc_late',
        type: 'function_call',
        call_id: 'call_late',
        name: 'Read',
        arguments: '{"path":"a"}',
      },
    },
    { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 1 } } },
  ];
  const wire = events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const normalized = await collect(
    normalizeOpenAIResponseStream(streamFromText(wire), {
      maxBytes: 1024 * 1024,
      idleTimeoutMs: 1000,
      model: 'gpt-5.6-sol',
    }),
  );
  const toolStartIndex = normalized.findIndex((event) => event.type === 'block_start' && event.kind === 'tool');
  const toolDeltaIndex = normalized.findIndex((event) => event.type === 'block_delta' && event.deltaType === 'json');
  assert.ok(toolStartIndex >= 0 && toolStartIndex < toolDeltaIndex);
  assert.equal(normalized[toolStartIndex].name, 'Read');
  assert.equal(normalized[toolDeltaIndex].delta, '{"path":"a"}');
});


test('OpenAI Responses stream rejects termination without a terminal response event', async () => {
  const wire = [
    `event: response.output_text.delta\ndata: ${JSON.stringify({ type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'partial' })}\n\n`,
    'data: [DONE]\n\n',
  ].join('');
  await assert.rejects(
    () =>
      collect(
        normalizeOpenAIResponseStream(streamFromText(wire), {
          maxBytes: 1024 * 1024,
          idleTimeoutMs: 1000,
          model: 'gpt-5.6-sol',
        }),
      ),
    /before a terminal response event/,
  );
});

