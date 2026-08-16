# deepseek-cache-check

给 **DeepSeek Harness (DSH)** 用的斜杠命令插件：探测**当前会话**的 DeepSeek 前缀缓存是否还活着。

- `/cache-check` —— 轻量探测（默认）：只重放 system + 前几条历史，便宜。
- `/cache-check full` —— 全量探测：重放整段历史，精确到每一块，更贵。

输出示例：

```
DeepSeek 缓存探针结果（mode=light）
- 前缀 token 总数：5123
- 缓存命中：5089 token（99.3%）
- 缓存未命中：34 token
- 结束原因：正常结束
- 结论：✅ 缓存存活（头部几乎完整命中）
```

## 原理

DeepSeek 是前缀缓存：命中情况经响应的 `usage` 暴露，DSH 归一化为 `cacheReadTokens`（命中）/ `inputTokens`（未命中）。插件经 `llm/stream` 按会话静默记录最近一次真实请求的前缀，探针复用该前缀、追加一条随机 nonce、把 `maxTokens` 压到 1，再读回命中率。前缀与真实请求字节级一致，结果如实反映「那份缓存还在不在」。

对**续接的旧会话**（重启后、或本轮进程还没发过消息）：内存里还没有最近请求，插件会从会话的持久化日志重建同样的前缀——`session.deriveMessages()` 还原消息历史、`session.requestHeader()` 还原 provider/model/system/tools、最近一条 `assistant/message` 还原上次 usage——所以 `/cache-check` 不用先聊一轮也能用。

> **轻量模式为什么在第一条 runtime-context 快照前截断**：DSH 每一步都会把「Current runtime context …」快照以用户消息的形式注入历史，且每次内容变化就追加一条。它是整段前缀里最不稳定、最不缓存友好的部分。若 `light` 照抄头两条消息（通常是 `[第一条用户输入, 第一条 runtime 快照]`），它测的是「运行时上下文变没变」，而不是「会话前缀缓存还在不在」——这正是长对话里 `light` 报 🟠 而 `full` 报 ✅ 的根因。现在 `light` 只重放第一条快照之前的稳定头部（system + 头部真实消息），与 `full` 的头部结论一致。

## 安装

```bash
npm run setup            # 安装到默认 profile `web`（主机面，所有会话可见）
npm run setup:web        # 等价写法
node install.mjs --profile headless   # 安装到指定 profile
```

脚本会：构建 → 把仓库软链进 `<profile>/node_modules/` → 在 `<profile>/cordis.patch.yml` 追加一条主机面 `insert` 行 → 清理旧版 preset 安装，并把**旧会话头里遗留的 `agentPreset: "cache-check"` 迁移为 `standard`**（否则旧会话恢复时报 `preset "cache-check" not found`）。迁移也可单独跑：`node migrate-legacy-preset.mjs [--dry-run]`。

因为是**主机面**安装（不是某个 agent preset），`/cache-check` 会全局注册、覆盖所有会话，无需再选 preset。重启 DSH（或等 profile 补丁热加载）后生效。其它参数见 `node install.mjs --help`。

## 配置

`config/default.json`：

| 字段 | 含义 |
| --- | --- |
| `command.name` | 命令名（不含 `/`） |
| `probe.lightMessageCount` | 轻量模式重放的历史条数（会在第一条注入式 runtime-context 快照前截断，见下） |
| `probe.maxTokens` | 探针最大输出 token（越小越省） |
| `probe.temperature` | 探针采样温度（0 最稳定） |
| `probe.nonceLength` | 追加随机串长度（保证请求唯一） |

## 构建

```bash
node build/bundle.js   # 或 npm run build
```

产出：

- `dist/plugin.js` —— 函数体，可直接作动态插件 host code。
- `dist/plugin.cjs` —— CommonJS 模块，作为包入口（`package.json` 的 `main`）被 profile 软链加载。

## 已知限制

- 状态按会话隔离，只探测本会话最近一次真实请求的前缀。
- 换 provider / model 会换一份独立缓存，结论只对应同一份缓存。
- 两次请求间若 DSH 运行时上下文快照变了，下一次真实请求头部必然重算。
- 缓存淘汰属服务端行为，插件只如实报告命中数据，不做保证。

## License

MIT
