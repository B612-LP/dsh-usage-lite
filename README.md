# dsh-usage-lite · Token 用量统计插件

跨**全部会话**统计 DeepSeek Harness (DSH) 的 token 总使用量，在设置面板新增「用量统计」页。
无第三方依赖、无构建步骤。Token 统计来自本地会话日志；订阅额度查询和账号切换验证会调用对应官方服务。

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
- `GET /usage-lite/quotas` 返回缓存和当前账号；缓存超过 10 分钟时，打开页面自动只读查询。不论是自动查询、`POST /usage-lite/quotas/refresh` 还是旧 `?refresh=1`，都不写凭据。
- 启用续期后，手动点「查询额度」只会为 **DSH 当前使用** 的 Codex 账号处理已过期或 `401`：同一轮最多续期一次并补查一次。`403`、`429`、网络异常、额度用尽等不会触发；也不会自动切号。续期成功、补查失败时保留新凭据并标明上次成功的额度时间。
- Codex 多账号：用保存目录名作标签，不显示邮箱或令牌。当前账号使用实时记录，不读旧快照。已保存的非当前账号只有明确确认「切换使用」才可续期或激活；切换影响全局后续 GPT 请求，不需要重启。
- 额度端点仅供 DSH 所有者使用。手动续期与切号的 JSON 写操作额外校验同源、操作标记及当前账号身份。活跃 Codex 记录只经宿主 `credentials.modifyRecord` 写入，与模型侧共锁；浏览器、日志、额度缓存、curl 命令参数均不接收令牌。续期结果不明时不自动重发旧令牌。
- 测试：`node --test`（临时目录、伪造凭据及网络，不访问真实账号）。

固定版本：`github:B612-LP/dsh-usage-lite#v1.2.1-b612.7`。额度路由使用 DSH WebServer 传入的已认证所有者身份，不重复登录校验；已在 Desktop `0.2.3-alpha.2` 验证。没有所有者身份则拒绝额度请求，没有 `credentials.modifyRecord` 则不开放凭据写入。

**部署守则**：自动续期默认关闭。只有在停用或迁移所有直接覆盖 DSH Codex 记录的本机工具后，才能在 DSH home 下的 `usage-lite/codex-renewal-enabled` 放置权限 `0600`、内容恰为 `enabled` 加换行的普通文件。启用条件每次查询时读取；移除此文件即可停用自动续期，不重启、不回滚凭据。稳妥回退只关续期，保留走锁的切号实现。

维护方式：上游更新后 `git fetch upstream && git merge upstream/main`，解决冲突后
打新 tag，再把 DSH profile 依赖的 tag 钉子推进即可。
