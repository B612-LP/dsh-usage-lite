# dsh-usage-lite · Token 用量统计插件

跨**全部会话**统计 DeepSeek Harness (DSH) 的 token 总使用量，在设置面板新增「用量统计」页。
无第三方依赖、无构建步骤、无网络调用——数据全部来自本地会话日志。

A zero-dependency DSH plugin that aggregates token usage across **all sessions**
and renders it as a settings page (totals, daily trend, per-model and per-workspace breakdown).

## 功能

- 汇总卡片：总 Tokens / 输入（未缓存）/ 缓存读（含命中率）/ 缓存写 / 输出（含推理）
- 时间范围切换：7 天 / 30 天 / 全部
- 按天用量柱状图、按模型排行、按工作区排行
- 增量索引：首次全量扫描后只重读新增/变更的会话，快照持久化到 `~/.dsh/usage-lite/index.json`

## 安装

```bash
dsh plugin add github:ChrisLou-bioinfo/dsh-usage-lite
```

装好后打开 **Settings → 用量统计**。

适配 DSH `0.2.0-rc.2+`（desktop 与 web profile 均可）。手动挂载方式：
在对应 profile 的 `cordis.patch.yml` 末尾加 `- insert:` 条目指向本包，仓库根目录的
`cordis.patch.yml` 即为模板。

## 统计口径

- 数据源：`ctx.sessionQuery`（live 优先、持久化兜底），`readSession(id)` 读取全量事件。
- 只统计 `assistant/message` 事件上 `data.usage` 且 `data.message.source.kind === "model"` 的样本
  （流式 `assistant/attempt` 里的 usage 是过程值，忽略）。
- **跳过 `inheritedEventCount` 之前的事件**：fork/resume 会话继承的父会话事件不重复计数。
- `total = input + output + cacheRead + cacheWrite`；`reasoning` 单列（若 provider 上报）。
- 缓存命中率 = `cacheRead / (cacheRead + input)`；provider 不上报缓存时显示 "—"。

## 数据流

1. 打开设置页 → 浏览器 `fetch /usage-lite/stats` → Host **立即返回内存中的聚合快照**（毫秒级），
   同时在后台做变更检测（stale-while-revalidate）；仅首次安装索引为空时同步等待。
2. 后台扫描（4s TTL 单飞行）：`listSessions()` 对比持久化日志 mtime，只重读新增/变更
   （live 会话每次都重读内存快照）。
3. 增量索引快照落盘 `~/.dsh/usage-lite/index.json`（10s 节流，原子写，版本化，坏文件从空开始）。
4. 响应聚合快照：`totals` / `days`（按天）/ `models`（按模型）/ `workspaces`（按工作区）/
   `cells`（按天×模型，供前端按时间范围重切）。

## 文件

| 文件 | 角色 |
|---|---|
| `index.mjs` | Host 半：折叠会话日志里的用量样本，维护增量索引，暴露 `GET /usage-lite/stats`（inject `webServer` + `sessionQuery`） |
| `client.js` | 浏览器半：Settings 面板的「用量统计」页（手工 bundle，只 require 平台种子模块 `react`；inject `slots` 服务，注册进 `settings.section` 槽位） |
| `cordis.patch.yml` | bundle 挂载模板（`- insert:` 条目） |
| `package.json` | `dsh.bundle.patch` + `dsh.client` 声明 |

## 维护注意

- 客户端 bundle **只能 require 平台种子模块**（`react`、`react-dom`、`@deepseek-ai/cordis`、
  `dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`、`dsh-client-ui-dockkit`）。
- client 的 `exports.inject` 必须是**服务名** `["slots"]`（不是包名）；写错会导致 web boot
  判定 "entry did not activate" 并拒绝启动，桌面版连续失败后会触发恢复流程重置 profile patch。
- 升级 DSH 版本后若设置页空白，先看 Settings → Plugins → Plugin list 的装载审计信息。
- 移除插件：`dsh plugin remove dsh-usage-lite`，或删掉 patch 里的 insert 行；
  `~/.dsh/usage-lite/` 索引可一并删除。

## License

[MIT](./LICENSE)

## Fork 定制：订阅额度面板（B612-LP）

本 fork 在上游基础上增加了「订阅额度」功能（设置 → 用量统计 → 订阅额度）：

- 同时查询 OpenAI Codex（`chatgpt.com/backend-api/wham/usage`，走代理 + codex UA）
  与 智谱 GLM Coding（`open.bigmodel.cn/api/monitor/usage/quota/limit`）两类订阅的窗口额度。
- `GET /usage-lite/quotas` 返回缓存快照（`~/.dsh/usage-lite/quotas.json`）；
  `POST /usage-lite/quotas/refresh` 实时查询。
- 打开设置页时对订阅额度自动刷新一次；快照在 10 分钟内查询过则跳过（手动查询不受限）。
- 凭据每次查询时从 DSH 凭据文件现读（refs），绝不写日志、不写代码。
- Codex 多账号：读取 `~/.dsh/accounts/<label>/credential.yaml` 和 `meta.json`，每个账号单独展示邮箱、窗口额度与重置时间，标记「DSH 当前使用」。隐藏备份账号、按 accountId 去重；当前账号始终读取实时凭据，不用旧快照。
- 查询不会切换账号或刷新 OAuth token；过期的非当前快照单独提示重新授权，不影响其他账号和 GLM 的查询。

维护方式：上游更新后 `git fetch upstream && git merge upstream/main`，解决冲突后
打新 tag（如 `v1.3.0-b612.1`），再把 DSH profile 依赖的 tag 钉子推进即可。
