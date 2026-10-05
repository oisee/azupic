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
import { compactObject, randomId } from '../util.js';
import {
  mapReasoningEffort,
  mapResponseFormat,
  normalizeUsageFromOpenAi,
  parallelToolCalls,
} from './common.js';

/**
 * @param {{config:ReturnType<import('../config.js').loadConfig>, logger:ReturnType<import('../logging.js').createLogger>, env?:NodeJS.ProcessEnv|Record<string,string|undefined>}} options
 */
export function createMoonshotProvider(options) {
  const env = options.env ?? process.env;
  return {
    name: 'moonshot',
    async execute(body, route, context = {}) {
      const credential = resolveApiKey('moonshot', options.config, env);
      if (!credential) {
        throw new ProxyError(
          'Moonshot API key is not configured. Set CCP_MOONSHOT_API_KEY or MOONSHOT_API_KEY, ' +
            'or run: claude-code-proxy moonshot auth login',
          { status: 401, type: 'authentication_error' },
        );
      }
      const payload = translateMoonshotRequest(body, route, options.config);
      const response = await postJsonWithRetry({
        url: `${options.config.moonshot.baseUrl}/chat/completions`,
        headers: {
          authorization: `Bearer ${credential.key}`,
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'user-agent': 'claude-code-proxy-openai-moonshot/1.0.1',
        },
        body: payload,
        config: options.config,
        logger: options.logger,
        signal: context.signal,
        provider: 'moonshot',
      });
      if (!response.body) throw new ProxyError('Moonshot returned an empty response body', { status: 502 });
      const contentType = response.headers.get('content-type') ?? '';
      const events = contentType.includes('text/event-stream')
        ? normalizeMoonshotStream(response.body, {
            maxBytes: options.config.maxResponseBytes,
            idleTimeoutMs: options.config.streamIdleTimeoutMs,
            signal: context.signal,
            emitThinking: body?.thinking?.type !== 'disabled',
          })
        : normalizeMoonshotJson(await readJsonResponse(response, options.config.maxResponseBytes, {
              idleTimeoutMs: options.config.streamIdleTimeoutMs,
              signal: context.signal,
            }), {
            emitThinking: body?.thinking?.type !== 'disabled',
          });
      return {
        upstreamModel: route.model,
        requestPayload: payload,
        events,
      };
    },
  };
}

/**
 * @param {any} body
 * @param {ReturnType<import('../router.js').resolveRoute>} route
 * @param {ReturnType<import('../config.js').loadConfig>} config
 */
export function translateMoonshotRequest(body, route, config) {
  const isK3 = /^kimi-k3(?:$|-)/i.test(route.model);
  const thinkingDisabled = body?.thinking?.type === 'disabled';
  // K3 currently exposes low/high/max rather than a true off switch. When
  // Claude disables visible thinking, request low effort and consume the
  // reasoning stream without forwarding it. Omitting this field would default
  // K3 back to max effort.
  const effort = thinkingDisabled
    ? 'low'
    : mapReasoningEffort(resolveRequestedEffort(body, config.moonshot.reasoningEffort), 'moonshot');
  const format = mapResponseFormat(body.output_config);
  const maxCompletionTokens = Math.min(1_048_576, body.max_tokens ?? 131_072);

  const request = {
    model: route.model,
    messages: anthropicMessagesToChat(body.messages, {
      system: systemText(body.system),
      mergeSystem: isK3 && config.moonshot.mergeSystemIntoUserForK3,
    }),
    tools: mapChatTools(body.tools),
    tool_choice: mapChatToolChoice(body.tool_choice),
    parallel_tool_calls: parallelToolCalls(body.tool_choice, body.parallel_tool_calls),
    max_completion_tokens: maxCompletionTokens,
    reasoning_effort: effort,
    stream: true,
    stream_options: { include_usage: true },
    response_format: chatResponseFormat(format),
    stop: Array.isArray(body.stop_sequences) && body.stop_sequences.length
      ? body.stop_sequences.slice(0, 4)
      : undefined,
  };

  // Kimi K3 documents fixed sampling values; omitting them avoids a 400 when
  // Claude Code sends values intended for an Anthropic model. Other Moonshot
  // chat models may accept them, but consistency is preferable here.
  return compactObject(request);
}

/**
 * @param {any[]} messages
 * @param {{system?:string,mergeSystem?:boolean}} options
 */
export function anthropicMessagesToChat(messages, options = {}) {
  const output = [];
  if (options.system && !options.mergeSystem) output.push({ role: 'system', content: options.system });

  for (const message of messages ?? []) {
    const blocks = contentBlocks(message.content);
    if (message.role === 'assistant') appendAssistantChatMessage(output, blocks);
    else appendUserChatMessages(output, blocks);
  }

  if (options.system && options.mergeSystem) mergeSystemIntoFirstUser(output, options.system);
  return output;
}

function appendAssistantChatMessage(output, blocks) {
  let text = '';
  let reasoning = '';
  const toolCalls = [];
  for (const block of blocks) {
    if (block.type === 'text') text += block.text ?? '';
    else if (block.type === 'thinking') reasoning += block.thinking ?? '';
    else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: safeJson(block.input ?? {}),
        },
      });
    }
  }
  const assistant = {
    role: 'assistant',
    content: text || null,
    reasoning_content: reasoning || undefined,
    tool_calls: toolCalls.length ? toolCalls : undefined,
  };
  output.push(compactObject(assistant));
}

function appendUserChatMessages(output, blocks) {
  const regularParts = [];
  const visionAfterTools = [];

  for (const block of blocks) {
    if (block.type === 'tool_result') {
      const toolParts = chatParts(block.content);
      const textParts = toolParts.filter((part) => part.type === 'text');
      const imageParts = toolParts.filter((part) => part.type === 'image_url');
      const textOutput = textParts.length
        ? textParts.map((part) => part.text).join('\n')
        : toolResultText(block.content);
      output.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: `${block.is_error ? '[tool error]\n' : ''}${textOutput}`,
      });
      if (imageParts.length) {
        visionAfterTools.push({ type: 'text', text: `Images returned by tool ${block.tool_use_id}:` }, ...imageParts);
      }
    } else if (block.type === 'text') {
      regularParts.push({ type: 'text', text: block.text ?? '' });
    } else if (block.type === 'image') {
      regularParts.push({ type: 'image_url', image_url: { url: moonshotImageUrl(block) } });
    } else if (block.type === 'document') {
      regularParts.push({ type: 'text', text: `[document omitted: ${block.title ?? 'document'}]` });
    }
  }

  const allParts = [...regularParts, ...visionAfterTools];
  if (allParts.length) {
    output.push({
      role: 'user',
      content: allParts.length === 1 && allParts[0].type === 'text' ? allParts[0].text : allParts,
    });
  }
}

function chatParts(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) return [{ type: 'text', text: '' }];
  return content.map((block) => {
    if (block?.type === 'text') return { type: 'text', text: block.text ?? '' };
    if (block?.type === 'image') return { type: 'image_url', image_url: { url: moonshotImageUrl(block) } };
    return { type: 'text', text: safeJson(block) };
  });
}

function mergeSystemIntoFirstUser(messages, system) {
  const prefix = `System instructions:\n${system}\n\nUser message:\n`;
  const firstUser = messages.find((message) => message.role === 'user');
  if (!firstUser) {
    messages.unshift({ role: 'user', content: `${prefix}(continue the conversation)` });
    return;
  }
  if (typeof firstUser.content === 'string') {
    firstUser.content = `${prefix}${firstUser.content}`;
  } else if (Array.isArray(firstUser.content)) {
    firstUser.content.unshift({ type: 'text', text: prefix });
  } else {
    firstUser.content = prefix;
  }
}

function mapChatTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || undefined,
      parameters: tool.input_schema,
      strict: false,
    },
  }));
}

function mapChatToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === 'string') return choice;
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'none') return 'none';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'tool' && typeof choice.name === 'string') {
    return { type: 'function', function: { name: choice.name } };
  }
  throw new ProxyError(`Unsupported tool_choice ${JSON.stringify(choice)}`, { status: 400 });
}

function chatResponseFormat(format) {
  if (!format) return undefined;
  if (format.type === 'json_object') return { type: 'json_object' };
  return {
    type: 'json_schema',
    json_schema: {
      name: format.name,
      schema: format.schema,
      strict: format.strict,
      description: format.description,
    },
  };
}


/**
 * Normalize a non-streaming Chat Completions object from a compatible gateway.
 * @param {any} payload
 * @param {{emitThinking?:boolean}} [options]
 */
export async function* normalizeMoonshotJson(payload, options = {}) {
  if (payload?.error) throw upstreamChatError(payload.error, payload);
  let stopReason = 'end_turn';
  const choices = Array.isArray(payload?.choices) ? payload.choices : [];
  for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex += 1) {
    const choice = choices[choiceIndex];
    const message = choice.message ?? choice.delta ?? {};
    const reasoning = message.reasoning_content ?? message.reasoning;
    if (options.emitThinking !== false && typeof reasoning === 'string' && reasoning) {
      const key = `thinking:${choiceIndex}`;
      yield { type: 'block_start', key, kind: 'thinking' };
      yield { type: 'block_delta', key, deltaType: 'thinking', delta: reasoning };
      yield { type: 'block_stop', key };
    }
    const text = normalizeTextDelta(message.content);
    if (text) {
      const key = `text:${choiceIndex}`;
      yield { type: 'block_start', key, kind: 'text' };
      yield { type: 'block_delta', key, deltaType: 'text', delta: text };
      yield { type: 'block_stop', key };
    }
    for (let index = 0; index < (message.tool_calls ?? []).length; index += 1) {
      const call = message.tool_calls[index];
      const key = `tool:${choiceIndex}:${call.index ?? index}`;
      yield {
        type: 'block_start',
        key,
        kind: 'tool',
        id: call.id ?? randomId('call'),
        name: call.function?.name ?? 'tool',
      };
      yield {
        type: 'block_delta',
        key,
        deltaType: 'json',
        delta: call.function?.arguments || '{}',
      };
      yield { type: 'block_stop', key };
      stopReason = 'tool_use';
    }
    stopReason = normalizeChatFinishReason(choice.finish_reason, stopReason);
  }
  yield { type: 'usage', usage: normalizeUsageFromOpenAi(payload?.usage) };
  yield { type: 'message_done', stopReason };
}

/**
 * @param {ReadableStream<Uint8Array>} stream
 * @param {{maxBytes:number,idleTimeoutMs:number,signal?:AbortSignal,emitThinking?:boolean}} options
 */
export async function* normalizeMoonshotStream(stream, options) {
  const toolStates = new Map();
  let thinkingStarted = false;
  let thinkingClosed = false;
  let textStarted = false;
  let textClosed = false;
  let sawFinish = false;
  let stopReason = 'end_turn';

  for await (const frame of parseSse(stream, options)) {
    if (frame.data === '[DONE]') break;
    const payload = parseSseJson(frame.data, 'Moonshot Chat Completions stream');
    if (payload.error) throw upstreamChatError(payload.error, payload);
    if (payload.usage) yield { type: 'usage', usage: normalizeUsageFromOpenAi(payload.usage) };

    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    for (const choice of choices) {
      const delta = choice.delta ?? choice.message ?? {};
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (options.emitThinking !== false && typeof reasoning === 'string' && reasoning) {
        if (!thinkingStarted) {
          thinkingStarted = true;
          thinkingClosed = false;
          yield { type: 'block_start', key: 'thinking:0', kind: 'thinking' };
        }
        yield { type: 'block_delta', key: 'thinking:0', deltaType: 'thinking', delta: reasoning };
      }

      const text = normalizeTextDelta(delta.content);
      if (text) {
        if (!textStarted) {
          textStarted = true;
          textClosed = false;
          yield { type: 'block_start', key: 'text:0', kind: 'text' };
        }
        yield { type: 'block_delta', key: 'text:0', deltaType: 'text', delta: text };
      }

      for (const call of delta.tool_calls ?? []) {
        const index = Number.isInteger(call.index) ? call.index : toolStates.size;
        const key = `tool:${index}`;
        let state = toolStates.get(key);
        if (!state) {
          state = {
            key,
            id: call.id || randomId('call'),
            name: '',
            arguments: '',
            started: false,
            closed: false,
          };
          toolStates.set(key, state);
        }
        if (call.id) state.id = call.id;
        if (call.function?.name) state.name += call.function.name;
        const args = call.function?.arguments ?? '';
        // Wait until argument streaming begins so fragmented function names
        // are complete before Anthropic's immutable tool block is opened.
        if (!state.started && args) {
          state.started = true;
          yield {
            type: 'block_start',
            key,
            kind: 'tool',
            id: state.id,
            name: state.name || 'tool',
          };
        }
        if (args) {
          state.arguments += args;
          yield { type: 'block_delta', key, deltaType: 'json', delta: args, id: state.id, name: state.name };
        }
        stopReason = 'tool_use';
      }

      if (choice.finish_reason) {
        stopReason = normalizeChatFinishReason(choice.finish_reason, stopReason);
        if (thinkingStarted && !thinkingClosed) {
          yield { type: 'block_stop', key: 'thinking:0' };
          thinkingClosed = true;
        }
        if (textStarted && !textClosed) {
          yield { type: 'block_stop', key: 'text:0' };
          textClosed = true;
        }
        for (const state of toolStates.values()) {
          if (!state.started) {
            state.started = true;
            yield {
              type: 'block_start',
              key: state.key,
              kind: 'tool',
              id: state.id,
              name: state.name || 'tool',
            };
          }
          if (!state.closed) {
            if (!state.arguments) {
              yield { type: 'block_delta', key: state.key, deltaType: 'json', delta: '{}' };
            }
            yield { type: 'block_stop', key: state.key };
            state.closed = true;
          }
        }
        // Chat Completions commonly sends a final usage-only chunk after the
        // finish_reason chunk. Delay message_done until [DONE]/EOF so usage is
        // available to the Anthropic terminal event.
        sawFinish = true;
      }
    }
  }

  if (thinkingStarted && !thinkingClosed) yield { type: 'block_stop', key: 'thinking:0' };
  if (textStarted && !textClosed) yield { type: 'block_stop', key: 'text:0' };
  for (const state of toolStates.values()) {
    if (!state.started) {
      state.started = true;
      yield {
        type: 'block_start',
        key: state.key,
        kind: 'tool',
        id: state.id,
        name: state.name || 'tool',
      };
    }
    if (!state.closed) {
      if (!state.arguments) yield { type: 'block_delta', key: state.key, deltaType: 'json', delta: '{}' };
      yield { type: 'block_stop', key: state.key };
      state.closed = true;
    }
  }
  if (!sawFinish) {
    throw new ProxyError('Moonshot stream ended before a finish_reason was received', {
      status: 502,
      type: 'api_error',
    });
  }
  yield { type: 'message_done', stopReason };
}

function normalizeTextDelta(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text' || typeof part?.text === 'string')
    .map((part) => part.text ?? '')
    .join('');
}

function normalizeChatFinishReason(reason, current) {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  if (reason === 'content_filter') return 'refusal';
  return current === 'tool_use' ? current : 'end_turn';
}

function upstreamChatError(error, payload) {
  return parseUpstreamError(JSON.stringify({ error }), Number(error?.status ?? payload?.status ?? 502));
}


function moonshotImageUrl(block) {
  return imageUrlFromAnthropic(block, { allowedProtocols: ['data:', 'ms:'] });
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

