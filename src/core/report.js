/**
 * Formats probe usage into a human-readable report.
 */

/**
 * Render a finish reason as a short human-readable label.
 *
 * @param {object | undefined} reason - The stream `finish` reason.
 * @returns {string} A localized label describing why generation stopped.
 */
function __finishLabel(reason) {
  if (!reason) return '未知'
  if (reason.kind === 'stop') return '正常结束'
  if (reason.kind === 'max-tokens') return '达到最大输出 token'
  if (reason.kind === 'error') {
    let failureMessage = '未知'
    if (reason.failure && reason.failure.message) failureMessage = reason.failure.message
    return '错误: ' + failureMessage
  }
  return reason.kind
}

/**
 * Turn a probe outcome into a command result object.
 *
 * @param {object} result - `{ mode, usage, finish, lastUsage, error? }`.
 * @returns {{ kind: 'success', text: string } | { kind: 'error', text: string }}
 *   The rendered report as a slash-command result.
 */
function __formatReport(result) {
  if (result.error) {
    return { kind: 'error', text: '探针执行失败: ' + result.error }
  }
  const u = result.usage
  if (!u) {
    return { kind: 'error', text: '探针未返回 usage（可能被上游终止或超时）。' }
  }
  const hit = u.cacheReadTokens || 0
  const miss = u.inputTokens || 0
  const total = hit + miss
  const ratio = total > 0 ? hit / total : 0
  const pct = (ratio * 100).toFixed(1)

  let verdict
  if (hit === 0) verdict = '❌ 缓存已失效（前缀完全未命中）'
  else if (ratio >= 0.9) verdict = '✅ 缓存存活（头部几乎完整命中）'
  else if (ratio >= 0.5) verdict = '🟡 缓存部分存活（头部命中，尾部已失效）'
  else verdict = '🟠 缓存大部分失效（仅少量命中）'

  const lines = [
    'DeepSeek 缓存探针结果（mode=' + result.mode + '）',
    '- 前缀 token 总数：' + total,
    '- 缓存命中：' + hit + ' token（' + pct + '%）',
    '- 缓存未命中：' + miss + ' token',
    '- 结束原因：' + __finishLabel(result.finish),
    '- 结论：' + verdict,
    ''
  ]
  const last = result.lastUsage
  if (last) {
    const lh = last.cacheReadTokens || 0
    const lm = last.inputTokens || 0
    const lt = lh + lm
    if (lt > 0) lines.push('（参考：最近一次真实请求命中 ' + lh + '/' + lt + ' token）')
  }
  return { kind: 'success', text: lines.join('\n') }
}
