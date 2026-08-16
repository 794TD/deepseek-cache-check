/**
 * Builds and runs a cache probe against the DeepSeek prefix cache.
 *
 * DeepSeek caches the leading blocks of the request prompt. A probe replays the
 * prefix of the most recent real request (system + the first N history
 * messages), appends a random nonce user message so the request stays unique
 * while the prefix stays byte-identical, caps `maxTokens` at 1, and reads back
 * `usage.cacheReadTokens` / `usage.inputTokens`.
 *
 * - `light`: system + the first `lightMessageCount` messages (cheap; answers
 *   "is the cache engine still serving this conversation?").
 * - `full`:  system + the entire history (precise per-block, but pricier).
 */

/**
 * Generate a random alphanumeric nonce of the requested length.
 *
 * @param {number} len - Desired nonce length in characters.
 * @returns {string} The nonce, exactly `len` characters long.
 */
function __randomNonce(len) {
  let s = ''
  while (s.length < len) s += Math.random().toString(36).slice(2)
  return s.slice(0, len)
}

/**
 * Whether a message is an assistant turn that requested tool calls.
 *
 * @param {object | undefined} message - The message to inspect.
 * @returns {boolean} `true` when the message is an assistant message carrying
 *   at least one `tool-call` block.
 */
function __hasToolCall(message) {
  return message && message.role === 'assistant' &&
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === 'tool-call')
}

/**
 * Whether a message is a user turn carrying tool results.
 *
 * @param {object | undefined} message - The message to inspect.
 * @returns {boolean} `true` when the message is a user message carrying at
 *   least one `tool-result` block.
 */
function __isToolResult(message) {
  return message && message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === 'tool-result')
}

/**
 * Whether a message is DSH's injected dynamic runtime-context snapshot.
 *
 * DSH appends a "Current runtime context. This snapshot supersedes earlier
 * runtime-context snapshots." user message every step whose rendered context
 * changed. It is the single most dynamic part of the prompt (regenerated each
 * step), so a light probe that replays it is measuring context churn rather
 * than whether the conversation's prefix cache is still alive.
 *
 * @param {object | undefined} message - The message to inspect.
 * @returns {boolean} `true` when the message was injected by the system-prompt
 *   runtime-context projection.
 */
function __isRuntimeContextSnapshot(message) {
  return message && message.source &&
    message.source.kind === 'plugin' &&
    message.source.plugin === '@deepseek-ai/dsh-system-prompt'
}

/**
 * Compute the `light` prefix length, adjusted to a safe truncation boundary.
 *
 * If the requested cut lands on an assistant tool-call turn, extend it over the
 * immediately following tool-result messages so the replayed prefix never ends
 * with "assistant tool_calls without matching tool results", which the provider
 * would reject.
 *
 * @param {object[]} messages - The conversation history to slice.
 * @param {object} cfg - The probe config (uses `lightMessageCount`).
 * @returns {number} The number of leading messages to replay.
 */
function __lightCount(messages, cfg) {
  const total = messages.length
  // Stop before the first injected runtime-context snapshot: that block is
  // regenerated every step, so it is the least cacheable part of the prompt.
  // Replaying it turns "is the cache alive?" into "did the runtime context
  // change since the last request?", which is exactly the light/full mismatch
  // observed in long conversations. The stable head (system + the leading real
  // messages before the first snapshot) is the cheap signal we actually want.
  let stable = total
  for (let i = 0; i < total; i++) {
    if (__isRuntimeContextSnapshot(messages[i])) {
      stable = i
      break
    }
  }
  let count = Math.min(cfg.lightMessageCount, stable, total)
  if (count > 0 && count < total && __hasToolCall(messages[count - 1])) {
    while (count < total && __isToolResult(messages[count])) count++
  }
  return count
}

/**
 * Assemble a probe request from the last recorded real request.
 *
 * @param {object} last - The captured snapshot (provider/model/system/messages/
 *   tools/sampling fields).
 * @param {'light' | 'full'} mode - Which prefix length to replay.
 * @param {object} cfg - The probe config.
 * @returns {object} A fully assembled request object (GenerateOptions shape).
 */
function __buildProbeRequest(last, mode, cfg) {
  const total = last.messages.length
  const count = mode === 'full' ? total : __lightCount(last.messages, cfg)
  const prefix = last.messages.slice(0, count)
  const nonce = __randomNonce(cfg.nonceLength)
  const messages = prefix.concat([{
    // Fill in the Message contract's id/source; adapters only read role/content
    // when serializing, but this keeps stricter consumers happy too.
    id: 'cache-check-probe:' + nonce,
    role: 'user',
    content: [{ type: 'text', text: nonce }],
    source: { kind: 'plugin', plugin: 'deepseek-cache-check' }
  }])
  return {
    provider: last.provider,
    model: last.model,
    system: last.system,
    messages: messages,
    tools: last.tools,
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
    stop: last.stop,
    reasoningEffort: last.reasoningEffort
  }
}

/**
 * Run a probe request to completion, collecting its usage and finish reason.
 *
 * Marks the request in `__probeRequests` so the capture observer skips it and
 * never pollutes the "most recent real request" record.
 *
 * @param {object} llm - The LLM runtime with a `stream(options)` method.
 * @param {object} options - The assembled probe request.
 * @returns {Promise<{ usage: object | null, finish: object | null }>} The last
 *   `usage` chunk and the `finish` reason observed, either of which may be null.
 */
async function __runProbe(llm, options) {
  let usage = null
  let finish = null
  __probeRequests.add(options)
  try {
    for await (const chunk of llm.stream(options)) {
      if (chunk && chunk.type === 'usage') usage = chunk.usage
      else if (chunk && chunk.type === 'finish') finish = chunk.reason
    }
  } finally {
    __probeRequests.delete(options)
  }
  return { usage, finish }
}
