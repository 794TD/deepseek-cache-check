/**
 * Per-session capture of the most recent real model request and its usage.
 *
 * Attached to the `llm/stream` waterfall as a passive observer: it never
 * mutates the request, never intercepts the response, and only records state.
 *
 * State is keyed by `sessionId` because a DSH preset is mounted once per
 * process (a standing scope) while `llm/stream` observes every session's
 * requests. Without per-session keying, `/cache-check` in one session would
 * probe another session's prefix.
 *
 * Probe requests are identified precisely through the `__probeRequests`
 * WeakSet (instead of a process-wide boolean), so a probe running in one
 * session never causes real requests in other sessions to be dropped.
 *
 * Only ordinary conversation requests are recorded (`sessionId` present and
 * `purpose` unset, which excludes compaction / session-title auxiliary calls),
 * and only once a `usage` chunk arrives, so failed or aborted requests never
 * overwrite the last successful record.
 */

/** sessionId -> last ordinary conversation request snapshot. */
const __lastRequest = new Map()
/** sessionId -> last ordinary conversation usage. */
const __lastUsage = new Map()
/** Probe request options currently in flight. */
const __probeRequests = new WeakSet()

/**
 * `llm/stream` waterfall listener.
 *
 * Records the request snapshot for ordinary conversation requests and wraps
 * the downstream stream to capture its `usage` chunk.
 *
 * @param {object} options - The fully assembled request (GenerateOptions).
 * @param {() => AsyncIterable<object>} next - Innermost continuation that
 *   produces the adapter stream.
 * @returns {AsyncIterable<object>} The downstream stream, wrapped only when
 *   this request is an ordinary conversation request worth observing.
 */
function __captureStream(options, next) {
  const isProbe = __probeRequests.has(options)
  const sessionId = options.sessionId
  // Ordinary conversation request: not a probe, carries a sessionId, and is
  // not an auxiliary call (compaction / session-title).
  const shouldObserve = !isProbe && sessionId !== undefined && options.purpose === undefined

  const stream = next()
  if (!shouldObserve) return stream

  // Keep only the scalar/array leaves needed to build a probe, avoiding any
  // extra live object references.
  const snapshot = {
    provider: options.provider,
    model: options.model,
    system: options.system,
    messages: Array.isArray(options.messages) ? options.messages.slice() : [],
    tools: Array.isArray(options.tools) ? options.tools.slice() : undefined,
    temperature: options.temperature,
    stop: options.stop,
    reasoningEffort: options.reasoningEffort
  }

  /**
   * Wraps the downstream stream to record its `usage` chunk as it is consumed.
   *
   * @returns {AsyncIterable<object>} The wrapped stream that yields every
   *   downstream chunk unchanged while committing this request's usage once it
   *   is observed.
   */
  return (async function* __observed() {
    try {
      for await (const chunk of stream) {
        // `usage` always precedes `finish` (adapter guarantee); only commit the
        // record here, so a failed or aborted request leaves no trace.
        if (chunk && chunk.type === 'usage') {
          __lastRequest.set(sessionId, snapshot)
          __lastUsage.set(sessionId, chunk.usage)
        }
        yield chunk
      }
    } finally {
      if (stream && typeof stream.return === 'function') stream.return()
    }
  })()
}

/**
 * Return the last recorded conversation request snapshot for a session.
 *
 * @param {string | undefined} sessionId - The session identity.
 * @returns {object | null} The snapshot, or `null` when unknown or absent.
 */
function __getLastRequest(sessionId) {
  if (sessionId === undefined) return null
  const request = __lastRequest.get(sessionId)
  if (request === undefined) return null
  return request
}

/**
 * Return the last recorded conversation usage for a session.
 *
 * @param {string | undefined} sessionId - The session identity.
 * @returns {object | null} The usage, or `null` when unknown or absent.
 */
function __getLastUsage(sessionId) {
  if (sessionId === undefined) return null
  const usage = __lastUsage.get(sessionId)
  if (usage === undefined) return null
  return usage
}

/**
 * Drop all recorded state for a session (called on `session/disposed`).
 *
 * @param {string | undefined} sessionId - The session identity to forget.
 * @returns {void}
 */
function __dropSession(sessionId) {
  if (sessionId === undefined) return
  __lastRequest.delete(sessionId)
  __lastUsage.delete(sessionId)
}
