/**
 * Reconstruct the most recent real request from a live session's durable log.
 *
 * `__lastRequest` only records requests that flow through `llm/stream` in THIS
 * process. A resumed ("old") conversation loads its history from storage, so on
 * the first `/cache-check` before any new turn the in-memory capture is empty.
 *
 * DSH persists every request in reconstructable form, so the same facts the
 * capture observer would have recorded can be rebuilt from the session:
 * - `session.deriveMessages()`     -> the exact ordered message history
 * - `session.requestHeader()`      -> the latest folded request/header snapshot
 *                                    (provider/model/system/tools/sampling)
 * - `session.requestContext()`     -> the latest route metadata (fallback)
 * - the last `assistant/message`   -> the most recent token usage (fallback)
 */

/**
 * Return the most recent assistant usage recorded in a session log.
 *
 * Scans backwards so a long conversation costs O(tail) and always returns the
 * latest successful step's accounting, even across process restarts.
 *
 * @param {object} session - The live session (`invocation.agent.session`).
 * @returns {object | null} The last `usage` payload, or `null` when none.
 */
function __lastUsageFromSession(session) {
  const events = session.events
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event && event.type === 'assistant/message' && event.data && event.data.usage) {
      return event.data.usage
    }
  }
  return null
}

/**
 * Rebuild the last real request snapshot from a live session.
 *
 * The returned object has the same shape as the capture observer's snapshot
 * (`provider/model/system/messages/tools/temperature/stop/reasoningEffort`), so
 * `__buildProbeRequest` consumes it unchanged.
 *
 * @param {object} session - The live session to reconstruct from.
 * @param {object | undefined} agentOptions - `agent.options` fallback for the
 *   provider/model route when no request header or route context exists yet.
 * @returns {object | null} The reconstructed snapshot, or `null` when the
 *   session has no message history or no resolvable provider/model route.
 */
function __reconstructRequest(session, agentOptions) {
  const messages = session.deriveMessages()
  if (!messages.length) return null

  const header = session.requestHeader()
  const context = session.requestContext()
  const config = header && header.config ? header.config : {}
  const opts = agentOptions || {}

  const provider = config.provider || (context && context.provider) || opts.provider
  const model = config.model || (context && context.model) || opts.model
  if (!provider || !model) return null

  return {
    provider: provider,
    model: model,
    system: header ? header.system : undefined,
    messages: messages,
    tools: header ? header.tools : undefined,
    temperature: config.temperature,
    stop: config.stop,
    reasoningEffort: config.reasoningEffort
  }
}
