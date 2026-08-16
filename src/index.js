/**
 * Plugin entry: registers the `llm/stream` observer, session cleanup, and the
 * `/cache-check` command. This file is the function body's tail of the bundle;
 * every constant and function it references is defined in the earlier modules.
 */

return {
  name: 'deepseek-cache-check',

  /**
   * Cordis plugin apply hook.
   *
   * @param {object} ctx - The Cordis context (preset standing scope).
   * @returns {void}
   */
  apply(ctx) {
    const llm = ctx.get('llm')
    if (!llm) return
    // Observe every real request (and probe request), recording per-session
    // the most recent real request's prefix and usage.
    ctx.on('llm/stream', __captureStream)
    // Reclaim a session's recorded state when it is disposed, so the state
    // maps do not grow without bound.
    ctx.on('session/disposed', (session) => {
      if (session && session.id !== undefined) __dropSession(session.id)
    })
    // Register /cache-check (config injected as __CONFIG__).
    __registerCommand(ctx, __CONFIG__)
  }
}
