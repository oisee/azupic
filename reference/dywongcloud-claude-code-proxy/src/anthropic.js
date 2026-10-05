import { ProxyError, anthropicErrorBody, normalizeError } from './errors.js';
import { encodeSse } from './sse.js';
import { randomId } from './util.js';

/** @param {unknown} body */
export function validateAnthropicRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ProxyError('Request body must be a JSON object', { status: 400 });
  }
  if (typeof body.model !== 'string' || body.model.trim() === '') {
    throw new ProxyError('model must be a non-empty string', { status: 400 });
  }
  if (!Array.isArray(body.messages)) {
    throw new ProxyError('messages must be an array', { status: 400 });
  }
  if (body.max_tokens != null && (!Number.isInteger(body.max_tokens) || body.max_tokens <= 0)) {
    throw new ProxyError('max_tokens must be a positive integer', { status: 400 });
  }
  if (body.stream != null && typeof body.stream !== 'boolean') {
    throw new ProxyError('stream must be a boolean', { status: 400 });
  }
  for (const [index, message] of body.messages.entries()) {
    if (
      !message ||
      typeof message !== 'object' ||
      !['user', 'assistant', 'system', 'developer'].includes(message.role)
    ) {
      throw new ProxyError(
        `messages[${index}].role must be "user", "assistant", "system", or "developer"`,
        { status: 400 },
      );
    }
    validateContent(message.content, `messages[${index}].content`);
  }
  if (body.tools != null) {
    if (!Array.isArray(body.tools)) throw new ProxyError('tools must be an array', { status: 400 });
    for (const [index, tool] of body.tools.entries()) {
      if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || tool.name === '') {
        throw new ProxyError(`tools[${index}].name must be a non-empty string`, { status: 400 });
      }
      const hasInputSchema = tool.input_schema != null;
      const hasServerToolType = typeof tool.type === 'string' && tool.type.trim() !== '';
      if (!hasInputSchema && !hasServerToolType) {
        throw new ProxyError(
          `tools[${index}] must provide input_schema or a versioned server-tool type`,
          { status: 400 },
        );
      }
      if (hasInputSchema && (typeof tool.input_schema !== 'object' || Array.isArray(tool.input_schema))) {
        throw new ProxyError(`tools[${index}].input_schema must be a JSON object`, { status: 400 });
      }
    }
  }
  return normalizeInlineInstructionMessages(body);
}

/**
 * Claude Code 2.1.154+ can emit positional system messages inside messages[].
 * Strict Anthropic-compatible backends still accept only user/assistant turns,
 * so hoist those instruction messages into the top-level system field before
 * provider translation. Developer-role messages are normalized the same way.
 *
 * @param {any} body
 */
export function normalizeInlineInstructionMessages(body) {
  const inlineInstructions = [];
  const messages = [];

  for (const message of body.messages ?? []) {
    if (message?.role === 'system' || message?.role === 'developer') {
      const text = instructionContentText(message.content);
      if (text.trim()) inlineInstructions.push(text);
      continue;
    }
    messages.push(message);
  }

  if (inlineInstructions.length === 0) return body;

  const system = Array.isArray(body.system)
    ? [
        ...body.system.map((block) => ({ ...block })),
        ...inlineInstructions.map((text) => ({ type: 'text', text })),
      ]
    : [systemText(body.system), ...inlineInstructions]
        .map((part) => part.trim())
        .filter(Boolean)
        .join('\n\n');

  return {
    ...body,
    system,
    messages,
  };
}

function instructionContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (block?.type === 'text') return block.text ?? '';
      if (block?.type === 'document') return `[document: ${block.title ?? 'untitled'}]`;
      return safeJson(block);
    })
    .filter(Boolean)
    .join('\n');
}

function validateContent(content, path) {
  if (typeof content === 'string') return;
  if (!Array.isArray(content)) throw new ProxyError(`${path} must be a string or array`, { status: 400 });
  for (const [index, block] of content.entries()) {
    if (!block || typeof block !== 'object' || typeof block.type !== 'string') {
      throw new ProxyError(`${path}[${index}] must have a type`, { status: 400 });
    }
  }
}

export function systemText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n\n');
}

export function contentBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

export function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (block?.type === 'text') return block.text ?? '';
      if (block?.type === 'image') return `[image ${block.source?.media_type ?? 'unknown'} omitted from text tool output]`;
      return safeJson(block);
    })
    .join('\n');
}

export function imageUrlFromAnthropic(block, options = {}) {
  const source = block?.source;
  if (!source || typeof source !== 'object') throw new ProxyError('image source is missing', { status: 400 });
  if (source.type === 'base64') {
    if (typeof source.media_type !== 'string' || typeof source.data !== 'string') {
      throw new ProxyError('base64 image requires media_type and data', { status: 400 });
    }
    return `data:${source.media_type};base64,${source.data}`;
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    let url;
    try {
      url = new URL(source.url);
    } catch (error) {
      throw new ProxyError(`Invalid image URL: ${error.message}`, { status: 400, cause: error });
    }
    const allowedProtocols = options.allowedProtocols ?? ['http:', 'https:', 'data:'];
    if (!allowedProtocols.includes(url.protocol)) {
      throw new ProxyError(
        `Unsupported image URL protocol ${url.protocol}; allowed protocols: ${allowedProtocols.join(', ')}`,
        { status: 400 },
      );
    }
    return source.url;
  }
  throw new ProxyError(`Unsupported image source type ${JSON.stringify(source.type)}`, { status: 400 });
}

export function resolveRequestedEffort(body, fallback) {
  const value = body?.output_config?.effort ?? body?.thinking?.effort ?? fallback;
  if (value == null || value === '') return undefined;
  return String(value).toLowerCase();
}

export class AnthropicEventEncoder {
  /**
   * @param {{requestModel: string, responseModel?: string, messageId?: string}} options
   */
  constructor(options) {
    this.requestModel = options.requestModel;
    this.responseModel = options.responseModel ?? options.requestModel;
    this.messageId = options.messageId ?? randomId('msg');
    this.started = false;
    this.finished = false;
    this.nextIndex = 0;
    this.blocks = new Map();
    this.usage = normalizeUsage();
    this.stopReason = null;
  }

  start() {
    if (this.started) return [];
    this.started = true;
    return [
      encodeSse('message_start', {
        type: 'message_start',
        message: {
          id: this.messageId,
          type: 'message',
          role: 'assistant',
          model: this.responseModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: this.usage.input_tokens,
            output_tokens: 0,
            cache_creation_input_tokens: this.usage.cache_creation_input_tokens,
            cache_read_input_tokens: this.usage.cache_read_input_tokens,
          },
        },
      }),
    ];
  }

  /** @param {NormalizedEvent} event */
  apply(event) {
    if (this.finished) return [];
    const out = this.started ? [] : this.start();
    if (event.type === 'block_start') {
      out.push(...this.startBlock(event));
    } else if (event.type === 'block_delta') {
      if (!this.blocks.has(event.key)) {
        out.push(
          ...this.startBlock({
            type: 'block_start',
            key: event.key,
            kind: event.deltaType === 'json' ? 'tool' : event.deltaType,
            id: event.id,
            name: event.name,
          }),
        );
      }
      const state = this.blocks.get(event.key);
      if (state?.closed) return out;
      if (event.deltaType === 'thinking') {
        state.thinking += event.delta;
        out.push(
          encodeSse('content_block_delta', {
            type: 'content_block_delta',
            index: state.index,
            delta: { type: 'thinking_delta', thinking: event.delta },
          }),
        );
      } else if (event.deltaType === 'text') {
        state.text += event.delta;
        out.push(
          encodeSse('content_block_delta', {
            type: 'content_block_delta',
            index: state.index,
            delta: { type: 'text_delta', text: event.delta },
          }),
        );
      } else if (event.deltaType === 'json') {
        state.partialJson += event.delta;
        out.push(
          encodeSse('content_block_delta', {
            type: 'content_block_delta',
            index: state.index,
            delta: { type: 'input_json_delta', partial_json: event.delta },
          }),
        );
      }
    } else if (event.type === 'block_stop') {
      out.push(...this.stopBlock(event.key, event.signature));
    } else if (event.type === 'usage') {
      this.usage = mergeUsage(this.usage, event.usage);
    } else if (event.type === 'message_done') {
      this.stopReason = event.stopReason ?? inferStopReason(this.blocks);
      out.push(...this.finish());
    } else if (event.type === 'error') {
      this.finished = true;
      out.push(encodeSse('error', anthropicErrorBody(event.error)));
    }
    return out;
  }

  startBlock(event) {
    if (this.blocks.has(event.key)) return [];
    const index = this.nextIndex++;
    const kind = event.kind;
    const state = {
      key: event.key,
      index,
      kind,
      id: event.id,
      name: event.name,
      text: '',
      thinking: '',
      partialJson: '',
      signature: event.signature ?? '',
      closed: false,
    };
    this.blocks.set(event.key, state);
    let contentBlock;
    if (kind === 'thinking') contentBlock = { type: 'thinking', thinking: '', signature: '' };
    else if (kind === 'text') contentBlock = { type: 'text', text: '' };
    else if (kind === 'tool') {
      contentBlock = {
        type: 'tool_use',
        id: event.id ?? randomId('toolu'),
        name: event.name ?? 'tool',
        input: {},
      };
      state.id = contentBlock.id;
      state.name = contentBlock.name;
    } else {
      throw new ProxyError(`Unsupported normalized block kind ${kind}`, { status: 502 });
    }
    return [
      encodeSse('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: contentBlock,
      }),
    ];
  }

  stopBlock(key, signature) {
    const state = this.blocks.get(key);
    if (!state || state.closed) return [];
    state.closed = true;
    const out = [];
    if (state.kind === 'thinking') {
      if (typeof signature === 'string' && signature) state.signature = signature;
      if (!state.signature) state.signature = thinkingSignature(this.messageId, state.index);
      out.push(
        encodeSse('content_block_delta', {
          type: 'content_block_delta',
          index: state.index,
          delta: { type: 'signature_delta', signature: state.signature },
        }),
      );
    }
    out.push(encodeSse('content_block_stop', { type: 'content_block_stop', index: state.index }));
    return out;
  }

  finish() {
    if (this.finished) return [];
    const out = [];
    for (const key of this.blocks.keys()) out.push(...this.stopBlock(key));
    this.finished = true;
    const stopReason = this.stopReason ?? inferStopReason(this.blocks);
    out.push(
      encodeSse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: {
          output_tokens: this.usage.output_tokens,
          ...(this.usage.input_tokens ? { input_tokens: this.usage.input_tokens } : {}),
          ...(this.usage.cache_read_input_tokens
            ? { cache_read_input_tokens: this.usage.cache_read_input_tokens }
            : {}),
        },
      }),
    );
    out.push(encodeSse('message_stop', { type: 'message_stop' }));
    return out;
  }

  toMessage() {
    const content = [...this.blocks.values()]
      .sort((a, b) => a.index - b.index)
      .map((state) => {
        if (state.kind === 'thinking') {
          return {
            type: 'thinking',
            thinking: state.thinking,
            signature: state.signature || thinkingSignature(this.messageId, state.index),
          };
        }
        if (state.kind === 'text') return { type: 'text', text: state.text };
        let input = {};
        if (state.partialJson.trim()) {
          try {
            input = JSON.parse(state.partialJson);
          } catch {
            input = { _raw: state.partialJson };
          }
        }
        return { type: 'tool_use', id: state.id, name: state.name, input };
      });
    return {
      id: this.messageId,
      type: 'message',
      role: 'assistant',
      model: this.responseModel,
      content,
      stop_reason: this.stopReason ?? inferStopReason(this.blocks),
      stop_sequence: null,
      usage: this.usage,
    };
  }
}

/**
 * Accumulate normalized provider events into a non-streaming Anthropic message.
 * @param {AsyncIterable<NormalizedEvent>} events
 * @param {{requestModel: string, responseModel?: string}} options
 */
export async function accumulateAnthropicMessage(events, options) {
  const encoder = new AnthropicEventEncoder(options);
  for await (const event of events) {
    if (event.type === 'error') throw normalizeError(event.error);
    encoder.apply(event);
  }
  if (!encoder.finished) encoder.finish();
  return encoder.toMessage();
}


export function thinkingSignature(messageId, index) {
  return Buffer.from(`ccp:api-key:v1:${messageId}:${index}`, 'utf8').toString('base64url');
}

function inferStopReason(blocks) {
  for (const block of blocks.values()) if (block.kind === 'tool') return 'tool_use';
  return 'end_turn';
}

export function normalizeStopReason(reason) {
  const normalized = String(reason ?? '').toLowerCase();
  if (['tool_use', 'tool_calls', 'function_call'].includes(normalized)) return 'tool_use';
  if (['length', 'max_tokens', 'max_output_tokens', 'incomplete'].includes(normalized)) return 'max_tokens';
  if (['stop_sequence'].includes(normalized)) return 'stop_sequence';
  if (['content_filter', 'safety'].includes(normalized)) return 'refusal';
  return 'end_turn';
}

function normalizeUsage(usage = {}) {
  return {
    input_tokens: numberOrZero(usage.input_tokens),
    output_tokens: numberOrZero(usage.output_tokens),
    cache_creation_input_tokens: numberOrZero(usage.cache_creation_input_tokens),
    cache_read_input_tokens: numberOrZero(usage.cache_read_input_tokens),
  };
}

function mergeUsage(current, next) {
  const normalized = normalizeUsage(next);
  return {
    input_tokens: normalized.input_tokens || current.input_tokens,
    output_tokens: normalized.output_tokens || current.output_tokens,
    cache_creation_input_tokens:
      normalized.cache_creation_input_tokens || current.cache_creation_input_tokens,
    cache_read_input_tokens: normalized.cache_read_input_tokens || current.cache_read_input_tokens,
  };
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable content]';
  }
}

/**
 * @typedef {{type:'block_start',key:string,kind:'thinking'|'text'|'tool',id?:string,name?:string}
 * | {type:'block_delta',key:string,deltaType:'thinking'|'text'|'json',delta:string,id?:string,name?:string}
 * | {type:'block_stop',key:string,signature?:string}
 * | {type:'usage',usage:{input_tokens?:number,output_tokens?:number,cache_creation_input_tokens?:number,cache_read_input_tokens?:number}}
 * | {type:'message_done',stopReason?:string}
 * | {type:'error',error:unknown}} NormalizedEvent
 */

