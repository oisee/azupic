/**
 * Conservative local token estimate for Claude Code's preflight endpoint.
 * It intentionally overweights CJK, emoji, punctuation, JSON and tool schema
 * content so compaction happens before the real upstream context limit.
 */
export function estimateAnthropicTokens(body) {
  let total = 8;
  total += estimateText(extractSystemText(body.system));
  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    total += 4;
    total += estimateContent(message?.content);
  }
  for (const tool of Array.isArray(body.tools) ? body.tools : []) {
    total += 12;
    total += estimateText(tool?.name ?? '');
    total += estimateText(tool?.description ?? '');
    total += estimateText(safeJson(tool?.input_schema ?? {}));
  }
  if (body.output_config) total += estimateText(safeJson(body.output_config));
  return Math.max(1, Math.ceil(total));
}

function estimateContent(content) {
  if (typeof content === 'string') return estimateText(content);
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' || block.type === 'thinking') total += estimateText(block.text ?? block.thinking ?? '');
    else if (block.type === 'tool_use') total += 8 + estimateText(block.name ?? '') + estimateText(safeJson(block.input ?? {}));
    else if (block.type === 'tool_result') total += 8 + estimateContent(block.content);
    else if (block.type === 'image') total += estimateImage(block.source);
    else total += estimateText(safeJson(block));
  }
  return total;
}

function estimateImage(source) {
  if (!source || typeof source !== 'object') return 1024;
  if (source.type === 'base64' && typeof source.data === 'string') {
    // A conservative approximation of vision patches, bounded to prevent a
    // huge data URL from dominating the count linearly.
    return Math.min(8192, Math.max(256, Math.ceil(source.data.length / 1024) * 85));
  }
  return 1024;
}

export function estimateText(text) {
  if (!text) return 0;
  let weighted = 0;
  for (const char of String(text)) {
    const code = char.codePointAt(0);
    if (code <= 0x7f) {
      if (/\s/.test(char)) weighted += 0.2;
      else if (/[A-Za-z0-9]/.test(char)) weighted += 0.25;
      else weighted += 0.55;
    } else if (
      (code >= 0x3400 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      weighted += 1.15;
    } else if (code > 0xffff) {
      weighted += 1.8;
    } else {
      weighted += 0.75;
    }
  }
  return Math.ceil(weighted);
}

function extractSystemText(system) {
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system.map((block) => (block?.type === 'text' ? block.text ?? '' : '')).join('\n');
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

