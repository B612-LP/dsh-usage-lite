// ── dsh-usage-lite · Client half ────────────────────────────────────────────
// Web 设置面板里的「用量统计」页。手工编写的浏览器 bundle：
//   * 只 require 平台种子模块（react），不依赖任何需要构建链的包；
//   * 经 ctx.slots 把组件注册进 settings.section 槽位；
//   * 数据来自宿主半边的 GET /usage-lite/stats。
//
// dsh.client 声明见同目录 package.json（inject 等待 slots 服务先于本模块装载）。
window.__ModuleLoader__.load({
	id: "dsh-usage-lite",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const e = React.createElement;

		const STATS_URL = "/usage-lite/stats";
		const RANGES = [
			{ id: "all", label: "全部" },
			{ id: "today", label: "今天" },
			{ id: "7d", label: "近 7 天" },
			{ id: "30d", label: "近 30 天" },
		];
		const QUOTA_AUTO_REFRESH_MS = 10 * 60 * 1000;
		const RENEWAL_POLL_MS = 400;
		const RENEWAL_POLL_LIMIT = 75; // at most 30 seconds of status polling at the nominal cadence

		// ── 纯函数：数字与日期 ────────────────────────────────────────────────
		function formatInt(value) {
			return Math.round(value).toLocaleString("en-US");
		}
		function formatCompact(value) {
			if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
			if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
			if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
			return String(Math.round(value));
		}
		function dayKey(ms) {
			const d = new Date(ms);
			const pad = (n) => String(n).padStart(2, "0");
			return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
		}
		function rangeStartMs(range) {
			const now = new Date();
			if (range === "today") {
				now.setHours(0, 0, 0, 0);
				return now.getTime();
			}
			const days = range === "7d" ? 7 : range === "30d" ? 30 : 0;
			if (days === 0) return null;
			const start = new Date();
			start.setHours(0, 0, 0, 0);
			return start.getTime() - (days - 1) * 86400000;
		}
		function rate(cacheRead, input) {
			const denom = cacheRead + input;
			return denom > 0 ? cacheRead / denom : null;
		}

		// ── 视图裁剪：从全量响应中切出所选时间窗 ─────────────────────────────
		function sliceByRange(data, range) {
			const startMs = rangeStartMs(range);
			if (startMs === null) {
				return {
					totals: data.totals,
					days: data.days ?? [],
					models: data.models ?? [],
					workspaces: data.workspaces ?? [],
				};
			}
			const startKey = dayKey(startMs);
			const days = (data.days ?? []).filter((d) => d.date >= startKey);
			const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 };
			const byModel = new Map();
			for (const day of days) {
				totals.input += day.input; totals.output += day.output;
				totals.cacheRead += day.cacheRead; totals.cacheWrite += day.cacheWrite;
				totals.reasoning += day.reasoning; totals.calls += day.calls;
			}
			for (const cell of data.cells ?? []) {
				if (cell.date < startKey) continue;
				const key = `${cell.provider}\u0000${cell.model}`;
				let row = byModel.get(key);
				if (row === void 0) {
					row = { provider: cell.provider, model: cell.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0, total: 0 };
					byModel.set(key, row);
				}
				row.input += cell.input; row.output += cell.output;
				row.cacheRead += cell.cacheRead; row.cacheWrite += cell.cacheWrite;
				row.reasoning += cell.reasoning; row.calls += cell.calls;
				row.total += cell.input + cell.output + cell.cacheRead + cell.cacheWrite;
			}
			const models = [...byModel.values()].sort((a, b) => b.total - a.total);
			return { totals, days, models, workspaces: data.workspaces ?? [] };
		}

		// ── 样式（走 dsw 设计变量，带回退值） ────────────────────────────────
		const css = {
			wrap: { display: "flex", flexDirection: "column", gap: 18, fontSize: 13, color: "var(--dsw-alias-label-primary, inherit)", lineHeight: 1.5 },
			headRow: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
			title: { fontSize: 15, fontWeight: 600, margin: 0 },
			muted: { color: "var(--dsw-alias-label-secondary, #888)", fontSize: 12 },
			button: {
				border: "1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.35))",
				background: "var(--dsw-alias-interactive-bg, transparent)",
				color: "inherit", borderRadius: 8, padding: "4px 12px", cursor: "pointer", fontSize: 12,
			},
			rangeRow: { display: "flex", gap: 6 },
			rangeBtn: (active) => ({
				// 文字永远继承正文色（深浅主题都可读）；选中态用半透明底+加粗区分，
				// 不用「品牌色底 + 白字」——暗色主题品牌变量偏浅，会白字白底隐身。
				border: "1px solid " + (active ? "var(--dsw-alias-border-strong, rgba(127,127,127,.65))" : "var(--dsw-alias-border-subtle, rgba(127,127,127,.35))"),
				background: active ? "var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.28))" : "var(--dsw-alias-interactive-bg, rgba(127,127,127,.10))",
				color: "inherit",
				fontWeight: active ? 600 : 400,
				borderRadius: 999, padding: "3px 12px", cursor: "pointer", fontSize: 12,
			}),
			cards: { display: "flex", gap: 10, flexWrap: "wrap" },
			card: {
				flex: "1 1 130px", minWidth: 128, borderRadius: 10, padding: "10px 14px",
				background: "var(--dsw-alias-bg-layer-3, rgba(127,127,127,.08))",
				border: "1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.2))",
			},
			cardLabel: { fontSize: 12, color: "var(--dsw-alias-label-secondary, #888)", marginBottom: 2 },
			cardValue: { fontSize: 18, fontWeight: 600, fontVariantNumeric: "tabular-nums" },
			cardSub: { fontSize: 11, color: "var(--dsw-alias-label-secondary, #888)" },
			chart: { display: "flex", alignItems: "flex-end", gap: 2, height: 96, padding: "6px 2px 0", borderRadius: 10, background: "var(--dsw-alias-bg-layer-3, rgba(127,127,127,.08))" },
			bar: (ratio, has) => ({
				flex: "1 1 0", minWidth: 3, height: has ? `${Math.max(3, Math.round(ratio * 100))}%` : "2px",
				background: has ? "var(--dsw-alias-brand-primary, #4b7bec)" : "var(--dsw-alias-border-subtle, rgba(127,127,127,.25))",
				borderRadius: 2,
			}),
			table: { width: "100%", borderCollapse: "collapse", fontSize: 12, fontVariantNumeric: "tabular-nums" },
			th: { textAlign: "right", padding: "4px 8px", borderBottom: "1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.3))", color: "var(--dsw-alias-label-secondary, #888)", fontWeight: 500, whiteSpace: "nowrap" },
			thLeft: { textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.3))", color: "var(--dsw-alias-label-secondary, #888)", fontWeight: 500, whiteSpace: "nowrap" },
			td: { textAlign: "right", padding: "4px 8px", borderBottom: "1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.12))", whiteSpace: "nowrap" },
			tdLeft: { textAlign: "left", padding: "4px 8px", borderBottom: "1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.12))", whiteSpace: "nowrap", maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis" },
			sectionTitle: { fontSize: 13, fontWeight: 600, margin: "4px 0 6px" },
			error: { color: "#c0392b", fontSize: 12 },
			quotaGrid: { display: "flex", gap: 10, flexWrap: "wrap" },
			providerCard: {
				flex: "1 1 300px", borderRadius: 10, padding: "10px 14px",
				background: "var(--dsw-alias-bg-layer-3, rgba(127,127,127,.08))",
				border: "1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.2))",
			},
			providerHead: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
			providerName: { fontWeight: 600, fontSize: 13 },
			planChip: { fontSize: 11, lineHeight: "16px", padding: "0 8px", borderRadius: 999, border: "1px solid var(--dsw-alias-border-subtle, rgba(127,127,127,.35))", color: "var(--dsw-alias-label-secondary, #888)" },
			windowRow: { marginTop: 9 },
			windowHead: { display: "flex", justifyContent: "space-between", gap: 8, fontSize: 12, marginBottom: 3 },
			track: { height: 6, borderRadius: 3, background: "var(--dsw-alias-border-subtle, rgba(127,127,127,.25))", overflow: "hidden" },
			fill: (ratio) => ({
				width: `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`, height: "100%", borderRadius: 3,
				background: ratio >= 0.9 ? "#e05252" : ratio >= 0.7 ? "#e08e2b" : "var(--dsw-alias-brand-primary, #4b7bec)",
			}),
			buttonDisabled: { opacity: 0.6, cursor: "default" },
		};

		// ── 组件 ─────────────────────────────────────────────────────────────
		function SummaryCard(label, value, sub) {
			return e("div", { key: label, style: css.card },
				e("div", { style: css.cardLabel }, label),
				e("div", { style: css.cardValue }, value),
				sub === void 0 ? null : e("div", { style: css.cardSub }, sub));
		}

		function ModelTable({ models }) {
			if (models.length === 0) return e("div", { style: css.muted }, "所选时间范围内没有模型调用记录。");
			const rows = models.slice(0, 40).map((m, i) => e("tr", { key: `${m.provider}\u0000${m.model}\u0000${i}` },
				e("td", { style: css.tdLeft, title: `${m.provider} / ${m.model}` }, `${m.provider} / ${m.model}`),
				e("td", { style: css.td }, formatInt(m.calls)),
				e("td", { style: css.td }, formatCompact(m.input)),
				e("td", { style: css.td }, formatCompact(m.cacheRead)),
				e("td", { style: css.td }, formatCompact(m.cacheWrite)),
				e("td", { style: css.td }, formatCompact(m.output)),
				e("td", { style: css.td }, m.reasoning > 0 ? formatCompact(m.reasoning) : "—"),
				e("td", { style: css.td }, e("b", null, formatCompact(m.total)))));
			return e("table", { style: css.table },
				e("thead", null, e("tr", null,
					e("th", { style: css.thLeft }, "模型"),
					e("th", { style: css.th }, "调用"),
					e("th", { style: css.th }, "输入"),
					e("th", { style: css.th }, "缓存读"),
					e("th", { style: css.th }, "缓存写"),
					e("th", { style: css.th }, "输出"),
					e("th", { style: css.th }, "推理"),
					e("th", { style: css.th }, "合计"))),
				e("tbody", null, rows));
		}

		function WorkspaceTable({ workspaces }) {
			const rows = workspaces.filter((w) => w.total > 0).slice(0, 40).map((w, i) => e("tr", { key: `${w.label}\u0000${i}` },
				e("td", { style: css.tdLeft, title: w.cwd ?? "" }, w.label),
				e("td", { style: css.td }, formatInt(w.sessions)),
				e("td", { style: css.td }, formatCompact(w.input)),
				e("td", { style: css.td }, formatCompact(w.output)),
				e("td", { style: css.td }, formatCompact(w.total))));
			if (rows.length === 0) return null;
			return e("table", { style: css.table },
				e("thead", null, e("tr", null,
					e("th", { style: css.thLeft }, "工作区"),
					e("th", { style: css.th }, "会话"),
					e("th", { style: css.th }, "输入"),
					e("th", { style: css.th }, "输出"),
					e("th", { style: css.th }, "合计"))),
				e("tbody", null, rows));
		}

		function DailyChart({ days }) {
			const window = days.slice(-30);
			if (window.length === 0) return null;
			const max = Math.max(0, ...window.map((d) => d.total));
			return e("div", { style: css.chart },
				window.map((d) => e("div", {
					key: d.date,
					title: `${d.date} · 合计 ${formatInt(d.total)}（输入 ${formatInt(d.input)} / 输出 ${formatInt(d.output)} / 缓存读 ${formatInt(d.cacheRead)} / 缓存写 ${formatInt(d.cacheWrite)}）`,
					style: css.bar(max > 0 ? d.total / max : 0, d.total > 0),
				})));
		}

		// ── 订阅额度（手动查询，展示宿主缓存的快照） ──────────────────────────
		function humanizeReset(seconds, resetAt) {
			let s = resetAt != null ? Math.round((resetAt - Date.now()) / 1000) : seconds;
			if (s == null || !(s > 0)) return null;
			if (s >= 86400) return `${(s / 86400).toFixed(s >= 10 * 86400 ? 0 : 1)} 天后重置`;
			if (s >= 3600) return `${(s / 3600).toFixed(s >= 10 * 3600 ? 0 : 1)} 小时后重置`;
			return `${Math.max(1, Math.round(s / 60))} 分钟后重置`;
		}

		function QuotaWindow({ w }) {
			const pct = typeof w.usedPercent === "number" ? Math.max(0, Math.min(100, w.usedPercent)) : null;
			const reset = humanizeReset(w.resetAfterSeconds ?? null, w.resetAt ?? null);
			const right = [pct === null ? null : `已用 ${pct}%`, w.detail, reset].filter(Boolean).join(" · ");
			return e("div", { style: css.windowRow },
				e("div", { style: css.windowHead },
					e("span", null, w.label),
					right === "" ? null : e("span", { style: css.muted }, right)),
				e("div", { style: css.track }, e("div", { style: css.fill((pct ?? 0) / 100) })));
		}

		function QuotaProviderCard({ p, onSwitch, switching = null, disabled = false, canSwitch = true }) {
			const account = p.account;
			const windows = p.windows ?? [];
			const stale = p.status === "stale";
			return e("div", { style: css.providerCard },
				e("div", { style: css.providerHead },
					e("span", { style: css.providerName }, p.label ?? p.id),
					p.plan ? e("span", { style: css.planChip }, p.plan) : null,
					account?.active === true ? e("span", { style: css.planChip }, "DSH 当前使用") : null,
					canSwitch !== false && p.providerId === "openai-codex" && account?.switchable === true && account.active !== true
						? e("button", {
							type: "button",
							style: { ...css.button, marginLeft: "auto", ...(disabled ? css.buttonDisabled : {}) },
							disabled,
							"aria-label": `切换使用 ${account.label}`,
							onClick: () => { void onSwitch?.(p); },
						}, switching === p.id ? "切换中…" : "切换使用") : null),
				account ? e("div", { style: { ...css.muted, marginTop: 3, overflowWrap: "anywhere" } },
					account.label) : null,
				stale ? e("div", { style: { ...css.error, marginTop: 6 } }, p.error ?? "额度信息未能更新，仍显示上次查询的结果。") : null,
				stale && Number.isFinite(p.staleAt) ? e("div", { style: { ...css.muted, marginTop: 6 } },
					`上次成功于 ${new Date(p.staleAt).toLocaleString("zh-CN", { hour12: false })}`) : null,
				p.status === "ok" || stale
					? [
						...windows.map((w, i) => e(QuotaWindow, { key: `${p.id}\u0000${i}`, w })),
						p.note ? e("div", { style: { ...css.muted, marginTop: 6 } }, p.note) : null,
						p.status === "ok" && windows.length === 0 && !p.note ? e("div", { style: { ...css.muted, marginTop: 6 } }, "接口没有返回窗口额度。") : null,
					]
					: null,
				p.status === "pending" ? e("div", { style: { ...css.muted, marginTop: 6 } }, "尚未查询。") : null,
				p.status === "unconfigured" ? e("div", { style: { ...css.muted, marginTop: 6 } }, p.error ?? "未找到该 provider 的凭据。") : null,
				p.status === "error" ? e("div", { style: { ...css.error, marginTop: 6 } }, p.error ?? "查询失败。") : null);
		}

		function activeCodex(data) {
			return data?.providers?.find((p) => p.providerId === "openai-codex" && p.account?.active === true);
		}

		async function readQuotaSnapshot() {
			const response = await fetch(`/usage-lite/quotas?t=${Date.now()}`, { headers: { accept: "application/json" } });
			if (!response.ok) throw new Error("quota snapshot unavailable");
			const data = await response.json();
			if (data?.ok !== true || !Array.isArray(data.providers)) throw new Error("invalid quota snapshot");
			return data;
		}

		function watchQuotaRenewal(onStatus) {
			const controller = new AbortController();
			let timer;
			let remaining = RENEWAL_POLL_LIMIT;
			async function poll() {
				if (controller.signal.aborted) return;
				remaining--;
				try {
					const response = await fetch("/usage-lite/quotas/renewal-status", {
						headers: { accept: "application/json" }, mode: "same-origin", cache: "no-store", redirect: "error",
						signal: controller.signal,
					});
					if (response.status === 401 || response.status === 403) return;
					if (response.ok) {
						const data = await response.json();
						if (!controller.signal.aborted && typeof data?.renewing === "boolean") onStatus(data.renewing);
					}
				} catch { /* Progress is advisory; the manual request owns the outcome. */ }
				if (!controller.signal.aborted && remaining > 0) timer = setTimeout(poll, RENEWAL_POLL_MS);
			}
			timer = setTimeout(poll, RENEWAL_POLL_MS);
			return () => {
				clearTimeout(timer);
				controller.abort();
			};
		}

		function QuotaSection() {
			const [state, setState] = React.useState({ data: null, busy: false, renewing: false, error: null, switching: null, notice: null });
			const operationLock = React.useRef(false);
			const requestVersion = React.useRef(0);
			const mounted = React.useRef(true);
			const renewalPoll = React.useRef(null);
			const refresh = React.useCallback(async (renew = null) => {
				if (!mounted.current || operationLock.current) return;
				operationLock.current = true;
				const version = ++requestVersion.current;
				const isCurrent = () => version === requestVersion.current;
				setState((prev) => ({ ...prev, busy: true, renewing: false, error: null, notice: null }));
				let stopPolling = null;
				const stopProgress = () => {
					if (stopPolling === null) return;
					stopPolling();
					if (renewalPoll.current === stopPolling) renewalPoll.current = null;
					stopPolling = null;
				};
				try {
					if (renew) {
						stopPolling = renewalPoll.current = watchQuotaRenewal((renewing) => {
							if (isCurrent()) setState((prev) => prev.renewing === renewing ? prev : { ...prev, renewing });
						});
					}
					const response = renew
						? await fetch("/usage-lite/quotas/renew", {
							method: "POST", mode: "same-origin", redirect: "error",
							headers: { accept: "application/json", "content-type": "application/json", "x-usage-lite-action": "renew-codex" },
							body: JSON.stringify(renew),
						})
						: await fetch("/usage-lite/quotas/refresh", { method: "POST", headers: { accept: "application/json" } });
					stopProgress();
					if (!isCurrent()) return;
					if (response.status === 401 || response.status === 403) {
						setState((prev) => ({ ...prev, error: "未获授权，请重新登录或刷新当前 DSH 页面后再查询。" }));
						return;
					}
					if (renew && response.status === 409) {
						// The authorized conflict may include a fresh snapshot. If not, only reconcile by GET.
						const conflict = await response.json().catch(() => null);
						if (!isCurrent()) return;
						const data = Array.isArray(conflict?.providers) ? conflict : await readQuotaSnapshot().catch(() => null);
						if (isCurrent()) setState((prev) => ({
							...prev, data: data ?? prev.data,
							error: "当前账号状态已变化，或已有操作正在进行。请核对「DSH 当前使用」标记；未自动重试续期。",
						}));
						return;
					}
					if (!response.ok) throw new Error("quota query failed");
					const data = await response.json();
					if (data?.ok !== true || !Array.isArray(data.providers)) throw new Error("invalid quota snapshot");
					if (renew && (activeCodex(data)?.id !== renew.expectedActiveId
						|| data.activeAccountTag !== renew.expectedActiveAccountTag)) {
						throw new Error("active account changed");
					}
					if (isCurrent()) setState((prev) => ({
						...prev, data, notice: renew && typeof data.message === "string" && data.message ? data.message : null,
					}));
				} catch {
					stopProgress();
					if (!isCurrent()) return;
					// A failed manual request may already have written credentials. Never repeat it or POST a fallback.
					if (renew) setState((prev) => ({ ...prev, renewing: false }));
					const data = renew ? await readQuotaSnapshot().catch(() => null) : null;
					if (isCurrent()) setState((prev) => ({
						...prev, data: data ?? prev.data,
						error: renew ? "无法确认本次查询结果。请核对当前账号和额度；未自动重试续期。" : "查询失败，请稍后重试。",
					}));
				} finally {
					stopProgress();
					if (isCurrent()) {
						operationLock.current = false;
						setState((prev) => ({ ...prev, busy: false, renewing: false }));
					}
				}
			}, []);
			const switchAccount = async (target) => {
				if (!mounted.current || operationLock.current || state.data?.canSwitch === false
					|| target.providerId !== "openai-codex" || target.account?.switchable !== true || target.account.active === true) return;
				const active = activeCodex(state.data);
				const activeTag = active ? state.data.activeAccountTag : null;
				if (active && (typeof activeTag !== "string" || !activeTag)) {
					setState((prev) => ({ ...prev, notice: null, error: "无法确认当前账号，请刷新页面后再切换。" }));
					return;
				}
				// Only this explicit confirmation can dispatch the write request.
				if (!window.confirm(`确认全局切换 GPT 订阅？\n\n从：${active?.account.label ?? "未连接"}\n切换到：${target.account.label}\n\n此后所有 GPT 会话的新模型请求（含后续自动执行）都会使用这个账号，不只是当前对话。不会清空对话或重启 DSH；已发出的请求不主动中断。`)) return;
				operationLock.current = true;
				const version = ++requestVersion.current;
				const isCurrent = () => version === requestVersion.current;
				setState((prev) => ({ ...prev, switching: target.id, error: null, notice: null }));
				try {
					const response = await fetch("/usage-lite/accounts/switch", {
						method: "POST",
						headers: { accept: "application/json", "content-type": "application/json", "x-usage-lite-action": "switch-account" },
						body: JSON.stringify({ id: target.id, expectedActiveId: active?.id ?? null, expectedActiveAccountTag: activeTag, confirmed: true }),
					});
					if (!isCurrent()) return;
					if (response.status === 401 || response.status === 403) {
						setState((prev) => ({ ...prev, error: "未获授权，请重新登录或从当前 DSH 页面切换账号。" }));
						return;
					}
					const data = await response.json();
					if (!response.ok || data?.ok !== true || activeCodex(data)?.id !== target.id) throw new Error("switch outcome not confirmed");
					if (isCurrent()) setState((prev) => ({
						...prev, data, notice: `已全局切换到 ${target.account.label}，之后所有 GPT 新请求使用此账号。`,
					}));
				} catch {
					if (!isCurrent()) return;
					const data = await readQuotaSnapshot().catch(() => null);
					if (isCurrent()) setState((prev) => ({
						...prev, data: data ?? prev.data, error: "切换结果未确认。请核对「DSH 当前使用」标记；未自动重试切换。",
					}));
				} finally {
					if (isCurrent()) {
						operationLock.current = false;
						setState((prev) => ({ ...prev, switching: null }));
					}
				}
			};
			React.useEffect(() => {
				mounted.current = true;
				const version = ++requestVersion.current;
				void (async () => {
					try {
						const data = await readQuotaSnapshot();
						if (version !== requestVersion.current) return;
						setState((prev) => ({ ...prev, data, error: null }));
						const queriedAt = data.queriedAt;
						// Page opens may refresh a stale snapshot, but cannot renew credentials.
						if (typeof queriedAt !== "number" || Date.now() - queriedAt >= QUOTA_AUTO_REFRESH_MS) await refresh();
					} catch {
						if (version === requestVersion.current) setState((prev) => ({ ...prev, error: "读取额度失败，可尝试手动查询。" }));
					}
				})();
				return () => {
					mounted.current = false;
					++requestVersion.current;
					operationLock.current = false;
					renewalPoll.current?.();
					renewalPoll.current = null;
				};
			}, [refresh]);
			const queriedAt = state.data?.queriedAt;
			const disabled = state.busy || state.switching !== null;
			const canSwitch = state.data?.canSwitch !== false;
			const queryOnClick = () => {
				const active = activeCodex(state.data);
				const tag = state.data?.activeAccountTag;
				const renew = state.data?.canRenew === true && typeof active?.id === "string" && active.id
					&& typeof tag === "string" && tag
					? { expectedActiveId: active.id, expectedActiveAccountTag: tag } : null;
				return refresh(renew);
			};
			return e("div", null,
				e("div", { style: css.headRow },
					e("div", { style: { ...css.sectionTitle, margin: 0 } }, "订阅额度"),
					e("span", { style: css.muted },
						queriedAt == null
							? "尚未查询 · 点右侧按钮手动查询"
							: `查询于 ${new Date(queriedAt).toLocaleTimeString("zh-CN", { hour12: false })}`),
					e("div", { style: { flex: 1 } }),
					e("button", {
						type: "button",
						style: disabled ? { ...css.button, ...css.buttonDisabled } : css.button,
						disabled,
						onClick: queryOnClick,
					}, state.busy ? "查询中…（几秒）" : "查询额度")),
				state.renewing ? e("div", { role: "status", style: css.muted }, "正在续期当前账号…") : null,
				state.error === null ? null : e("div", { role: "alert", style: css.error }, state.error),
				state.notice === null ? null : e("div", { role: "status", style: css.muted }, state.notice),
				canSwitch ? e("div", { style: { ...css.muted, margin: "4px 0 8px" } }, "切换为全局生效，影响所有 GPT 会话的新请求；点击后需再次确认。") : null,
				e("div", { style: css.quotaGrid },
					(state.data?.providers ?? []).map((p) => e(QuotaProviderCard, {
						key: p.id, p, onSwitch: switchAccount, switching: state.switching, disabled, canSwitch,
					}))));
		}

		function StatsPage() {
			const [state, setState] = React.useState({ status: "loading", data: null, error: null, range: "all", fetchedAt: 0 });
			const load = React.useCallback(async () => {
				setState((prev) => ({ ...prev, status: prev.data === null ? "loading" : "refreshing", error: null }));
				try {
					const response = await fetch(`${STATS_URL}?t=${Date.now()}`, { headers: { accept: "application/json" } });
					if (!response.ok) throw new Error(`HTTP ${response.status}`);
					const data = await response.json();
					if (data?.ok !== true) throw new Error("unexpected payload");
					setState((prev) => ({ ...prev, status: "ok", data, fetchedAt: Date.now() }));
				} catch (error) {
					setState((prev) => ({ ...prev, status: prev.data === null ? "error" : "ok", error: String(error?.message ?? error) }));
				}
			}, []);
			React.useEffect(() => { void load(); }, [load]);
			React.useEffect(() => {
				const timer = setInterval(() => { void load(); }, 60000);
				return () => clearInterval(timer);
			}, [load]);

			if (state.status === "loading") return e("div", { style: css.muted }, "正在读取用量数据…");
			if (state.status === "error" || state.data === null) {
				const offlineHint = typeof location !== "undefined" && !/^https?:$/.test(location.protocol)
					? "当前窗口不是 HTTP 页面（Electron/桌面窗口），请在浏览器版 Web GUI 打开本页。"
					: null;
				return e("div", { style: css.wrap },
					e("div", { style: css.error }, "读取用量数据失败：", state.error ?? "未知错误"),
					offlineHint === null ? null : e("div", { style: css.muted }, offlineHint),
					e("div", null, e("button", { style: css.button, onClick: () => { void load(); } }, "重试")));
			}

			const view = sliceByRange(state.data, state.range);
			const t = view.totals;
			const grand = (t.input ?? 0) + (t.output ?? 0) + (t.cacheRead ?? 0) + (t.cacheWrite ?? 0);
			const hit = rate(t.cacheRead ?? 0, t.input ?? 0);
			const updated = new Date(state.data.generatedAt).toLocaleTimeString("zh-CN", { hour12: false });

			return e("div", { style: css.wrap },
				e("div", { style: css.headRow },
					e("div", { style: { flex: 1 } },
						e("div", { style: css.title }, "Token 用量总览"),
						e("div", { style: css.muted },
							`共 ${formatInt(state.data.sessions)} 个会话，其中 ${formatInt(state.data.sessionsWithUsage)} 个有模型调用；`
							+ `累计 ${formatInt(t.calls ?? 0)} 次计费调用 · 更新于 ${updated}`)),
					e("button", { style: css.button, onClick: () => { void load(); } },
						state.status === "refreshing" ? "刷新中…" : "刷新")),
				e(QuotaSection, null),
				e("div", { style: css.rangeRow },
					RANGES.map((r) => e("button", {
						key: r.id, style: css.rangeBtn(state.range === r.id),
						onClick: () => setState((prev) => ({ ...prev, range: r.id })),
					}, r.label))),
				e("div", { style: css.cards },
					SummaryCard("总 Tokens", formatCompact(grand), formatInt(grand)),
					SummaryCard("输入（未缓存）", formatCompact(t.input ?? 0)),
					SummaryCard("缓存读", formatCompact(t.cacheRead ?? 0), hit === null ? null : `命中率 ${(hit * 100).toFixed(1)}%`),
					SummaryCard("缓存写", formatCompact(t.cacheWrite ?? 0)),
					SummaryCard("输出", formatCompact(t.output ?? 0), (t.reasoning ?? 0) > 0 ? `含推理 ${formatCompact(t.reasoning)}` : void 0)),
				e(DailyChart, { days: view.days }),
				e("div", null,
					e("div", { style: css.sectionTitle }, "按模型"),
					e(ModelTable, { models: view.models })),
				e("div", null,
					e("div", { style: css.sectionTitle }, "按工作区（全部时间）"),
					e(WorkspaceTable, { workspaces: view.workspaces })));
		}

		// ── 设置页导航图标 ─────────────────────────────────────────────────────
		// 宿主 ui-settings-general 的 navIcon(id) 按 id 硬编码图标，第三方分区一律
		// 回落齿轮 ⇒ 与「设置」撞色。settings.section 槽位契约只有 id/order/label，
		// 没有 icon 字段。解法（与 dsh-usage-heatmap 等生态插件一致）：按本插件的
		// label 文本认领自己那一行、打 data 标记，再用独立样式表把齿轮换成柱状图
		// （CSS mask 只读 alpha，颜色用 currentColor 自动跟随 hover/active 主题色）。
		// 只标记可见文本与 label 完全相等的那一行，不碰外壳结构；宿主 DOM 变化时静默失效。
		var NAV_ICON_MARKER = "data-ul-nav-icon";
		var NAV_ROW_SELECTOR = '[role="dialog"] nav button';
		var NAV_ICON_MASK = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cg fill='%23000'%3E%3Crect x='2' y='9' width='3.2' height='5' rx='.8'/%3E%3Crect x='6.4' y='5' width='3.2' height='9' rx='.8'/%3E%3Crect x='10.8' y='2' width='3.2' height='12' rx='.8'/%3E%3C/g%3E%3C/svg%3E\")";
		function navIconCss() {
			return [
				"[" + NAV_ICON_MARKER + "] > svg { display: none; }",
				"[" + NAV_ICON_MARKER + "]::before {",
				"  content: '';",
				"  flex: none;",
				"  width: 16px;",
				"  height: 16px;",
				"  background-color: currentColor;",
				"  -webkit-mask-image: " + NAV_ICON_MASK + ";",
				"  mask-image: " + NAV_ICON_MASK + ";",
				"  -webkit-mask-repeat: no-repeat;",
				"  mask-repeat: no-repeat;",
				"  -webkit-mask-position: center;",
				"  mask-position: center;",
				"  -webkit-mask-size: 16px 16px;",
				"  mask-size: 16px 16px;",
				"}"
			].join("\n");
		}
		function installNavIcon() {
			if (typeof document === "undefined" || !document.body) return function () {};
			var tag = document.createElement("style");
			tag.id = "ul-usage-lite-nav-icon-style";
			tag.textContent = navIconCss();
			document.head.appendChild(tag);
			var disposed = false;
			var scheduled = false;
			function sync() {
				scheduled = false;
				if (disposed) return;
				if (!document.querySelector('[role="dialog"]')) return;
				var rows = document.querySelectorAll(NAV_ROW_SELECTOR);
				for (var i = 0; i < rows.length; i++) {
					var row = rows[i];
					if (String(row.textContent || "").trim() === "用量统计") row.setAttribute(NAV_ICON_MARKER, "");
					else row.removeAttribute(NAV_ICON_MARKER);
				}
			}
			function schedule() {
				if (scheduled || disposed) return;
				scheduled = true;
				(typeof queueMicrotask === "function" ? queueMicrotask : function (f) { setTimeout(f, 0); })(sync);
			}
			sync();
			var observer = null;
			try {
				observer = new MutationObserver(schedule);
				observer.observe(document.body, { childList: true, subtree: true });
			} catch {}
			return function () {
				disposed = true;
				try { if (observer) observer.disconnect(); } catch {}
				var marked = document.querySelectorAll("[" + NAV_ICON_MARKER + "]");
				for (var i = 0; i < marked.length; i++) try { marked[i].removeAttribute(NAV_ICON_MARKER); } catch {}
				try { tag.remove(); } catch {}
			};
		}

		// ── 注册 ─────────────────────────────────────────────────────────────
		function apply(ctx) {
			try {
				ctx.slots?.inject?.("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: "usage-lite",
					// 置顶：设置页默认选中 = order 最小的分区（账号=-10、通用=0），
					// -20 让「打开设置第一眼」就是用量统计。
					order: -20,
					label: "用量统计",
				}, StatsPage));
			} catch (error) {
				console.error("[dsh-usage-lite] failed to register settings section", error);
			}
			if (ctx.effect) ctx.effect(() => installNavIcon(), "dsh-usage-lite: settings nav icon");
			else installNavIcon();
		}

		const inject = ["slots"];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
