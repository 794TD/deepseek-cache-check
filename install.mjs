#!/usr/bin/env node
// ---------------------------------------------------------------------------
// install.mjs — 把 deepseek-cache-check 安装为 DSH 的「主机面」插件，
// 使 /cache-check 在所有会话（所有 agent preset）里都可用。
//
// slash 命令与 `llm/stream` 观察都属于主机面能力：只要把插件挂到 profile 的
// cordis.patch.yml（主机面补丁层），而不是某个 agent preset，命令就会全局注册、
// 观察器就会覆盖所有会话的请求。这正是 DSH 自带 /permission、/goal、/compact
// 等全局命令的做法。
//
// 用法：
//   node install.mjs                    # 安装到默认 profile `web`
//   node install.mjs --profile headless  # 安装到指定 profile
//   node install.mjs --force             # 覆盖已存在的同名节点
//
// 做四件事：
//   1. 构建 dist（含 plugin.cjs）
//   2. 把仓库软链到 <profile>/node_modules/deepseek-cache-check
//   3. 在 <profile>/cordis.patch.yml 追加一条 insert 行
//   4. 清理旧版「cache-check preset」安装（如果存在）
//
// 依赖：仅 Node 内置模块，零第三方依赖。
// ---------------------------------------------------------------------------

import { mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync, rmSync, lstatSync, readlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { migrateLegacyPreset } from './migrate-legacy-preset.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = __dirname // install.mjs 位于仓库根

const PLUGIN_NAME = 'deepseek-cache-check' // 包名（软链目录名 + 补丁行 name）
const PLUGIN_ROW_ID = 'cache-check'        // 组合里的行 id
const DEFAULT_PROFILE = 'web'

function printHelp() {
  console.log(`deepseek-cache-check installer

用法:
  node install.mjs [options]

选项:
  --profile <name>  profile 名（默认 ${DEFAULT_PROFILE}）；插件挂在它的 cordis.patch.yml
  --force           覆盖已存在的同名节点（软链/目录）
  -h, --help        显示本帮助
`)
}

function parseArgs(argv) {
  const args = { profile: DEFAULT_PROFILE, force: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--profile') args.profile = argv[++i]
    else if (a === '--force') args.force = true
    else if (a === '-h' || a === '--help') { printHelp(); process.exit(0) }
    else throw new Error(`unknown argument: ${a}`)
  }
  if (!args.profile || args.profile.includes('/') || args.profile.includes('\\') || args.profile === '.' || args.profile === '..') {
    throw new Error(`invalid profile name ${JSON.stringify(args.profile)}`)
  }
  return args
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/**
 * Create (or refresh) the symlink `<nodeModules>/<name>` → `target`.
 * @param {string} nodeModules - The profile's node_modules directory.
 * @param {string} name - Package directory name.
 * @param {string} target - Absolute path the symlink points to.
 * @param {boolean} force - Whether to replace a real (non-symlink) entry.
 */
function ensureSymlink(nodeModules, name, target, force) {
  mkdirSync(nodeModules, { recursive: true })
  const linkPath = join(nodeModules, name)
  const stats = lstatSync(linkPath, { throwIfNoEntry: false })
  if (stats) {
    if (stats.isSymbolicLink()) {
      if (readlinkSync(linkPath) === target) {
        console.log(`  (软链已就绪: ${linkPath})`)
        return
      }
      rmSync(linkPath, { force: true })
    } else if (force) {
      rmSync(linkPath, { recursive: true, force: true })
    } else {
      throw new Error(`${linkPath} 已存在且不是指向本插件的软链；用 --force 覆盖`)
    }
  }
  symlinkSync(target, linkPath, 'dir')
}

/**
 * Append the plugin row to the profile's cordis.patch.yml, idempotently.
 * @param {string} patchPath - Absolute path to the profile's cordis.patch.yml.
 */
function patchProfile(patchPath) {
  let content
  if (existsSync(patchPath)) {
    content = readFileSync(patchPath, 'utf8')
  } else {
    content = '# 主机面补丁层：顶层 YAML 数组（id 定向覆盖、disable、insert 列表）。\n'
  }
  if (content.includes(`id: ${PLUGIN_ROW_ID}`)) {
    console.log('  (cordis.patch.yml 已包含 cache-check，跳过)')
    return
  }
  if (!content.endsWith('\n')) content += '\n'
  content += `\n# ── DeepSeek cache probe（主机面，所有会话可见） ───────────────────────────\n`
  content += `- insert:\n`
  content += `    - id: ${PLUGIN_ROW_ID}\n`
  content += `      name: '${PLUGIN_NAME}'\n`
  content += `      inject: [llm, commands]\n`
  writeFileSync(patchPath, content)
}

/**
 * Remove the legacy preset-based install (the `cache-check` agent preset) and
 * revert its `agent-presets.default` pointer back to `standard`.
 * @param {string} home - The DSH home directory.
 */
function cleanupLegacyPreset(home) {
  const presetDir = join(home, '.agent-presets', PLUGIN_ROW_ID)
  if (existsSync(presetDir)) {
    rmSync(presetDir, { recursive: true, force: true })
    console.log(`  (已移除旧版 agent preset: ${presetDir})`)
  }
  const settingsPath = join(home, 'settings.yaml')
  if (existsSync(settingsPath)) {
    let text = readFileSync(settingsPath, 'utf8')
    if (/default:\s*cache-check/.test(text)) {
      text = text.replace(/default:\s*cache-check/, 'default: standard')
      writeFileSync(settingsPath, text)
      console.log('  (settings.yaml 默认 preset 已回退为 standard)')
    }
  }
  // 旧版 preset 安装会把 `agentPreset: "cache-check"` 写进每个会话头；删掉
  // preset 后这些会话恢复时会报 "preset not found"，必须回写会话头。
  const { migrated } = migrateLegacyPreset(home, { from: PLUGIN_ROW_ID, to: 'standard' })
  if (migrated > 0) console.log(`  (已迁移 ${migrated} 个旧会话头的 agentPreset: ${PLUGIN_ROW_ID} -> standard)`)
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  // 1) 构建
  console.log('▶ [1/4] 构建 dist…')
  execFileSync(process.execPath, [join(root, 'build', 'bundle.js')], { cwd: root, stdio: 'inherit' })

  // 2) 定位 profile
  const home = dshHome()
  const profileDir = join(home, 'profiles', args.profile)
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(profileDir)) {
    throw new Error(`profile "${args.profile}" 不存在于 ${profileDir}；请先运行一次 dsh ${args.profile} 初始化该 profile`)
  }
  console.log(`▶ [2/4] DSH home: ${home}；profile: ${args.profile}`)

  // 3) 软链插件进 profile 的 node_modules
  ensureSymlink(join(profileDir, 'node_modules'), PLUGIN_NAME, root, args.force)
  console.log(`▶ [3/4] 已软链 ${PLUGIN_NAME} → ${root}`)

  // 4) 追加主机面补丁行
  patchProfile(patchPath)
  console.log(`▶ [4/4] 已写入主机面补丁 ${patchPath}`)

  // 5) 清理旧版 preset 安装
  cleanupLegacyPreset(home)

  console.log('\n✅ 安装完成。')
  console.log('   重启 DSH（或等待 profile 补丁热加载）后，/cache-check 会出现在所有会话里。')
  console.log('   若报错，请把上面的 cordis.patch.yml 发来排查。')
}

try {
  main()
} catch (err) {
  console.error('\n❌ 安装失败: ' + (err && err.message ? err.message : err))
  process.exit(1)
}
