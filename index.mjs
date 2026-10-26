// ── dsh-usage-lite · Host half ──────────────────────────────────────────────
// 跨全部会话聚合 provider 上报的 token 用量，并以 HTTP 路由供给 Web 设置页：
//
//   GET /usage-lite/stats   全量聚合快照（含按天、按模型、按工作区、会话数）
//   GET /usage-lite/health  探活
//
// 数据源：ctx.sessionQuery（live 优先、持久化兜底），只折叠
// assistant/message 事件上 source.kind === "model" 的 usage 样本；
// inheritedEventCount 之前的事件属于父会话（fork/resume 继承），跳过以免重复计数。
//
// 增量索引：以持久化日志 mtime 为变更信号（live 会话每次都重读），
// 快照持久化到 ~/.dsh/usage-lite/index.json。
// 请求路径非阻塞：/stats 立即返回内存快照，变更检测在后台进行（stale-while-revalidate）。
// 本文件是纯 Node ESM，无构建步骤，不依赖第三方包。
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";

export const name = "dsh-usage-lite";

export const inject = ["webServer", "sessionQuery"];

const ROUTE_PREFIX = "/usage-lite";
const INDEX_VERSION = 1;
const SCAN_TTL_MS = 4000;           // 两次全量扫描（列表 + mtime 比对）之间的最小间隔
const PERSIST_MIN_INTERVAL = 10000; // 索引落盘节流

const emptyTotals = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 });

function addUsage(target, usage) {
  target.input += usage.inputTokens ?? 0;
  target.output += usage.outputTokens ?? 0;
  target.cacheRead += usage.cacheReadTokens ?? 0;
  target.cacheWrite += usage.cacheWriteTokens ?? 0;
  target.reasoning += usage.reasoningTokens ?? 0;
  target.calls += 1;
}

function sumInto(target, source) {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.reasoning += source.reasoning;
  target.calls += source.calls;
}

function totalOf(t) {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

/** 本地时区日键 YYYY-MM-DD（与浏览器 dayKey 一致）。 */
function dayKeyOf(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 抽取一个会话事件数组里的用量样本（跳过继承区间）。 */
function samplesOf(events, skipCount) {
  const samples = [];
  for (let i = skipCount; i < events.length; i++) {
    const event = events[i];
    if (event?.type !== "assistant/message") continue;
    const data = event.data;
    if (data === void 0 || data.usage === void 0) continue;
    const source = data.message?.source;
    if (source === void 0 || source.kind !== "model") continue;
    if (typeof source.provider !== "string" || typeof source.model !== "string") continue;
    samples.push({ time: event.time, provider: source.provider, model: source.model, usage: data.usage });
  }
  return samples;
}

/** 把一个会话的样本折叠成索引条目。 */
function foldSession(header, events, inheritedCount, mtimeMs) {
  // cells: Map<date, Map<"provider\0model", totals>> —— 按天×模型的最细粒度
  const cells = new Map();
  let firstAt;
  let lastAt;
  for (const sample of samplesOf(events, inheritedCount ?? 0)) {
    const date = dayKeyOf(sample.time);
    const key = `${sample.provider}\u0000${sample.model}`;
    let byModel = cells.get(date);
    if (byModel === void 0) {
      byModel = new Map();
      cells.set(date, byModel);
    }
    let cell = byModel.get(key);
    if (cell === void 0) {
      cell = emptyTotals();
      byModel.set(key, cell);
    }
    addUsage(cell, sample.usage);
    if (firstAt === void 0 || sample.time < firstAt) firstAt = sample.time;
    if (lastAt === void 0 || sample.time > lastAt) lastAt = sample.time;
  }
  return {
    mtimeMs: mtimeMs ?? null,
    createdAt: header.createdAt ?? null,
    cwd: header.cwd ?? null,
    depth: header.delegationDepth ?? 0,
    firstAt: firstAt ?? null,
    lastAt: lastAt ?? null,
    cells,
  };
}

// ── 索引快照持久化（版本化，缺文件/坏文件都从空开始，绝不抛出） ────────────────

function serializeEntries(entries, writtenAt) {
  const sessions = {};
  for (const [id, entry] of entries) {
    const cells = {};
    for (const [date, byModel] of entry.cells) {
      const models = {};
      for (const [key, cell] of byModel) models[key] = cell;
      cells[date] = models;
    }
    sessions[id] = {
      mtimeMs: entry.mtimeMs,
      createdAt: entry.createdAt,
      cwd: entry.cwd,
      depth: entry.depth,
      firstAt: entry.firstAt,
      lastAt: entry.lastAt,
      cells,
    };
  }
  return { version: INDEX_VERSION, writtenAt, sessions };
}

function parseIndexFile(text) {
  const raw = JSON.parse(text);
  if (raw?.version !== INDEX_VERSION) throw new Error(`index version mismatch: ${raw?.version}`);
  const entries = new Map();
  for (const [id, s] of Object.entries(raw.sessions ?? {})) {
    const cells = new Map();
    for (const [date, models] of Object.entries(s.cells ?? {})) {
      cells.set(date, new Map(Object.entries(models ?? {})));
    }
    entries.set(id, {
      mtimeMs: s.mtimeMs ?? null,
      createdAt: s.createdAt ?? null,
      cwd: s.cwd ?? null,
      depth: s.depth ?? 0,
      firstAt: s.firstAt ?? null,
      lastAt: s.lastAt ?? null,
      cells,
    });
  }
  return entries;
}

// ── 插件本体 ────────────────────────────────────────────────────────────────

export function apply(ctx) {
  const log = (level, message, error) => {
    const line = `[dsh-usage-lite] ${message}${error === void 0 ? "" : `: ${String(error?.stack ?? error)}`}`;
    try {
      if (level === "error") ctx.logger?.error?.(line);
      else ctx.logger?.warn?.(line);
    } catch {
      (level === "error" ? console.error : console.warn)(line);
    }
  };

  const sessionQuery = ctx.sessionQuery;
  const dshHomePath = ctx.get?.("dshHomePath");
  const indexDir = typeof dshHomePath === "function"
    ? dshHomePath("usage-lite")
    : join(homedir(), ".dsh", "usage-lite");
  const indexFile = join(indexDir, "index.json");

  /** sessionId → 折叠条目。 */
  const entries = new Map();
  let loaded = false;
  let scanning = null;
  let lastScanAt = 0;
  let dirty = false;
  let lastPersistAt = 0;
  let persistTimer = null;

  async function loadIndex() {
    try {
      const text = await readFile(indexFile, "utf8");
      for (const [id, entry] of parseIndexFile(text)) entries.set(id, entry);
    } catch (error) {
      if (error?.code !== "ENOENT") log("warn", "index snapshot unreadable, starting empty", error);
    }
    loaded = true;
  }

  async function persistNow() {
    dirty = false;
    lastPersistAt = Date.now();
    const payload = JSON.stringify(serializeEntries(entries, lastPersistAt));
    await mkdir(indexDir, { recursive: true });
    const tmp = `${indexFile}.tmp`;
    await writeFile(tmp, payload);
    await rename(tmp, indexFile);
  }

  function schedulePersist() {
    dirty = true;
    if (persistTimer !== null) return;
    const wait = Math.max(0, PERSIST_MIN_INTERVAL - (Date.now() - lastPersistAt));
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (!dirty) return;
      persistNow().catch((error) => log("warn", "index persist failed", error));
    }, wait);
    if (typeof persistTimer.unref === "function") persistTimer.unref();
  }

  async function mtimeOfPersisted(record) {
    try {
      const persistence = ctx.get?.("sessionPersistence");
      const location = persistence?.locate?.(record.header);
      if (location?.path === void 0) return void 0;
      const identity = await stat(location.path);
      return identity.mtimeMs;
    } catch {
      return void 0;
    }
  }

  /**
   * 增量对齐索引与当前会话清单：只重读新增/变更（live 会话每次都重读）。
   * 单飞行：并发请求共享同一次扫描。
   */
  function refresh(now = Date.now()) {
    if (scanning !== null) return scanning;
    if (loaded === false) return Promise.resolve();
    if (now - lastScanAt < SCAN_TTL_MS) return Promise.resolve();
    scanning = (async () => {
      const records = await sessionQuery.listSessions();
      const seen = new Set();
      for (const record of records) {
        const id = record.header.id;
        seen.add(id);
        const mtime = record.live ? now : await mtimeOfPersisted(record);
        const prev = entries.get(id);
        if (prev !== void 0 && !record.live && mtime !== void 0 && prev.mtimeMs === mtime) continue;
        try {
          const { events, inheritedEventCount } = await sessionQuery.readSession(id);
          entries.set(id, foldSession(record.header, events, inheritedEventCount, mtime));
          schedulePersist();
        } catch (error) {
          log("warn", `fold failed for session ${id}`, error);
        }
      }
      for (const id of [...entries.keys()]) {
        if (!seen.has(id)) {
          entries.delete(id);
          schedulePersist();
        }
      }
      lastScanAt = Date.now();
    })()
      .catch((error) => log("error", "index refresh failed", error))
      .finally(() => { scanning = null; });
    return scanning;
  }

  /** 由索引条目聚合成响应快照。 */
  function statsSnapshot() {
    const totals = emptyTotals();
    const byDay = new Map();     // date → totals
    const byModel = new Map();   // key → {provider, model, totals}
    const byWorkspace = new Map();
    const mergedCells = new Map(); // "date\u0000provider\u0000model" → totals
    let sessionsWithUsage = 0;
    let firstAt;
    let lastAt;
    for (const entry of entries.values()) {
      if (entry.cells.size === 0) continue;
      sessionsWithUsage += 1;
      const wsKey = entry.cwd ?? "(未知工作区)";
      let ws = byWorkspace.get(wsKey);
      if (ws === void 0) {
        const label = entry.cwd === void 0 || entry.cwd === null
          ? "(未知工作区)"
          : entry.cwd.split("/").filter(Boolean).pop() ?? entry.cwd;
        ws = { cwd: entry.cwd, label, sessions: 0, totals: emptyTotals() };
        byWorkspace.set(wsKey, ws);
      }
      ws.sessions += 1;
      for (const [date, byModelOfDay] of entry.cells) {
        if (entry.firstAt !== null && (firstAt === void 0 || entry.firstAt < firstAt)) firstAt = entry.firstAt;
        if (entry.lastAt !== null && (lastAt === void 0 || entry.lastAt > lastAt)) lastAt = entry.lastAt;
        for (const [key, cell] of byModelOfDay) {
          sumInto(totals, cell);
          let day = byDay.get(date);
          if (day === void 0) {
            day = emptyTotals();
            byDay.set(date, day);
          }
          sumInto(day, cell);
          let model = byModel.get(key);
          if (model === void 0) {
            const sep = key.indexOf("\u0000");
            model = { provider: key.slice(0, sep), model: key.slice(sep + 1), totals: emptyTotals() };
            byModel.set(key, model);
          }
          sumInto(model.totals, cell);
          sumInto(ws.totals, cell);
          const cellKey = `${date}\u0000${key}`;
          let merged = mergedCells.get(cellKey);
          if (merged === void 0) {
            merged = emptyTotals();
            mergedCells.set(cellKey, merged);
          }
          sumInto(merged, cell);
        }
      }
    }
    return {
      ok: true,
      generatedAt: Date.now(),
      totals: { ...totals, total: totalOf(totals) },
      sessions: entries.size,
      sessionsWithUsage,
      firstAt: firstAt ?? null,
      lastAt: lastAt ?? null,
      days: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([date, cell]) => ({ date, ...cell, total: totalOf(cell) })),
      models: [...byModel.values()]
        .map((m) => ({ provider: m.provider, model: m.model, ...m.totals, total: totalOf(m.totals) }))
        .sort((a, b) => b.total - a.total),
      workspaces: [...byWorkspace.values()]
        .map((w) => ({ label: w.label, cwd: w.cwd, sessions: w.sessions, ...w.totals, total: totalOf(w.totals) }))
        .sort((a, b) => b.total - a.total),
      cells: [...mergedCells.entries()].map(([cellKey, cell]) => {
        const [date, provider, model] = cellKey.split("\u0000");
        return { date, provider, model, ...cell };
      }),
    };
  }

  const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

  async function statsHandler(req, res) {
    if (loaded === false) await loadIndex();
    // 秒开：立即返回内存中已聚合的快照，后台异步做变更检测（mtime 比对 +
    // 重读变更/live 会话），下一次请求即拿到新数据。仅首次安装索引为空时同步等待。
    if (entries.size === 0) await refresh(Date.now());
    else void refresh(Date.now());
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify(statsSnapshot()));
  }

  // ── 订阅额度（手动查询，快照缓存到 quotas.json） ────────────────────────────
  // 只覆盖订阅型 provider（deepseek 系按量计费，没有窗口额度，不查）：
  //   * openai-codex  → GET chatgpt.com/backend-api/wham/usage
  //     （credentials 记录 llm-pi-ai/openai-codex 的 access/accountId；必须走代理 + codex UA）
  //   * zai-coding-cn → GET open.bigmodel.cn/api/monitor/usage/quota/limit
  //     （credentials refs.ZAI_CODING_CN_API_KEY 的静态 key，国内直连）
  // 凭据每次查询现读、绝不落日志；打开面板只展示上次缓存结果，点按钮才真正发请求。
  const QUOTA_VERSION = 1;
  const quotaFile = join(indexDir, "quotas.json");
  let quotaSnapshot = null;
  let quotaLoaded = false;
  let quotaRefresh = null;

  const quotaInt = (v) => Math.round(Number(v) || 0).toLocaleString("en-US");

  function credentialsPath() {
    return typeof dshHomePath === "function"
      ? dshHomePath(".credentials.yaml")
      : join(homedir(), ".dsh", ".credentials.yaml");
  }

  async function readCredentials() {
    try {
      return await readFile(credentialsPath(), "utf8");
    } catch {
      return null;
    }
  }

  /** refs.<name> 的值（本机 credentials 的 refs 段直接存 key 本值）。 */
  function refValue(text, name) {
    if (!text) return null;
    let inRefs = false;
    for (const line of text.split("\n")) {
      if (/^\S/.test(line)) { inRefs = line.startsWith("refs:"); continue; }
      if (!inRefs || /^\s*#/.test(line)) continue;
      const m = line.match(/^ {2}([^:]+): *(.*)$/);
      if (m !== null && m[1] === name) {
        const v = m[2].trim().replace(/^["']|["']$/g, "");
        return v === "" ? null : v;
      }
    }
    return null;
  }

  /** records.<id> payload 下的标量字段（只支持一层 payload，够本文件用）。 */
  function recordPayload(text, id) {
    if (!text) return null;
    const header = `  ${id}:`;
    let inRecord = false;
    let inPayload = false;
    const out = {};
    for (const line of text.split("\n")) {
      if (/^\S/.test(line)) { inRecord = false; inPayload = false; continue; }
      if (line.startsWith(header)) { inRecord = true; inPayload = false; continue; }
      if (!inRecord) continue;
      if (/^ {2}\S/.test(line)) { inRecord = false; continue; }
      if (line.trimStart().startsWith("#")) continue;
      if (/^ {4}\S/.test(line)) { inPayload = line.startsWith("    payload:"); continue; }
      const m = inPayload === true ? line.match(/^ {6}([^:]+): *(.*)$/) : null;
      if (m !== null) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  /** 走 curl 而不是 fetch：chatgpt.com 必须经代理，undici 默认不吃 HTTPS_PROXY。 */
  function curlText(args, timeoutMs) {
    return new Promise((resolve) => {
      execFile("/usr/bin/curl", args, { timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
        if (error !== void 0 && error !== null) {
          resolve({
            ok: false,
            body: stdout ?? "",
            error: error.killed === true
              ? `请求超时（${Math.round(timeoutMs / 1000)}s）`
              : String(stderr || (error?.message ?? error)),
          });
          return;
        }
        resolve({ ok: true, body: stdout ?? "", error: null });
      });
    });
  }

  /** 末行是 curl -w 追加的 HTTP 状态码。 */
  function splitCurlStatus(body) {
    const idx = body.lastIndexOf("\n");
    if (idx < 0) return { status: 0, text: body };
    const status = Number(body.slice(idx + 1).trim());
    return { status: Number.isInteger(status) && status > 0 ? status : 0, text: body.slice(0, idx) };
  }

  function windowLabelFromSeconds(sec) {
    if (typeof sec !== "number" || !(sec > 0)) return "窗口";
    if (sec >= 6 * 86400 && sec <= 8 * 86400) return "周窗口（7 天）";
    if (sec < 2 * 86400) return `${Math.round(sec / 3600)} 小时窗口`;
    return `${Math.round(sec / 86400)} 天窗口`;
  }

  async function queryCodexQuota() {
    const base = { plan: null, windows: [], note: null, error: null };
    const payload = recordPayload(await readCredentials(), "llm-pi-ai/openai-codex");
    const access = typeof payload?.access === "string" ? payload.access : null;
    const accountId = typeof payload?.accountId === "string" ? payload.accountId : null;
    if (!access || !accountId) {
      return { ...base, status: "unconfigured", error: "credentials 里没有 llm-pi-ai/openai-codex 记录（去设置 → 模型里登录 ChatGPT）" };
    }
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || "http://127.0.0.1:7897";
    const { ok, body, error } = await curlText([
      "-s", "-m", "12", "-x", proxy,
      "-A", "codex_cli_rs/0.163.0",
      "-H", `Authorization: Bearer ${access}`,
      "-H", `chatgpt-account-id: ${accountId}`,
      "-H", "originator: pi",
      "-w", "\n%{http_code}",
      "https://chatgpt.com/backend-api/wham/usage",
    ], 15000);
    if (!ok) return { ...base, status: "error", error: `网络不通（代理 ${proxy}）：${error}` };
    const { status, text } = splitCurlStatus(body);
    if (status === 401 || status === 403) {
      return {
        ...base,
        status: "error",
        error: status === 401
          ? "登录凭据已过期：设置 → 模型 → OpenAI Codex 行重新登录（或官方 Codex CLI 登录后跑 codex-sync.sh）"
          : "被 Cloudflare/代理节点拦截（403）：跑一次 ~/.dsh/bin/ai-egress-guard.sh 换可用节点",
      };
    }
    let json;
    try { json = JSON.parse(text); } catch {
      return { ...base, status: "error", error: `HTTP ${status}，响应不是 JSON（多半被代理/Cloudflare 拦截）` };
    }
    if (status !== 200 || json?.rate_limit === void 0) {
      const detail = typeof json?.error?.message === "string" && json.error.message !== ""
        ? json.error.message
        : String(json?.detail ?? text.slice(0, 160));
      return { ...base, status: "error", error: `HTTP ${status}：${detail}` };
    }
    const rl = json.rate_limit;
    const windows = [];
    for (const w of [rl.primary_window, rl.secondary_window]) {
      if (!w || typeof w.used_percent !== "number") continue;
      windows.push({
        label: windowLabelFromSeconds(w.limit_window_seconds),
        usedPercent: w.used_percent,
        detail: null,
        resetAfterSeconds: typeof w.reset_after_seconds === "number" ? w.reset_after_seconds : null,
        resetAt: typeof w.reset_at === "number" ? w.reset_at * 1000 : null,
      });
    }
    const notes = [];
    if (rl.limit_reached === true) notes.push("已达窗口上限");
    const creditsLeft = json.rate_limit_reset_credits?.available_count;
    if (typeof creditsLeft === "number" && creditsLeft > 0) notes.push(`储存的重置 ×${creditsLeft}`);
    return {
      ...base,
      status: "ok",
      plan: typeof json.plan_type === "string" ? json.plan_type : null,
      windows,
      note: notes.length > 0 ? notes.join(" · ") : null,
    };
  }

  async function queryGlmQuota() {
    const base = { plan: null, windows: [], note: null, error: null };
    const key = refValue(await readCredentials(), "ZAI_CODING_CN_API_KEY");
    if (!key) return { ...base, status: "unconfigured", error: "credentials refs 里没有 ZAI_CODING_CN_API_KEY" };
    const { ok, body, error } = await curlText([
      "-s", "-m", "12",
      "-H", `Authorization: Bearer ${key}`,
      "-w", "\n%{http_code}",
      "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    ], 15000);
    if (!ok) return { ...base, status: "error", error: `网络不通：${error}` };
    const { status, text } = splitCurlStatus(body);
    let json;
    try { json = JSON.parse(text); } catch {
      return { ...base, status: "error", error: `HTTP ${status}，响应不是 JSON` };
    }
    if (json?.success !== true) {
      return {
        ...base,
        status: "error",
        error: typeof json?.msg === "string" && json.msg !== "" ? `智谱接口：${json.msg}` : `HTTP ${status}`,
      };
    }
    // 智谱 2026-07 改版后是积分制：usage=窗口积分上限，currentValue=已用，remaining=剩余；
    // unit=3 → 5 小时窗口、unit=6 → 周窗口；旧套餐 type 为 TOKENS_LIMIT，新版为 CREDIT_LIMIT。
    const UNIT_LABEL = { 3: "5 小时窗口", 6: "周窗口" };
    const windows = (Array.isArray(json.data?.limits) ? json.data.limits : [])
      .filter((l) => l?.type === "TOKENS_LIMIT" || l?.type === "CREDIT_LIMIT")
      .sort((a, b) => (a.unit ?? 0) - (b.unit ?? 0))
      .map((l) => ({
        label: UNIT_LABEL[l.unit] ?? `窗口（unit=${l.unit}）`,
        usedPercent: typeof l.percentage === "number" ? l.percentage : null,
        detail: l.usage > 0 ? `已用 ${quotaInt(l.currentValue)} / ${quotaInt(l.usage)} · 剩 ${quotaInt(l.remaining)} 积分` : null,
        resetAfterSeconds: null,
        resetAt: typeof l.nextResetTime === "number" ? l.nextResetTime : null,
      }));
    return {
      ...base,
      status: "ok",
      plan: typeof json.data?.level === "string" ? json.data.level : null,
      windows,
      note: null,
    };
  }

  const QUOTA_PROVIDERS = [
    { id: "openai-codex", label: "OpenAI Codex (ChatGPT)", query: queryCodexQuota },
    { id: "zai-coding-cn", label: "智谱 GLM Coding Pro", query: queryGlmQuota },
  ];

  function emptyQuotaSnapshot() {
    return {
      version: QUOTA_VERSION,
      queriedAt: null,
      providers: QUOTA_PROVIDERS.map((p) => ({ id: p.id, label: p.label, status: "pending", plan: null, windows: [], note: null, error: null })),
    };
  }

  async function persistQuotas() {
    try {
      await mkdir(indexDir, { recursive: true });
      const tmp = `${quotaFile}.tmp`;
      await writeFile(tmp, JSON.stringify(quotaSnapshot));
      await rename(tmp, quotaFile);
    } catch (error) {
      log("warn", "quota snapshot persist failed", error);
    }
  }

  async function loadQuotas() {
    try {
      const raw = JSON.parse(await readFile(quotaFile, "utf8"));
      if (raw?.version === QUOTA_VERSION) quotaSnapshot = raw;
    } catch (error) {
      if (error?.code !== "ENOENT") log("warn", "quota snapshot unreadable, ignoring", error);
    }
    quotaLoaded = true;
  }

  /** 手动刷新：并发查所有 provider（单飞行），成功后落盘。 */
  function runQuotaRefresh() {
    if (quotaRefresh === null) {
      quotaRefresh = (async () => {
        const results = await Promise.all(QUOTA_PROVIDERS.map(async (p) => {
          try {
            return { id: p.id, label: p.label, ...(await p.query()) };
          } catch (error) {
            return { id: p.id, label: p.label, status: "error", plan: null, windows: [], note: null, error: String(error?.message ?? error) };
          }
        }));
        quotaSnapshot = { version: QUOTA_VERSION, queriedAt: Date.now(), providers: results };
        await persistQuotas();
        return quotaSnapshot;
      })()
        .catch((error) => {
          log("error", "quota refresh failed", error);
          return quotaSnapshot ?? emptyQuotaSnapshot();
        })
        .finally(() => { quotaRefresh = null; });
    }
    return quotaRefresh;
  }

  async function quotasRoute(res, force) {
    if (quotaLoaded === false) await loadQuotas();
    if (force === true) await runQuotaRefresh();
    const snapshot = quotaSnapshot ?? emptyQuotaSnapshot();
    res.writeHead(200, JSON_HEADERS);
    res.end(JSON.stringify({ ok: true, ...snapshot }));
  }

  ctx.effect(() => {
    // 装载：读快照并预热一次扫描，让首次打开页面就有数据。
    void loadIndex().then(() => refresh(Date.now()));
    return () => {
      if (persistTimer !== null) { clearTimeout(persistTimer); persistTimer = null; }
      if (dirty) void persistNow().catch(() => {});
    };
  }, "dsh-usage-lite: index lifecycle");

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? "/", "http://local");
      if (req.method === "GET" && url.pathname === `${ROUTE_PREFIX}/stats`) return statsHandler(req, res);
      if (req.method === "GET" && url.pathname === `${ROUTE_PREFIX}/health`) {
        res.writeHead(200, JSON_HEADERS);
        res.end(JSON.stringify({ ok: true, at: Date.now() }));
        return;
      }
      if (req.method === "GET" && url.pathname === `${ROUTE_PREFIX}/quotas`) {
        return quotasRoute(res, url.searchParams.get("refresh") === "1");
      }
      if (req.method === "POST" && url.pathname === `${ROUTE_PREFIX}/quotas/refresh`) return quotasRoute(res, true);
      if (req.method === "GET" && url.pathname === `${ROUTE_PREFIX}/quotas`) {
        return quotasRoute(res, url.searchParams.get("refresh") === "1");
      }
      if (req.method === "POST" && url.pathname === `${ROUTE_PREFIX}/quotas/refresh`) return quotasRoute(res, true);
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
    },
  }), "dsh-usage-lite: stats route");

  log("info", "host half loaded");
}
