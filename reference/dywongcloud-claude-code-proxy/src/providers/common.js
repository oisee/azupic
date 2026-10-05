import { ProxyError } from '../errors.js';

export function mapAnthropicToolChoice(toolChoice) {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === 'string') return toolChoice;
  if (typeof toolChoice !== 'object') throw new ProxyError('tool_choice must be an object', { status: 400 });
  if (toolChoice.type === 'auto') return 'auto';
  if (toolChoice.type === 'none') return 'none';
  if (toolChoice.type === 'any') return 'required';
  if (toolChoice.type === 'tool' && typeof toolChoice.name === 'string') {
    return { type: 'function', name: toolChoice.name };
  }
  throw new ProxyError(`Unsupported tool_choice ${JSON.stringify(toolChoice)}`, { status: 400 });
}

export function parallelToolCalls(toolChoice, explicit) {
  if (typeof explicit === 'boolean') return explicit;
  if (toolChoice && typeof toolChoice === 'object' && typeof toolChoice.disable_parallel_tool_use === 'boolean') {
    return !toolChoice.disable_parallel_tool_use;
  }
  return undefined;
}

export function mapTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description || undefined,
    parameters: tool.input_schema,
    strict: false,
  }));
}

export function mapResponseFormat(outputConfig) {
  const format = outputConfig?.format;
  if (!format) return undefined;
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type === 'json_schema') {
    const schema = format.schema ?? format.json_schema?.schema;
    if (!schema || typeof schema !== 'object') {
      throw new ProxyError('output_config.format json_schema requires a schema object', { status: 400 });
    }
    return {
      type: 'json_schema',
      name: format.name ?? format.json_schema?.name ?? 'response',
      schema,
      strict: format.strict ?? format.json_schema?.strict ?? true,
      description: format.description ?? format.json_schema?.description,
    };
  }
  throw new ProxyError(`Unsupported output_config.format.type ${JSON.stringify(format.type)}`, { status: 400 });
}

export function safeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return undefined;
  const entries = Object.entries(metadata)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 16)
    .map(([key, value]) => [key.slice(0, 64), String(value).slice(0, 512)]);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function normalizeUsageFromOpenAi(usage) {
  if (!usage) return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  return {
    input_tokens: integer(usage.input_tokens ?? usage.prompt_tokens),
    output_tokens: integer(usage.output_tokens ?? usage.completion_tokens),
    cache_read_input_tokens: integer(
      usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens,
    ),
    cache_creation_input_tokens: 0,
  };
}

export function mapReasoningEffort(value, provider) {
  if (!value) return undefined;
  const normalized = String(value).toLowerCase();
  if (provider === 'moonshot') {
    if (['none', 'minimal', 'low'].includes(normalized)) return 'low';
    if (['medium', 'high', 'xhigh'].includes(normalized)) return 'high';
    if (normalized === 'max') return 'max';
    throw new ProxyError(`Moonshot K3 does not support reasoning effort ${JSON.stringify(value)}`, { status: 400 });
  }
  if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(normalized)) return normalized;
  throw new ProxyError(`OpenAI does not support reasoning effort ${JSON.stringify(value)}`, { status: 400 });
}

function integer(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
}

