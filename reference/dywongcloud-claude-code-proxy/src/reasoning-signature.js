const PREFIX = 'ccp:openai:v1:';
const MAX_SIGNATURE_BYTES = 4 * 1024 * 1024;

/**
 * Wrap an OpenAI Responses reasoning item in Claude's opaque thinking
 * signature field so a later stateless tool turn can replay it exactly.
 *
 * @param {any} item
 * @param {string|undefined} model
 * @returns {string|undefined}
 */
export function encodeOpenAIReasoningSignature(item, model) {
  const reasoning = sanitizeReasoningItem(item);
  if (!reasoning) return undefined;
  const envelope = {
    version: 1,
    provider: 'openai',
    model: typeof model === 'string' && model ? model : undefined,
    item: reasoning,
  };
  const json = JSON.stringify(envelope);
  if (Buffer.byteLength(json, 'utf8') > MAX_SIGNATURE_BYTES) return undefined;
  return `${PREFIX}${Buffer.from(json, 'utf8').toString('base64url')}`;
}

/**
 * Recover a reasoning item emitted by this proxy. Foreign, malformed,
 * oversized, or model-mismatched signatures are ignored rather than sent
 * upstream.
 *
 * @param {unknown} signature
 * @param {{model?:string}} [options]
 * @returns {any|undefined}
 */
export function decodeOpenAIReasoningSignature(signature, options = {}) {
  if (typeof signature !== 'string' || !signature.startsWith(PREFIX)) return undefined;
  if (Buffer.byteLength(signature, 'utf8') > MAX_SIGNATURE_BYTES * 2) return undefined;
  try {
    const json = Buffer.from(signature.slice(PREFIX.length), 'base64url').toString('utf8');
    if (Buffer.byteLength(json, 'utf8') > MAX_SIGNATURE_BYTES) return undefined;
    const envelope = JSON.parse(json);
    if (envelope?.version !== 1 || envelope?.provider !== 'openai') return undefined;
    if (
      options.model &&
      typeof envelope.model === 'string' &&
      envelope.model !== options.model
    ) {
      return undefined;
    }
    return sanitizeReasoningItem(envelope.item);
  } catch {
    return undefined;
  }
}

function sanitizeReasoningItem(item) {
  if (!item || typeof item !== 'object' || item.type !== 'reasoning') return undefined;
  if (typeof item.id !== 'string' || item.id.length === 0 || item.id.length > 512) return undefined;
  if (typeof item.encrypted_content !== 'string' || item.encrypted_content.length === 0) return undefined;

  const summary = Array.isArray(item.summary)
    ? item.summary
        .filter((part) => part?.type === 'summary_text' && typeof part.text === 'string')
        .map((part) => ({ type: 'summary_text', text: part.text }))
    : [];
  const content = Array.isArray(item.content)
    ? item.content
        .filter((part) => part?.type === 'reasoning_text' && typeof part.text === 'string')
        .map((part) => ({ type: 'reasoning_text', text: part.text }))
    : undefined;

  return {
    type: 'reasoning',
    id: item.id,
    summary,
    encrypted_content: item.encrypted_content,
    ...(content?.length ? { content } : {}),
  };
}

