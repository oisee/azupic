import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeInlineInstructionMessages,
  validateAnthropicRequest,
} from '../src/anthropic.js';

test('Claude Code inline system messages are hoisted into top-level system instructions', () => {
  const normalized = validateAnthropicRequest({
    model: 'openai/gpt-5.6-sol',
    max_tokens: 128,
    system: [{ type: 'text', text: 'Base instructions.', cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: 'Do the task.' },
      {
        role: 'system',
        content: [
          { type: 'text', text: 'Inline agent context.' },
          { type: 'text', text: 'Current date: 2026-08-20.' },
        ],
      },
      { role: 'assistant', content: 'Working.' },
      { role: 'user', content: 'Continue.' },
    ],
  });

  assert.deepEqual(
    normalized.messages.map((message) => message.role),
    ['user', 'assistant', 'user'],
  );
  assert.deepEqual(normalized.system, [
    { type: 'text', text: 'Base instructions.', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'Inline agent context.\nCurrent date: 2026-08-20.' },
  ]);
});

test('developer messages use the same safe instruction normalization', () => {
  const body = {
    model: 'moonshot/kimi-k3',
    messages: [
      { role: 'developer', content: 'Use the project conventions.' },
      { role: 'user', content: 'Inspect the repository.' },
    ],
  };
  const normalized = normalizeInlineInstructionMessages(body);
  assert.equal(normalized.system, 'Use the project conventions.');
  assert.deepEqual(normalized.messages, [{ role: 'user', content: 'Inspect the repository.' }]);
});

test('unknown message roles still fail closed', () => {
  assert.throws(
    () =>
      validateAnthropicRequest({
        model: 'openai/gpt-5.6-sol',
        messages: [{ role: 'tool', content: 'not Anthropic wire format' }],
      }),
    /must be "user", "assistant", "system", or "developer"/,
  );
});

test('native Anthropic server tools may omit input_schema', () => {
  const body = validateAnthropicRequest({
    model: 'tokenhub/deepseek-v4-flash',
    messages: [{ role: 'user', content: 'Search for the latest release.' }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
  });
  assert.deepEqual(body.tools, [
    { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
  ]);

  assert.throws(
    () => validateAnthropicRequest({
      model: 'tokenhub/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ name: 'invalid_tool' }],
    }),
    /must provide input_schema or a versioned server-tool type/,
  );
});

