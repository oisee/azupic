import { ProxyError } from './errors.js';
import { stripContextSuffix } from './util.js';

const CLAUDE_ALIAS = /^(?:claude-|haiku|sonnet|opus)/i;
const TOKENHUB_BARE_MODEL = /^(?:hy(?:3|[-_])|deepseek-|glm-|minimax-)/i;
const PROVIDERS = new Set(['openai', 'moonshot', 'tokenhub']);

// Snapshot of TokenHub models documented as Anthropic Messages-compatible on
// 2026-08-14. Routing is intentionally not restricted to this list because
// TokenHub adds models continuously and exposes live availability via /v1/models.
export const TOKENHUB_DOCUMENTED_MODELS = Object.freeze([
  'hy3',
  'deepseek-v4-flash-202605',
  'deepseek-v4-pro-202606',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'deepseek-v3.2',
  'glm-5.3',
  'glm-5.2',
  'glm-5.1',
  'glm-5v-turbo',
  'glm-5-turbo',
  'glm-5',
  'kimi-k3',
  'kimi-k2.7-code-highspeed',
  'kimi-k2.7-code',
  'kimi-k2.6',
  'kimi-k2.5',
  'minimax-m3',
  'minimax-m2.7',
  'minimax-m2.5',
  'hy-mt2-plus',
]);

/**
 * @param {string} rawModel
 * @param {ReturnType<import('./config.js').loadConfig>} config
 */
export function resolveRoute(rawModel, config) {
  const clean = stripContextSuffix(rawModel);
  let provider;
  let model;
  let serviceTier;

  const explicit = clean.match(/^(openai|moonshot|tokenhub)[/:](.+)$/i);
  if (explicit) {
    provider = explicit[1].toLowerCase();
    model = explicit[2];
  } else if (/^(?:gpt-|o\d|chatgpt-)/i.test(clean)) {
    provider = 'openai';
    model = clean;
  } else if (/^(?:kimi-|moonshot-|k3$|k2(?:\.|-))/i.test(clean)) {
    // Preserve the existing Moonshot bare-model behavior. Use the explicit
    // tokenhub/ prefix when selecting a Kimi model through Tencent Cloud.
    provider = 'moonshot';
    model = clean === 'k3' ? 'kimi-k3' : clean;
  } else if (TOKENHUB_BARE_MODEL.test(clean)) {
    provider = 'tokenhub';
    model = clean;
  } else if (CLAUDE_ALIAS.test(clean)) {
    provider = config.aliasProvider;
    model = providerDefaultModel(config, provider);
  } else {
    provider = config.defaultProvider;
    model = clean || providerDefaultModel(config, provider);
  }

  if (!PROVIDERS.has(provider)) {
    throw new ProxyError(`Unknown provider ${JSON.stringify(provider)}`, { status: 400 });
  }

  if (provider === 'openai' && /-fast$/i.test(model)) {
    model = model.replace(/-fast$/i, '');
    serviceTier = 'priority';
  }

  if (!model) throw new ProxyError('Could not resolve an upstream model', { status: 400 });
  return {
    provider,
    model,
    requestedModel: rawModel,
    serviceTier,
  };
}

function providerDefaultModel(config, provider) {
  const model = config[provider]?.defaultModel;
  if (!model) throw new ProxyError(`No default model is configured for ${provider}`, { status: 400 });
  return model;
}

export function modelCatalog(config) {
  return [
    {
      provider: 'openai',
      route: `openai/${config.openai.defaultModel}`,
      upstreamModel: config.openai.defaultModel,
      auth: 'CCP_OPENAI_API_KEY or OPENAI_API_KEY',
      protocol: 'OpenAI Responses API',
    },
    {
      provider: 'moonshot',
      route: `moonshot/${config.moonshot.defaultModel}`,
      upstreamModel: config.moonshot.defaultModel,
      auth: 'CCP_MOONSHOT_API_KEY or MOONSHOT_API_KEY',
      protocol: 'OpenAI-compatible Chat Completions',
    },
    {
      provider: 'tokenhub',
      route: `tokenhub/${config.tokenhub.defaultModel}`,
      upstreamModel: config.tokenhub.defaultModel,
      auth: 'CCP_TOKENHUB_API_KEY or TOKENHUB_API_KEY',
      protocol: 'Tencent Cloud TokenHub Anthropic Messages',
    },
  ];
}

