import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicEventEncoder, accumulateAnthropicMessage } from '../src/anthropic.js';
import { estimateAnthropicTokens } from '../src/tokens.js';

async function* sampleEvents() {
  yield { type: 'block_start', key: 'text:0', kind: 'text' };
  yield { type: 'block_delta', key: 'text:0', deltaType: 'text', delta: 'hello' };
  yield { type: 'block_stop', key: 'text:0' };
  yield { type: 'usage', usage: { input_tokens: 11, output_tokens: 2 } };
  yield { type: 'message_done', stopReason: 'end_turn' };
}

test('normalized events produce a valid non-streaming Anthropic message', async () => {
  const message = await accumulateAnthropicMessage(sampleEvents(), {
    requestModel: 'openai/gpt-5.6-sol',
    responseModel: 'gpt-5.6-sol',
  });
  assert.equal(message.type, 'message');
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }]);
  assert.equal(message.usage.input_tokens, 11);
  assert.equal(message.stop_reason, 'end_turn');
});

test('stream encoder emits Anthropic message lifecycle', () => {
  const encoder = new AnthropicEventEncoder({ requestModel: 'x' });
  const frames = [
    ...encoder.start(),
    ...encoder.apply({ type: 'block_start', key: 'text:0', kind: 'text' }),
    ...encoder.apply({ type: 'block_delta', key: 'text:0', deltaType: 'text', delta: 'ok' }),
    ...encoder.apply({ type: 'message_done', stopReason: 'end_turn' }),
  ].join('');
  assert.match(frames, /event: message_start/);
  assert.match(frames, /event: content_block_delta/);
  assert.match(frames, /event: message_stop/);
  const thinkingEncoder = new AnthropicEventEncoder({ requestModel: 'x', messageId: 'msg_1' });
  const thinkingFrames = [
    ...thinkingEncoder.start(),
    ...thinkingEncoder.apply({ type: 'block_start', key: 'thinking:0', kind: 'thinking' }),
    ...thinkingEncoder.apply({ type: 'block_delta', key: 'thinking:0', deltaType: 'thinking', delta: 'hmm' }),
    ...thinkingEncoder.apply({ type: 'block_stop', key: 'thinking:0' }),
  ].join('');
  assert.match(thinkingFrames, /signature_delta/);
  assert.match(thinkingFrames, /Y2NwOmFwaS1rZXk6djE6bXNnXzE6MA/);

  const opaqueEncoder = new AnthropicEventEncoder({ requestModel: 'x', messageId: 'msg_2' });
  const opaqueFrames = [
    ...opaqueEncoder.start(),
    ...opaqueEncoder.apply({ type: 'block_start', key: 'thinking:1', kind: 'thinking' }),
    ...opaqueEncoder.apply({ type: 'block_stop', key: 'thinking:1', signature: 'opaque-provider-state' }),
  ].join('');
  assert.match(opaqueFrames, /opaque-provider-state/);
  assert.equal(opaqueEncoder.toMessage().content[0].signature, 'opaque-provider-state');
});

test('token estimator handles English, CJK, tools and images', () => {
  const small = estimateAnthropicTokens({ messages: [{ role: 'user', content: 'hello world' }] });
  const rich = estimateAnthropicTokens({
    system: '系统',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello world 你好世界' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'a'.repeat(5000) } },
        ],
      },
    ],
    tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }],
  });
  assert.ok(rich > small + 100);
});

