/**
 * Registers the `/cache-check` slash command and parses its `full` argument.
 */

/**
 * Parse the command's free-form input into a probe mode.
 *
 * @param {string} rawInput - The exact text after the command name.
 * @returns {'light' | 'full'} `full` when the input is exactly `full`
 *   (case/whitespace-insensitive), otherwise `light`.
 */
function __parseMode(rawInput) {
  const s = String(rawInput || '').trim().toLowerCase()
  return s === 'full' ? 'full' : 'light'
}

/**
 * Register the `/cache-check` command on the commands registry.
 *
 * @param {object} ctx - The Cordis context providing `commands` and `llm`.
 * @param {object} cfg - The injected config (`__CONFIG__`).
 * @returns {void}
 */
function __registerCommand(ctx, cfg) {
  const commands = ctx.get('commands')
  if (!commands) return
  commands.register({
    name: cfg.command.name,
    description: cfg.command.description,
    input: { hint: cfg.command.inputHint },
    handler: async (invocation) => {
      // Resolve this session's state: with many sessions in one process, the
      // probe must never read another session's prefix.
      const agent = invocation.agent
      const sessionId = agent && agent.id
      const session = agent && agent.session
      let last = __getLastRequest(sessionId)
      let lastUsage = __getLastUsage(sessionId)
      // A resumed ("old") conversation has its history in the durable log but
      // no in-memory capture yet in this process. Rebuild the last request from
      // the session so /cache-check works before the next real turn runs.
      if (!last && session) {
        try {
          last = __reconstructRequest(session, agent.options)
          if (last && !lastUsage) lastUsage = __lastUsageFromSession(session)
        } catch (_err) {
          last = null
        }
      }
      if (!last) {
        return {
          kind: 'error',
          text: '暂无历史请求可测：当前会话还没有真实请求经过。请先正常对话一轮，再运行 /' + cfg.command.name + '。'
        }
      }
      const llm = ctx.get('llm')
      if (!llm) {
        return { kind: 'error', text: 'llm 服务不可用。' }
      }
      const mode = __parseMode(invocation.rawInput)
      const options = __buildProbeRequest(last, mode, cfg.probe)
      options.signal = invocation.signal
      // Attribute the probe to this session (provider-side only; it does not
      // affect prefix-cache matching).
      options.sessionId = sessionId
      try {
        const { usage, finish } = await __runProbe(llm, options)
        return __formatReport({ mode, usage, finish, lastUsage })
      } catch (err) {
        let message
        if (err && err.message) {
          message = err.message
        } else {
          message = String(err)
        }
        return { kind: 'error', text: '探针执行失败: ' + message }
      }
    }
  })
}
