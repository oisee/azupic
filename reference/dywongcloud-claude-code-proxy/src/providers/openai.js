import { resolveApiKey } from '../auth-store.js';
import {
  contentBlocks,
  imageUrlFromAnthropic,
  resolveRequestedEffort,
  systemText,
  toolResultText,
} from '../anthropic.js';
import { ProxyError, parseUpstreamError } from '../errors.js';
import { postJsonWithRetry, readJsonResponse } from '../http.js';
import { parseSse, parseSseJson } from '../sse.js';
import {
  decodeOpenAIReasoningSignature,
  encodeOpenAIReasoningSignature,
} from '../reasoning-signature.js';
import { compactObject, randomId } from '../util.js';
import {
  mapAnthropicToolChoice,
  mapReasoningEffort,
  mapResponseFormat,
  mapTools,
  normalizeUsageFromOpenAi,
  parallelToolCalls,
  safeMetadata,
} from './common.js';

/**
 * @param {{config:ReturnType<import('../config.js').loadConfig>, logger:ReturnType<import('../logging.js').createLogger>, env?:NodeJS.ProcessEnv|Record<string,string|undefined>}} options
 */
export function createOpenAIProvider(options) {
  const env = options.env ?? process.env;
  return {
    name: 'openai',
    /**
     * @param {any} body
     * @param {ReturnType<import('../router.js').resolveRoute>} route
     * @param {{signal?:AbortSignal, headers?:Headers}} context
     */
    async execute(body, route, context = {}) {
      const credential = resolveApiKey('openai', options.config, env);
      if (!credential) {
        throw new ProxyError(
          'OpenAI API key is not configured. Set CCP_OPENAI_API_KEY or OPENAI_API_KEY, ' +
            'or run: claude-code-proxy openai auth login',
          { status: 401, type: 'authentication_error' },
        );
      }
      const payload = translateOpenAIRequest(body, route, options.config, context.headers);
      const headers = {
        authorization: `Bearer ${credential.key}`,
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'user-agent': 'claude-code-proxy-openai-moonshot/1.0.1',
      };
      if (options.config.openai.organization) headers['openai-organization'] = options.config.openai.organization;
      if (options.config.openai.project) headers['openai-project'] = options.config.openai.project;

      const response = await postJsonWithRetry({
        url: `${options.config.openai.baseUrl}/responses`,
        headers,
        body: payload,
        config: options.config,
        logger: options.logger,
        signal: context.signal,
        provider: 'openai',
      });
      if (!response.body) throw new ProxyError('OpenAI returned an empty response body', { status: 502 });
      const contentType = response.headers.get('content-type') ?? '';
      const events = contentType.includes('text/event-stream')
        ? normalizeOpenAIResponseStream(response.body, {
            maxBytes: options.config.maxResponseBytes,
            idleTimeoutMs: options.config.streamIdleTimeoutMs,
            signal: context.signal,
            model: route.model,
          })
        : normalizeOpenAIResponseJson(await readJsonResponse(response, options.config.maxResponseBytes, {
              idleTimeoutMs: options.config.streamIdleTimeoutMs,
              signal: context.signal,
            }), {
            model: route.model,
          });
      return {
        upstreamModel: route.model,
        events,
        requestPayload: payload,
      };
    },
  };
}

/**
 * @param {any} body
 * @param {ReturnType<import('../router.js').resolveRoute>} route
 * @param {ReturnType<import('../config.js').loadConfig>} config
 * @param {Headers|undefined} requestHeaders
 */
export function translateOpenAIRequest(body, route, config, requestHeaders) {
  const effort = mapReasoningEffort(resolveRequestedEffort(body, config.openai.reasoningEffort), 'openai');
  const thinkingDisabled = body?.thinking?.type === 'disabled';
  const responseFormat = mapResponseFormat(body.output_config);
  const mappedChoice = mapAnthropicToolChoice(body.tool_choice);
  const parallel = parallelToolCalls(body.tool_choice, body.parallel_tool_calls);
  const sessionId =
    requestHeaders?.get?.('x-claude-code-session-id') ??
    requestHeaders?.get?.('x-session-id') ??
    body?.metadata?.session_id;

  const request = {
    model: route.model,
    instructions: systemText(body.system) || undefined,
    input: anthropicMessagesToResponsesInput(body.messages, {
      model: route.model,
      replayReasoning: config.openai.encryptedReasoning !== false,
    }),
    include: config.openai.encryptedReasoning !== false ? ['reasoning.encrypted_content'] : undefined,
    tools: mapTools(body.tools),
    tool_choice: mappedChoice,
    parallel_tool_calls: parallel,
    max_output_tokens: body.max_tokens ?? undefined,
    stream: true,
    store: config.openai.store,
    metadata: safeMetadata(body.metadata),
    prompt_cache_key: typeof sessionId === 'string' && sessionId ? sessionId.slice(0, 64) : undefined,
    service_tier: route.serviceTier ?? config.openai.serviceTier,
    reasoning:
      thinkingDisabled || !effort
        ? undefined
        : {
            effort,
            summary: config.openai.reasoningSummary ?? 'auto',
          },
    text: responseFormat ? { format: responsesTextFormat(responseFormat) } : undefined,
  };

  return compactObject(request);
}

/**
 * @param {any[]} messages
 * @param {{model?:string,replayReasoning?:boolean}} [options]
 */
export function anthropicMessagesToResponsesInput(messages, options = {}) {
  const input = [];
  for (const message of messages ?? []) {
    if (message.role === 'user') appendUserMessage(input, contentBlocks(message.content));
    else appendAssistantMessage(input, contentBlocks(message.content), options);
  }
  return input;
}

function appendUserMessage(input, blocks) {
  let content = [];
  const flush = () => {
    if (content.length > 0) {
      input.push({ type: 'message', role: 'user', content });
      content = [];
    }
  };

  for (const block of blocks) {
    if (block.type === 'text') {
      content.push({ type: 'input_text', text: block.text ?? '' });
    } else if (block.type === 'image') {
      content.push({ type: 'input_image', image_url: imageUrlFromAnthropic(block), detail: 'auto' });
    } else if (block.type === 'tool_result') {
      flush();
      input.push({
        type: 'function_call_output',
        call_id: block.tool_use_id,
        output: `${block.is_error ? '[tool error]\n' : ''}${toolResultText(block.content)}`,
      });
    } else if (block.type === 'document') {
      content.push({ type: 'input_text', text: documentFallback(block) });
    } else {
      content.push({ type: 'input_text', text: safeJson(block) });
    }
  }
  flush();
}

function appendAssistantMessage(input, blocks, options) {
  let content = [];
  const flush = () => {
    if (content.length > 0) {
      input.push({ type: 'message', role: 'assistant', content });
      content = [];
    }
  };
  for (const block of blocks) {
    if (block.type === 'text') {
      content.push({ type: 'output_text', text: block.text ?? '' });
    } else if (block.type === 'tool_use') {
      flush();
      input.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: safeJson(block.input ?? {}),
      });
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      flush();
      if (options.replayReasoning !== false) {
        const reasoning = decodeOpenAIReasoningSignature(block.signature, { model: options.model });
        if (reasoning) input.push(reasoning);
      }
    } else {
      content.push({ type: 'output_text', text: safeJson(block) });
    }
  }
  flush();
}

function responsesTextFormat(format) {
  if (format.type === 'json_object') return { type: 'json_object' };
  return {
    type: 'json_schema',
    name: format.name,
    schema: format.schema,
    strict: format.strict,
    description: format.description,
  };
}


/**
 * Normalize a non-streaming Responses API object. This is used when an
 * OpenAI-compatible gateway ignores `stream: true` and returns JSON.
 * @param {any} response
 * @param {{model?:string}} [options]
 */
export async function* normalizeOpenAIResponseJson(response, options = {}) {
  if (response?.error) throw upstreamPayloadError(response.error, response);
  if (response?.status === 'failed') throw upstreamPayloadError(response.error, response);

  let stopReason = 'end_turn';
  const output = Array.isArray(response?.output) ? response.output : [];
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    const item = output[outputIndex];
    if (item?.type === 'reasoning') {
      const summary = reasoningSummaryText(item);
      const signature = encodeOpenAIReasoningSignature(item, options.model ?? response?.model);
      if (summary || signature) {
        const key = `thinking:${item.id ?? outputIndex}`;
        yield { type: 'block_start', key, kind: 'thinking' };
        if (summary) yield { type: 'block_delta', key, deltaType: 'thinking', delta: summary };
        yield { type: 'block_stop', key, signature };
      }
    } else if (item?.type === 'message') {
      const content = Array.isArray(item.content) ? item.content : [];
      for (let index = 0; index < content.length; index += 1) {
        const part = content[index];
        if (!['output_text', 'refusal'].includes(part?.type)) continue;
        const text = part.text ?? part.refusal ?? '';
        if (!text) continue;
        const key = `text:${item.id ?? outputIndex}:${index}`;
        yield { type: 'block_start', key, kind: 'text' };
        yield { type: 'block_delta', key, deltaType: 'text', delta: text };
        yield { type: 'block_stop', key };
      }
    } else if (item?.type === 'function_call') {
      const key = `tool:${item.id ?? outputIndex}`;
      const id = item.call_id ?? item.id ?? randomId('call');
      yield { type: 'block_start', key, kind: 'tool', id, name: item.name ?? 'tool' };
      yield { type: 'block_delta', key, deltaType: 'json', delta: item.arguments || '{}' };
      yield { type: 'block_stop', key };
      stopReason = 'tool_use';
    }
  }

  if (output.length === 0 && typeof response?.output_text === 'string' && response.output_text) {
    yield { type: 'block_start', key: 'text:output_text', kind: 'text' };
    yield { type: 'block_delta', key: 'text:output_text', deltaType: 'text', delta: response.output_text };
    yield { type: 'block_stop', key: 'text:output_text' };
  }

  yield { type: 'usage', usage: normalizeUsageFromOpenAi(response?.usage) };
  if (response?.status === 'incomplete') {
    const reason = response?.incomplete_details?.reason;
    if (reason === 'max_output_tokens') stopReason = 'max_tokens';
    else throw new ProxyError(`OpenAI response was incomplete${reason ? `: ${reason}` : ''}`, { status: 502 });
  }
  yield { type: 'message_done', stopReason };
}

/**
 * @param {ReadableStream<Uint8Array>} stream
 * @param {{maxBytes:number,idleTimeoutMs:number,signal?:AbortSignal,model?:string}} options
 */
export async function* normalizeOpenAIResponseStream(stream, options) {
  const blocks = new Map();
  const toolState = new Map();
  let sawTerminal = false;
  let stopReason = 'end_turn';

  for await (const frame of parseSse(stream, options)) {
    if (frame.data === '[DONE]') break;
    const payload = parseSseJson(frame.data, 'OpenAI Responses stream');
    const type = payload.type ?? frame.event;

    if (payload.error && !String(type).startsWith('response.')) {
      throw upstreamPayloadError(payload.error, payload);
    }

    switch (type) {
      case 'response.created':
      case 'response.in_progress':
      case 'response.queued':
      case 'response.reasoning_summary_part.added':
      case 'response.reasoning_summary_part.done':
        break;

      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_summary.delta':
      case 'response.reasoning_text.delta': {
        const key = reasoningKey(payload);
        const { state, created } = ensureContentState(blocks, key, 'thinking');
        if (created) yield { type: 'block_start', key, kind: 'thinking' };
        const delta = payload.delta ?? payload.text ?? '';
        if (delta) {
          state.sawDelta = true;
          yield { type: 'block_delta', key, deltaType: 'thinking', delta };
        }
        break;
      }

      case 'response.reasoning_summary_text.done':
      case 'response.reasoning_summary.done':
      case 'response.reasoning_text.done': {
        // Keep the block open until the reasoning output item arrives. That
        // item carries encrypted_content, which must be emitted as the
        // Anthropic thinking signature before content_block_stop.
        const text = payload.text ?? '';
        if (text) {
          const key = reasoningKey(payload);
          const { state, created } = ensureContentState(blocks, key, 'thinking');
          if (created) yield { type: 'block_start', key, kind: 'thinking' };
          if (!state.sawDelta) {
            state.sawDelta = true;
            yield { type: 'block_delta', key, deltaType: 'thinking', delta: text };
          }
        }
        break;
      }

      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        const key = textKey(payload);
        const { state, created } = ensureContentState(blocks, key, 'text');
        if (created) yield { type: 'block_start', key, kind: 'text' };
        const delta = payload.delta ?? payload.text ?? '';
        if (delta) {
          state.sawDelta = true;
          yield { type: 'block_delta', key, deltaType: 'text', delta };
        }
        break;
      }

      case 'response.output_text.done':
      case 'response.refusal.done': {
        const key = textKey(payload);
        const text = payload.text ?? payload.refusal ?? '';
        let state = blocks.get(key);
        if (!state && text) {
          ({ state } = ensureContentState(blocks, key, 'text'));
          yield { type: 'block_start', key, kind: 'text' };
        }
        if (state && text && !state.sawDelta) {
          state.sawDelta = true;
          yield { type: 'block_delta', key, deltaType: 'text', delta: text };
        }
        if (state && !state.closed) {
          state.closed = true;
          yield { type: 'block_stop', key };
        }
        break;
      }

      case 'response.output_item.added': {
        const item = payload.item;
        if (item?.type === 'function_call') {
          const state = ensureToolState(toolState, payload, item);
          yield* emitToolStartAndPending(state);
          stopReason = 'tool_use';
        }
        break;
      }

      case 'response.function_call_arguments.delta': {
        const state = ensureToolState(toolState, payload);
        const delta = payload.delta ?? '';
        if (delta) state.arguments += delta;
        yield* emitToolStartAndPending(state);
        stopReason = 'tool_use';
        break;
      }

      case 'response.function_call_arguments.done': {
        const state = ensureToolState(toolState, payload);
        const complete = payload.arguments ?? '';
        if (complete && complete.length >= state.arguments.length) state.arguments = complete;
        yield* emitToolStartAndPending(state);
        if (state.started && !state.closed) {
          state.closed = true;
          yield { type: 'block_stop', key: state.key };
        }
        stopReason = 'tool_use';
        break;
      }

      case 'response.output_item.done': {
        const item = payload.item;
        if (item?.type === 'function_call') {
          yield* emitFunctionCallItem(item, payload, toolState);
          stopReason = 'tool_use';
        } else if (item?.type === 'message') {
          yield* emitBufferedMessageItem(item, payload, blocks);
        } else if (item?.type === 'reasoning') {
          yield* emitReasoningItem(item, payload, blocks, options.model, { final: false });
        }
        break;
      }

      case 'response.completed': {
        const response = payload.response ?? payload;
        for (const item of response.output ?? []) {
          if (item?.type === 'reasoning') {
            yield* emitReasoningItem(item, payload, blocks, options.model ?? response.model, { final: true });
          } else if (item?.type === 'message') {
            yield* emitBufferedMessageItem(item, payload, blocks);
          } else if (item?.type === 'function_call') {
            yield* emitFunctionCallItem(item, payload, toolState);
            stopReason = 'tool_use';
          }
        }
        yield* closeOpenContentBlocks(blocks);
        yield* closePendingToolStates(toolState);
        if (toolState.size > 0) stopReason = 'tool_use';
        yield { type: 'usage', usage: normalizeUsageFromOpenAi(response.usage) };
        sawTerminal = true;
        yield { type: 'message_done', stopReason };
        break;
      }

      case 'response.incomplete': {
        const response = payload.response ?? payload;
        for (const item of response.output ?? []) {
          if (item?.type === 'reasoning') {
            yield* emitReasoningItem(item, payload, blocks, options.model ?? response.model, { final: true });
          } else if (item?.type === 'message') {
            yield* emitBufferedMessageItem(item, payload, blocks);
          } else if (item?.type === 'function_call') {
            yield* emitFunctionCallItem(item, payload, toolState);
            stopReason = 'tool_use';
          }
        }
        yield* closeOpenContentBlocks(blocks);
        yield* closePendingToolStates(toolState);
        yield { type: 'usage', usage: normalizeUsageFromOpenAi(response.usage) };
        const reason = response.incomplete_details?.reason ?? payload.incomplete_details?.reason;
        if (reason === 'max_output_tokens') {
          sawTerminal = true;
          yield { type: 'message_done', stopReason: 'max_tokens' };
        } else {
          throw new ProxyError(`OpenAI response was incomplete${reason ? `: ${reason}` : ''}`, {
            status: 502,
            type: 'api_error',
          });
        }
        break;
      }

      case 'response.failed': {
        const response = payload.response ?? payload;
        throw upstreamPayloadError(response.error ?? payload.error, payload);
      }

      case 'error':
        throw upstreamPayloadError(payload.error ?? payload, payload);

      default:
        // Forward compatibility: unrecognized lifecycle and telemetry events
        // are ignored, while terminal failures above remain strict.
        break;
    }
  }

  if (!sawTerminal) {
    throw new ProxyError('OpenAI Responses stream ended before a terminal response event', {
      status: 502,
      type: 'api_error',
    });
  }
}

function* emitReasoningItem(item, payload, blocks, model, { final = false } = {}) {
  const key = reasoningKey(payload, item);
  const summary = reasoningSummaryText(item);
  const signature = encodeOpenAIReasoningSignature(item, model);
  let state = blocks.get(key);
  if (!state && !summary && !signature) return;
  if (!state) {
    ({ state } = ensureContentState(blocks, key, 'thinking'));
    yield { type: 'block_start', key, kind: 'thinking' };
  }
  if (summary && !state.sawDelta) {
    state.sawDelta = true;
    yield { type: 'block_delta', key, deltaType: 'thinking', delta: summary };
  }
  if (!state.closed && (signature || final)) {
    state.closed = true;
    yield { type: 'block_stop', key, signature };
  }
}

function* emitBufferedMessageItem(item, payload, blocks) {
  const content = Array.isArray(item.content) ? item.content : [];
  for (let index = 0; index < content.length; index += 1) {
    const part = content[index];
    if (!['output_text', 'refusal'].includes(part?.type)) continue;
    const text = part.text ?? part.refusal ?? '';
    if (!text) continue;
    const key = `text:${item.id ?? payload.output_index ?? 'buffered'}:${index}`;
    let state = blocks.get(key);
    if (!state) {
      ({ state } = ensureContentState(blocks, key, 'text'));
      yield { type: 'block_start', key, kind: 'text' };
    }
    if (!state.sawDelta) {
      state.sawDelta = true;
      yield { type: 'block_delta', key, deltaType: 'text', delta: text };
    }
    if (!state.closed) {
      state.closed = true;
      yield { type: 'block_stop', key };
    }
  }
}

function* emitFunctionCallItem(item, payload, states) {
  const state = ensureToolState(states, payload, item);
  if (typeof item.arguments === 'string' && item.arguments.length >= state.arguments.length) {
    state.arguments = item.arguments;
  }
  yield* emitToolStartAndPending(state);
  if (state.started && !state.closed) {
    state.closed = true;
    yield { type: 'block_stop', key: state.key };
  }
}

function* emitToolStartAndPending(state) {
  if (!state.started && state.name) {
    state.started = true;
    yield { type: 'block_start', key: state.key, kind: 'tool', id: state.id, name: state.name };
  }
  if (state.started && state.arguments.length > state.emittedArgumentsLength) {
    const delta = state.arguments.slice(state.emittedArgumentsLength);
    state.emittedArgumentsLength = state.arguments.length;
    if (delta) yield { type: 'block_delta', key: state.key, deltaType: 'json', delta };
  }
}

function* closeOpenContentBlocks(blocks) {
  for (const [key, state] of blocks) {
    if (!state.closed) {
      state.closed = true;
      yield { type: 'block_stop', key };
    }
  }
}

function* closePendingToolStates(states) {
  for (const state of states.values()) {
    if (!state.name) state.name = 'tool';
    yield* emitToolStartAndPending(state);
    if (!state.arguments && state.emittedArgumentsLength === 0) {
      state.arguments = '{}';
      yield* emitToolStartAndPending(state);
    }
    if (!state.closed) {
      state.closed = true;
      yield { type: 'block_stop', key: state.key };
    }
  }
}

function ensureContentState(states, key, kind) {
  let state = states.get(key);
  const created = !state;
  if (!state) {
    state = { kind, closed: false, sawDelta: false };
    states.set(key, state);
  }
  return { state, created };
}

function reasoningSummaryText(item) {
  return (Array.isArray(item?.summary) ? item.summary : [])
    .filter((part) => part?.type === 'summary_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n\n');
}

function ensureToolState(states, payload, item = {}) {
  const itemId = item.id ?? payload.item_id ?? payload.call_id ?? `output-${payload.output_index ?? 0}`;
  const key = `tool:${itemId}`;
  let state = states.get(key);
  if (!state) {
    state = {
      key,
      id: item.call_id ?? payload.call_id ?? item.id ?? randomId('call'),
      name: item.name ?? payload.name ?? '',
      arguments: '',
      emittedArgumentsLength: 0,
      started: false,
      closed: false,
    };
    states.set(key, state);
  } else {
    if (item.call_id || payload.call_id) state.id = item.call_id ?? payload.call_id;
    if (item.name || payload.name) state.name = item.name ?? payload.name;
  }
  return state;
}

function reasoningKey(payload, item = payload.item) {
  return `thinking:${item?.id ?? payload.item_id ?? payload.output_index ?? 'reasoning'}`;
}

function textKey(payload) {
  return `text:${payload.item_id ?? payload.output_index ?? 'message'}:${payload.content_index ?? 0}`;
}

function upstreamPayloadError(error, payload) {
  if (error && typeof error === 'object') {
    return parseUpstreamError(JSON.stringify({ error }), Number(error.status ?? payload.status ?? 502));
  }
  return new ProxyError(String(error?.message ?? error ?? 'OpenAI stream failed'), { status: 502 });
}

function documentFallback(block) {
  const title = block.title || block.name || 'document';
  if (block.source?.type === 'text' && typeof block.source.data === 'string') {
    return `[${title}]\n${block.source.data}`;
  }
  return `[document omitted: ${title}]`;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

