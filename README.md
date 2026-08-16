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
