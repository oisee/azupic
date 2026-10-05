import assert from 'node:assert/strict';
import fs from 'node:fs';
import { translateOpenAIRequest, normalizeOpenAIResponseStream, normalizeOpenAIResponseJson } from '../reference/dywongcloud-claude-code-proxy/src/providers/openai.js';
import { accumulateAnthropicMessage } from '../reference/dywongcloud-claude-code-proxy/src/anthropic.js';
import { parseSse } from '../reference/dywongcloud-claude-code-proxy/src/sse.js';
import { normalizeUsageFromOpenAi } from '../reference/dywongcloud-claude-code-proxy/src/providers/common.js';

// Offline observations of the unmodified reference, not acceptance tests for our Go implementation.
const model = 'gpt-6.1-sol';
const config = { openai: { reasoningEffort: 'high', reasoningSummary: 'auto', store: false, encryptedReasoning: true } };
const route = { model };
const collect = async (it) => { const out = []; for await (const x of it) out.push(x); return out; };
const stream = (chunks) => new ReadableStream({ start(controller) { for (const c of chunks) controller.enqueue(new TextEncoder().encode(c)); controller.close(); } });
const observations = {};

const request = {
  model: 'opus', max_tokens: 4096, stream: true,
  system: [{ type: 'text', text: 'Inspect files before editing.', cache_control: { type: 'ephemeral' } }],
  messages: [{ role: 'user', content: 'Read /tmp/example.txt and explain it.' }],
  tools: [{ name: 'Read', description: 'Read a local file', input_schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
  tool_choice: { type: 'auto', disable_parallel_tool_use: true },
  output_config: { effort: 'high' },
};
const output = [
  { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'I will inspect the file.' }], encrypted_content: 'synthetic-opaque-state' },
  { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'Read', arguments: '{"file_path":"/tmp/example.txt"}' },
];
const events = [
  { type: 'response.created', response: { id: 'resp_1', model } },
  { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', delta: 'I will inspect the file.' },
  { type: 'response.output_item.done', item: output[0] },
  { type: 'response.output_item.added', item: { ...output[1], arguments: '' } },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"file_path":' },
  { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"/tmp/example.txt"}' },
  { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: output[1].arguments },
  { type: 'response.output_item.done', item: output[1] },
  { type: 'response.completed', response: { id: 'resp_1', model, status: 'completed', output, usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 10 } } } },
];
const wire = events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const normalized = await collect(normalizeOpenAIResponseStream(stream([wire]), { maxBytes: 100000, idleTimeoutMs: 1000, model }));
const response = await accumulateAnthropicMessage((async function* () { yield* normalized; })(), { requestModel: 'opus', responseModel: model });
const followUp = { ...request, messages: [...request.messages, { role: 'assistant', content: response.content }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'Example file contents.' }] }] };
const upstreamFollowUp = translateOpenAIRequest(followUp, route, config);
assert.equal(response.content[1].id, 'call_1');
assert.equal(response.stop_reason, 'tool_use');
assert.equal(upstreamFollowUp.input[1].encrypted_content, 'synthetic-opaque-state');
assert.equal(upstreamFollowUp.input[2].call_id, upstreamFollowUp.input[3].call_id);

observations.nativeServerTool = translateOpenAIRequest({ ...request, tools: [{ type: 'web_search_20250305', name: 'web_search' }] }, route, config).tools;
observations.ignoredFields = translateOpenAIRequest({ ...request, temperature: 0.2, top_p: 0.5, stop_sequences: ['STOP'], thinking: { type: 'enabled', budget_tokens: 1024 }, context_management: { edits: [] } }, route, config);
observations.thinkingDisabledReasoning = translateOpenAIRequest({ ...request, thinking: { type: 'disabled' } }, route, config).reasoning ?? null;
const malformed = await accumulateAnthropicMessage(normalizeOpenAIResponseJson({ status: 'completed', output: [{ ...output[1], arguments: '{broken' }] }, { model }), { requestModel: 'opus' });
observations.malformedArguments = malformed.content[0].input;
observations.usage = normalizeUsageFromOpenAi({ input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 60 }, output_tokens_details: { reasoning_tokens: 10 } });
observations.urlWithQuery = `${new URL('https://example.openai.azure.com/openai?api-version=2025-04-01-preview').toString()}/responses`;
const crlf = 'event: demo\r\ndata: {"x":1}\r\n\r\n';
observations.crlfSingleChunk = await collect(parseSse(stream([crlf]), { idleTimeoutMs: 1000 }));
observations.crlfSplitAfterCR = await collect(parseSse(stream(['event: demo\r', '\ndata: {"x":1}\r\n\r\n']), { idleTimeoutMs: 1000 }));
observations.unknownOutputItem = await collect(normalizeOpenAIResponseJson({ status: 'completed', output: [{ id: 'hosted_1', type: 'web_search_call', status: 'completed' }] }, { model }));

fs.mkdirSync(new URL('../docs/fixtures/', import.meta.url), { recursive: true });
fs.writeFileSync(new URL('../docs/fixtures/messages-responses-tool-cycle.json', import.meta.url), JSON.stringify({ provenance: 'Synthetic offline fixture generated by reference implementation', request, upstreamRequest: translateOpenAIRequest(request, route, config), upstreamEvents: events, normalizedEvents: normalized, response, followUp, upstreamFollowUp }, null, 2) + '\n');
fs.writeFileSync(new URL('../docs/fixtures/reference-observations.json', import.meta.url), JSON.stringify(observations, null, 2) + '\n');
console.log(JSON.stringify({ toolCycle: 'passed', malformedArguments: observations.malformedArguments, usage: observations.usage, crlfSingle: observations.crlfSingleChunk, crlfSplit: observations.crlfSplitAfterCR, nativeServerTool: observations.nativeServerTool, thinkingDisabledReasoning: observations.thinkingDisabledReasoning }, null, 2));
