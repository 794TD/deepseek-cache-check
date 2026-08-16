#!/usr/bin/env node
// ---------------------------------------------------------------------------
// migrate-legacy-preset.mjs — 修复「旧会话无法恢复」：
//
//   旧版 cache-check 是作为 **agent preset** 安装的，会话头里写死了
//   `agentPreset: "cache-check"`。改为主机面插件后，install.mjs 的
//   cleanupLegacyPreset 删掉了这个 preset、并把 settings.yaml 默认值回退到
//   standard，但**没有回写已存在会话头里的 agentPreset**。于是 DSH 恢复这些
//   旧会话时找不到 `cache-check` preset，直接报：
//
//     agent-presets: preset "cache-check" not found
//
//   本脚本扫描 `<DSH_HOME>/sessions/**/session.jsonl(.zstd)`，把会话头里的
//   `agentPreset` 从旧 preset 迁移到目标 preset（默认 cache-check -> standard），
//   只重写**第一个帧（header 帧）**，其余事件帧逐字节保留。
//
// 用法：
//   node migrate-legacy-preset.mjs               # 迁移 cache-check -> standard
//   node migrate-legacy-preset.mjs --dry-run     # 只报告，不写盘
//   node migrate-legacy-preset.mjs --from X --to Y
//
// 依赖：仅 Node 内置模块（node:zlib 的 zstd + node:fs）。
// ---------------------------------------------------------------------------

import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  existsSync
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib'

const ZSTD_MAGIC = 4247762216 // 0xFD2FB528 as little-endian uint32
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

function printHelp() {
  console.log(`migrate-legacy-preset.mjs — 回写旧会话头里的 agentPreset

用法:
  node migrate-legacy-preset.mjs [options]

选项:
  --from <preset>  要迁移的旧 preset（默认 cache-check）
  --to <preset>    迁移目标 preset（默认 standard）
  --dry-run        只报告将改哪些会话，不写盘
  -h, --help       显示本帮助
`)
}

function parseArgs(argv) {
  const args = { from: 'cache-check', to: 'standard', dryRun: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--from') args.from = argv[++i]
    else if (a === '--to') args.to = argv[++i]
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0) }
    else throw new Error(`unknown argument: ${a}`)
  }
  if (!args.from || !args.to) throw new Error('--from/--to 不能为空')
  return args
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * 定位 Zstandard 拼接帧容器里每个完整帧的字节区间。
 * 与 @deepseek-ai/dsh-session-persistence-jsonl 的 scanZstdFrames 逐字节一致：
 * 只做结构扫描、不解压，最终帧不完整时返回其起点。
 *
 * @param {Buffer} buffer - 文件完整字节。
 * @returns {{ frames: {start:number,end:number}[], tornStart?: number }}
 */
function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag)
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

/**
 * 迁移单个会话日志：只重写第一个帧（header 帧），其余帧字节级保留。
 *
 * @param {string} logPath - session.jsonl(.zstd) 绝对路径。
 * @param {string} fromPreset - 要替换掉的旧 preset。
 * @param {string} toPreset - 替换成的目标 preset。
 * @param {boolean} dryRun - 为 true 时只返回动作、不写盘。
 * @returns {string} 结果标记（migrated / would-migrate / 及各类跳过原因）。
 */
function migrateLog(logPath, fromPreset, toPreset, dryRun) {
  const buf = readFileSync(logPath)
  const { frames } = scanZstdFrames(buf)
  if (!frames.length) return 'skip:no-frames'

  const first = frames[0]
  let headerText
  try {
    headerText = zstdDecompressSync(buf.subarray(first.start, first.end)).toString('utf8')
  } catch (err) {
    return 'skip:bad-first-frame:' + (err && err.message ? err.message : err)
  }

  // 会话头是第一个 JSONL 记录（首行）。
  const nl = headerText.indexOf('\n')
  const headerLine = nl >= 0 ? headerText.slice(0, nl) : headerText
  let parsed
  try {
    parsed = JSON.parse(headerLine)
  } catch {
    return 'skip:bad-header-json'
  }
  if (parsed.type !== 'session') return 'skip:not-session'
  if (parsed.agentPreset !== fromPreset) return 'skip:preset=' + (parsed.agentPreset || '(none)')

  if (dryRun) return 'would-migrate'

  // 定向替换，保留首行其余字节原样；重压缩为带校验的独立 zstd 帧（与 DSH 一致）。
  const newHeaderLine = headerLine.replace(`"agentPreset":"${fromPreset}"`, `"agentPreset":"${toPreset}"`)
  const newHeaderText = nl >= 0 ? newHeaderLine + headerText.slice(nl) : newHeaderLine
  const newFrame = zstdCompressSync(newHeaderText, CHECKSUM_OPTIONS)

  // 写回前留一份 `.bak` 备份。
  const bakPath = logPath + '.bak'
  if (!existsSync(bakPath)) writeFileSync(bakPath, buf)

  writeFileSync(logPath, Buffer.concat([newFrame, buf.subarray(first.end)]))
  return 'migrated'
}

/**
 * 递归收集某个目录下所有 session.jsonl / session.jsonl.zstd。
 *
 * @param {string} root - sessions 根目录。
 * @returns {string[]} 日志文件绝对路径。
 */
function collectSessionLogs(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full)
      else if (name === 'session.jsonl' || name === 'session.jsonl.zstd') out.push(full)
    }
  }
  walk(root)
  return out
}

/**
 * 迁移 DSH home 下所有会话头里的旧 preset。
 *
 * @param {string} home - DSH home 目录（~/.dsh 或 $DSH_HOME）。
 * @param {{ from?: string, to?: string, dryRun?: boolean }} opts
 * @returns {{ logs: {path:string, result:string}[], migrated:number }}
 */
export function migrateLegacyPreset(home, opts = {}) {
  const fromPreset = opts.from || 'cache-check'
  const toPreset = opts.to || 'standard'
  const dryRun = !!opts.dryRun

  const sessionsRoot = join(home, 'sessions')
  const logs = collectSessionLogs(sessionsRoot).map((path) => {
    let result
    try {
      result = migrateLog(path, fromPreset, toPreset, dryRun)
    } catch (err) {
      result = 'error:' + (err && err.message ? err.message : err)
    }
    return { path, result }
  })

  const migrated = logs.filter((l) => l.result === 'migrated' || l.result === 'would-migrate').length
  return { logs, migrated }
}

// --- CLI 入口 -------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = parseArgs(process.argv.slice(2))
    const home = dshHome()
    const { logs, migrated } = migrateLegacyPreset(home, args)

    for (const { path, result } of logs) {
      if (result === 'migrated') console.log(`✔ ${result}  ${path}`)
      else if (result === 'would-migrate') console.log(`• ${result}  ${path}`)
      else console.log(`- ${result}  ${path}`)
    }
    console.log(`\n${args.dryRun ? 'dry-run' : '完成'}：${migrated} 个会话需要迁移（from=${args.from} -> to=${args.to}）。`)
  } catch (err) {
    console.error('\n❌ 迁移失败: ' + (err && err.message ? err.message : err))
    process.exit(1)
  }
}
