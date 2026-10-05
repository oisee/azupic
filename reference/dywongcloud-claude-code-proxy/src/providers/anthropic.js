import { resolveApiKey } from '../auth-store.js';
import { ProxyError, parseUpstreamError } from '../errors.js';
import { postJsonWithRetry, readJsonResponse } from '../http.js';
import { parseSse, parseSseJson } from '../sse.js';
import { compactObject } from '../util.js';
import { VERSION } from '../version.js';

/**
 * Tencent Cloud TokenHub speaks Anthropic Messages natively. This provider
 * intentionally keeps that protocol intact instead of translating through
 * Chat Completions, preserving tool blocks, thinking signatures, cache usage,
 * and provider-specific Anthropic extensions.
 *
 * @param {{config:ReturnType<import('../config.js').loadConfig>, logger:ReturnType<import('../logging.js').createLogger>, env?:NodeJS.ProcessEnv|Record<string,string|undefined>}} options
 */
export function createTokenHubProvider(options) {
  const env = options.env ?? process.env;
  return {
    name: 'tokenhub',
    async execute(body, route, context = {}) {
      const credential = resolveApiKey('tokenhub', options.config, env);
      if (!credential) {
        throw new ProxyError(
          'Tencent Cloud TokenHub API key is not configured. Set CCP_TOKENHUB_API_KEY or ' +
            'TOKENHUB_API_KEY, or run: claude-code-proxy tokenhub auth login',
          { status: 401, type: 'authentication_error' },
        );
      }

      const payload = translateTokenHubRequest(body, route, options.config);
      const headers = tokenHubHeaders(credential.key, options.config, context.headers);
      const providerConfig = {
        ...options.config,
        requestTimeoutMs: options.config.tokenhub.requestTimeoutMs,
        streamIdleTimeoutMs: options.config.tokenhub.streamIdleTimeoutMs,
      };
      const response = await postJsonWithRetry({
        url: tokenHubMessagesUrl(options.config.tokenhub.baseUrl),
        headers,
        body: payload,
        config: providerConfig,
        logger: options.logger,
        signal: context.signal,
        provider: 'tokenhub',
      });
      if (!response.body) throw new ProxyError('TokenHub returned an empty response body', { status: 502 });

      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('text/event-stream')) {
        const frames = tokenHubFrames(response.body, {
          maxBytes: options.config.maxResponseBytes,
          idleTimeoutMs: options.config.tokenhub.streamIdleTimeoutMs,
          signal: context.signal,
        });
        if (body.stream === true) {
          return {
            upstreamModel: route.model,
            requestPayload: payload,
            nativeAnthropicFrames: frames,
          };
        }
        return {
          upstreamModel: route.model,
          requestPayload: payload,
          nativeAnthropicMessage: await accumulateTokenHubStream(frames, route.model),
        };
      }

      const message = await readJsonResponse(response, options.config.maxResponseBytes, {
        idleTimeoutMs: options.config.tokenhub.streamIdleTimeoutMs,
        signal: context.signal,
      });
      assertTokenHubMessage(message);
      return {
        upstreamModel: route.model,
        requestPayload: payload,
        nativeAnthropicMessage: message,
      };
    },
  };
}

/**
 * Standard TokenHub bases end in /v1. Token Plan's Anthropic base is
 * documented without that suffix, so accept both forms rather than requiring
 * users to understand how this proxy joins endpoint paths.
 *
 * @param {string} baseUrl
 */
export function tokenHubMessagesUrl(baseUrl) {
  const base = String(baseUrl).replace(/\/+$/, '');
  if (/\/messages$/i.test(base)) return base;
  if (/\/plan\/anthropic$/i.test(base)) return `${base}/v1/messages`;
  return `${base}/messages`;
}

/**
 * Keep only fields TokenHub documents for its Anthropic-compatible endpoint.
 * Nested cache_control and provider-specific content blocks remain untouched.
 *
 * @param {any} body
 * @param {ReturnType<import('../router.js').resolveRoute>} route
 * @param {ReturnType<import('../config.js').loadConfig>} config
 */
export function translateTokenHubRequest(body, route, config) {
  const toolChoice = normalizeToolChoice(body.tool_choice, body.parallel_tool_calls);
  return compactObject({
    model: route.model,
    messages: cloneJson(body.messages ?? []),
    system: cloneJson(body.system),
    max_tokens: body.max_tokens ?? config.tokenhub.defaultMaxTokens,
    stream: body.stream === true,
    temperature: body.temperature,
    top_p: body.top_p,
    top_k: body.top_k,
    stop_sequences: cloneJson(body.stop_sequences),
    tools: cloneJson(body.tools),
    tool_choice: toolChoice,
    metadata: cloneJson(body.metadata),
    thinking: cloneJson(body.thinking),
    output_config: cloneJson(body.output_config),
    service_tier: body.service_tier,
  });
}

function normalizeToolChoice(value, parallelToolCalls) {
  let choice = cloneJson(value);
  if (typeof parallelToolCalls !== 'boolean') return choice;
  if (choice == null) choice = { type: 'auto' };
  if (typeof choice === 'string') choice = { type: choice };
  if (choice && typeof choice === 'object' && !Array.isArray(choice)) {
    if (choice.disable_parallel_tool_use == null) {
      choice.disable_parallel_tool_use = !parallelToolCalls;
    }
  }
  return choice;
}

function tokenHubHeaders(apiKey, config, inboundHeaders) {
  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': inboundHeaders?.get?.('anthropic-version') || config.tokenhub.anthropicVersion,
    'content-type': 'application/json',
    accept: 'text/event-stream, application/json',
    'user-agent': `claude-code-proxy-openai-moonshot-tokenhub/${VERSION}`,
  };
  const anthropicBeta = inboundHeaders?.get?.('anthropic-beta');
  const hunyuanBeta = inboundHeaders?.get?.('hunyuan-beta') || config.tokenhub.hunyuanBeta;
  if (anthropicBeta) headers['anthropic-beta'] = sanitizeHeader(anthropicBeta);
  if (hunyuanBeta) headers['hunyuan-beta'] = sanitizeHeader(hunyuanBeta);
  return headers;
}

async function* tokenHubFrames(stream, options) {
  for await (const frame of parseSse(stream, options)) {
    if (frame.data === '[DONE]') continue;
    const payload = parseSseJson(frame.data, 'TokenHub Anthropic stream');
    if (payload?.type === 'error' || frame.event === 'error') {
      // Keep stream errors in-band for streaming callers. Non-streaming
      // accumulation throws the same error below.
      yield { ...frame, payload };
      continue;
    }
    yield { ...frame, payload };
  }
}

/**
 * Reconstruct an Anthropic message when an upstream unexpectedly streams for
 * a non-streaming request. This also makes the provider resilient to gateways
 * configured to force SSE globally.
 */
export async function accumulateTokenHubStream(frames, fallbackModel) {
  const message = {
    id: undefined,
    type: 'message',
    role: 'assistant',
    model: fallbackModel,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: emptyUsage(),
  };
  const partialJson = new Map();
  let terminal = false;

  for await (const frame of frames) {
    const payload = frame.payload ?? parseSseJson(frame.data, 'TokenHub Anthropic stream');
    const kind = payload?.type ?? frame.event;
    if (kind === 'error') throw tokenHubStreamError(payload);
    if (kind === 'message_start') {
      const start = payload.message ?? {};
      message.id = start.id ?? message.id;
      message.model = start.model ?? message.model;
      message.role = start.role ?? message.role;
      mergeUsage(message.usage, start.usage);
      continue;
    }
    if (kind === 'content_block_start') {
      const index = integer(payload.index);
      message.content[index] = cloneJson(payload.content_block) ?? { type: 'text', text: '' };
      if (message.content[index]?.type === 'tool_use') {
        partialJson.set(index, '');
        message.content[index].input = {};
      }
      continue;
    }
    if (kind === 'content_block_delta') {
      applyNativeDelta(message.content, partialJson, integer(payload.index), payload.delta);
      continue;
    }
    if (kind === 'content_block_stop') {
      finishNativeBlock(message.content, partialJson, integer(payload.index));
      continue;
    }
    if (kind === 'message_delta') {
      message.stop_reason = payload.delta?.stop_reason ?? message.stop_reason;
      message.stop_sequence = payload.delta?.stop_sequence ?? message.stop_sequence;
      mergeUsage(message.usage, payload.usage);
      continue;
    }
    if (kind === 'message_stop') terminal = true;
  }

  for (const index of partialJson.keys()) finishNativeBlock(message.content, partialJson, index);
  message.content = message.content.filter((block) => block != null);
  if (!terminal) {
    throw new ProxyError('TokenHub Anthropic stream ended before message_stop', {
      status: 502,
      type: 'api_error',
    });
  }
  if (!message.id) message.id = `msg_tokenhub_${Date.now().toString(36)}`;
  if (!message.stop_reason) message.stop_reason = inferStopReason(message.content);
  return message;
}

function applyNativeDelta(content, partialJson, index, delta) {
  const block = content[index];
  if (!block || !delta) return;
  if (delta.type === 'text_delta') block.text = `${block.text ?? ''}${delta.text ?? ''}`;
  else if (delta.type === 'thinking_delta') block.thinking = `${block.thinking ?? ''}${delta.thinking ?? ''}`;
  else if (delta.type === 'signature_delta') block.signature = `${block.signature ?? ''}${delta.signature ?? ''}`;
  else if (delta.type === 'input_json_delta') {
    partialJson.set(index, `${partialJson.get(index) ?? ''}${delta.partial_json ?? ''}`);
  } else {
    // Preserve future/extension deltas rather than silently discarding them.
    if (!Array.isArray(block._tokenhub_deltas)) block._tokenhub_deltas = [];
    block._tokenhub_deltas.push(cloneJson(delta));
  }
}

function finishNativeBlock(content, partialJson, index) {
  const block = content[index];
  if (!block || block.type !== 'tool_use') return;
  const raw = partialJson.get(index) ?? '';
  partialJson.delete(index);
  if (!raw.trim()) return;
  try {
    block.input = JSON.parse(raw);
  } catch {
    block.input = { _raw: raw };
  }
}

function assertTokenHubMessage(payload) {
  if (payload?.type === 'error' || payload?.error) {
    throw parseUpstreamError(JSON.stringify(payload), Number(payload?.status ?? 502));
  }
  if (!payload || typeof payload !== 'object' || payload.type !== 'message' || !Array.isArray(payload.content)) {
    throw new ProxyError('TokenHub returned an invalid Anthropic message object', {
      status: 502,
      type: 'api_error',
    });
  }
}

function tokenHubStreamError(payload) {
  const error = payload?.error ?? payload;
  const status = error?.type === 'authentication_error' ? 401
    : error?.type === 'permission_error' ? 403
      : error?.type === 'rate_limit_error' ? 429
        : error?.type === 'invalid_request_error' ? 400
          : 502;
  return new ProxyError(error?.message || 'TokenHub returned an Anthropic stream error', {
    status,
    type: error?.type || 'api_error',
    details: { reqid: error?.reqid },
  });
}

function inferStopReason(content) {
  return content.some((block) => block?.type === 'tool_use') ? 'tool_use' : 'end_turn';
}

function emptyUsage() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function mergeUsage(target, value = {}) {
  const normalized = {
    input_tokens: integer(value?.input_tokens ?? value?.prompt_tokens),
    output_tokens: integer(value?.output_tokens ?? value?.completion_tokens),
    cache_creation_input_tokens: integer(
      value?.cache_creation_input_tokens ?? value?.cache_creation_tokens,
    ),
    cache_read_input_tokens: integer(
      value?.cache_read_input_tokens
        ?? value?.cache_token_usage
        ?? value?.cache_tokens
        ?? value?.cached_tokens
        ?? value?.input_tokens_details?.cached_tokens
        ?? value?.prompt_tokens_details?.cached_tokens,
    ),
  };
  for (const key of Object.keys(target)) {
    const next = normalized[key];
    if (next || target[key] === 0) target[key] = Math.max(target[key], next);
  }
  return target;
}

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

function cloneJson(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function sanitizeHeader(value) {
  return String(value).replace(/[\r\n]/g, '').trim();
}

