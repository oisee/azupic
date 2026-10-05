import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRoute, TOKENHUB_DOCUMENTED_MODELS } from '../src/router.js';

const config = {
  defaultProvider: 'openai',
  aliasProvider: 'moonshot',
  openai: { defaultModel: 'gpt-5.6-sol' },
  moonshot: { defaultModel: 'kimi-k3' },
  tokenhub: { defaultModel: 'deepseek-v4-flash' },
};

test('explicit prefixes are collision-safe', () => {
  assert.deepEqual(resolveRoute('openai/gpt-5.6-sol[1m]', config), {
    provider: 'openai',
    model: 'gpt-5.6-sol',
    requestedModel: 'openai/gpt-5.6-sol[1m]',
    serviceTier: undefined,
  });
  assert.equal(resolveRoute('moonshot/kimi-k3', config).provider, 'moonshot');
  assert.equal(resolveRoute('tokenhub/kimi-k3', config).provider, 'tokenhub');
});

test('bare models use provider families and aliases use aliasProvider', () => {
  assert.equal(resolveRoute('gpt-5.6-luna', config).provider, 'openai');
  assert.equal(resolveRoute('kimi-k3', config).provider, 'moonshot');
  assert.equal(resolveRoute('moonshot-v1-128k', config).model, 'moonshot-v1-128k');
  assert.equal(resolveRoute('deepseek-v4-flash', config).provider, 'tokenhub');
  assert.equal(resolveRoute('glm-5.3', config).provider, 'tokenhub');
  assert.equal(resolveRoute('hy3', config).provider, 'tokenhub');
  assert.equal(resolveRoute('hy-mt2-plus', config).provider, 'tokenhub');
  assert.deepEqual(resolveRoute('claude-opus-4-7', config), {
    provider: 'moonshot',
    model: 'kimi-k3',
    requestedModel: 'claude-opus-4-7',
    serviceTier: undefined,
  });
});

test('OpenAI -fast suffix selects priority service tier', () => {
  const route = resolveRoute('openai/gpt-5.6-sol-fast[1m]', config);
  assert.equal(route.model, 'gpt-5.6-sol');
  assert.equal(route.serviceTier, 'priority');
});


test('documented TokenHub model snapshot includes every routed family', () => {
  for (const model of ['hy3', 'hy-mt2-plus', 'deepseek-v4-flash', 'glm-5.3', 'kimi-k3', 'minimax-m3']) {
    assert.ok(TOKENHUB_DOCUMENTED_MODELS.includes(model));
  }
});

