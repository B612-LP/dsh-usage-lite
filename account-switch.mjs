// Safe, preflight-first switching of the one global Codex credential record.
// No CLI subprocess is used: neither tokens nor upstream responses reach errors/logs.
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { accessExpired, accountTag, canModifyCodex, CODEX_KEY, CodexRenewalError, oauthPayload, rotateGrant, tokenAccountId } from "./codex-renewal.mjs";

const KEY = `  ${CODEX_KEY}:`;
const flights = new Set();

export class AccountSwitchError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const fail = (message, status = 400) => { throw new AccountSwitchError(message, status); };

function scalar(value) {
  if (value.startsWith('"')) { try { return JSON.parse(value); } catch { fail("账号快照格式不受支持"); } }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) fail("账号快照格式不受支持");
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (!value || /^[|>&*!{[]/.test(value) || /\s+#/.test(value)) fail("账号快照格式不受支持");
  return value;
}

/** Reader/editor for legacy account snapshots only; never writes the live document. */
export function codexRecord(text) {
  const lines = text.split("\n");
  const starts = lines.flatMap((line, i) => line === KEY ? [i] : []);
  if (starts.length !== 1) fail("缺少或重复的 Codex 凭据记录");
  const start = starts[0];
  // Accept CLI's standalone snapshot block, or a block in the actual records map.
  const root = lines.slice(0, start).findLast((line) => /^\S/.test(line) && !line.startsWith("#"));
  if (root !== undefined && root !== "records:") fail("Codex 凭据记录位置不正确");
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || /^ {3,}/.test(lines[end]))) end++;
  let payload = false;
  let payloads = 0;
  let kinds = 0;
  const fields = {};
  for (const line of lines.slice(start + 1, end)) {
    const kind = line.match(/^ {4}kind: *(.*)$/);
    if (kind && (++kinds > 1 || scalar(kind[1]) !== "grant")) fail("账号不是 OAuth grant 凭据");
    if (/^ {4}\S/.test(line)) {
      payload = line === "    payload:";
      if (payload) payloads++;
    }
    const match = payload && line.match(/^ {6}(access|refresh|expires|accountId|type): *(.*)$/);
    if (!match) continue;
    if (Object.hasOwn(fields, match[1])) fail("重复的账号凭据字段");
    fields[match[1]] = scalar(match[2]);
  }
  if (payloads !== 1 || typeof fields.accountId !== "string" || !fields.accountId) fail("账号快照缺少有效 accountId");
  if (fields.type !== undefined && fields.type !== "oauth") fail("账号不是 OAuth 登录凭据");
  return { fields, block: lines.slice(start, end).join("\n").replace(/\n+$/, ""), start, end, lines };
}

function withFields(text, updates) {
  const record = codexRecord(text);
  const lines = [...record.lines];
  const found = new Set();
  let payloadEnd = record.end;
  let inPayload = false;
  for (let i = record.start + 1; i < record.end; i++) {
    if (/^ {4}\S/.test(lines[i])) {
      if (inPayload) { payloadEnd = i; break; }
      inPayload = lines[i] === "    payload:";
    }
    const match = inPayload && lines[i].match(/^ {6}([^:]+):/);
    if (match && Object.hasOwn(updates, match[1])) {
      lines[i] = `      ${match[1]}: ${JSON.stringify(updates[match[1]])}`;
      found.add(match[1]);
    }
  }
  const extra = Object.entries(updates).filter(([key]) => !found.has(key)).map(([key, value]) => `      ${key}: ${JSON.stringify(value)}`);
  lines.splice(payloadEnd, 0, ...extra);
  return lines.join("\n");
}

function replaceRecord(text, block) {
  const { lines, start, end } = codexRecord(text);
  // Preserve the newline at the record boundary, including unrelated records/refs.
  const trailing = lines.slice(start, end).join("\n").match(/\n*$/)[0];
  return [...lines.slice(0, start), ...`${block}${trailing}`.split("\n"), ...lines.slice(end)].join("\n");
}

function readRegular(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) fail("凭据必须是普通文件，不能是链接");
  return { text: readFileSync(path, "utf8"), mode: info.mode & 0o777 };
}

function atomicWrite(path, text, expected = undefined) {
  try {
    const existing = readRegular(path);
    if (expected !== undefined && existing.text !== expected) fail("凭据已发生变化，请刷新后重试", 409);
  } catch (error) { if (error?.code !== "ENOENT") throw error; if (expected !== undefined) throw error; }
  const tmp = `${path}.usage-lite-${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, text, { flag: "wx", mode: 0o600 });
    // Recheck after staging, before the atomic replacement.
    if (expected !== undefined && readRegular(path).text !== expected) fail("凭据已发生变化，请刷新后重试", 409);
    renameSync(tmp, path);
  } finally { try { unlinkSync(tmp); } catch {} }
}

function snapshotFolder(home, label, create = false) {
  if (!label || label === "." || label === ".." || label.includes("/") || label.includes("\\") || label.includes("\0")) fail("无效的账号标识");
  const root = join(home, "accounts");
  if (create) mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) fail("账号目录不能是链接");
  const dir = join(root, label);
  if (create) { try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error?.code !== "EEXIST") throw error; } }
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) fail("账号快照目录不能是链接");
  return dir;
}

function saveSnapshot(home, label, block, fields) {
  const dir = snapshotFolder(home, label, true);
  const path = join(dir, "credential.yaml");
  let existing;
  try { existing = readRegular(path).text; } catch (error) { if (error?.code !== "ENOENT") throw error; }
  atomicWrite(path, existing === undefined ? `${block}\n` : replaceRecord(existing, block), existing);
  const metaPath = join(dir, "meta.json");
  let meta = {};
  let oldMeta;
  try { oldMeta = readRegular(metaPath).text; try { meta = JSON.parse(oldMeta); } catch {} } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) meta = {};
  atomicWrite(metaPath, `${JSON.stringify({ ...meta, label, accountId: fields.accountId, expires: Number(fields.expires) || null, savedAt: new Date().toISOString() }, null, 2)}\n`, oldMeta);
}

function checkIdentity(fields, accountId) {
  const claimed = tokenAccountId(fields.access);
  if (fields.accountId !== accountId || (claimed !== undefined && claimed !== accountId)) fail("目标登录凭据与账号不一致，请重新登录");
}

function snapshotBlock(payload) {
  // Quote arbitrary keys and serialize values as JSON (also valid flow YAML).
  const lines = Object.entries(payload).filter(([, value]) => value !== undefined).map(([key, value]) =>
    `      ${/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(key) ? key : JSON.stringify(key)}: ${JSON.stringify(value)}`);
  return [KEY, "    kind: grant", "    payload:", ...lines].join("\n");
}

/** Preflight never installs a target until its authenticated quota request succeeds. */
export async function switchCodexAccount({ dshHome, id, expectedActiveId, expectedActiveAccountTag, discover, queryQuota, credentials, refreshTokens, journal }) {
  if (!canModifyCodex(credentials)) fail("当前环境不支持安全切换 Codex 账号", 503);
  if (flights.has(dshHome)) fail("已有账号切换正在进行，请稍候", 409);
  flights.add(dshHome);
  try {
    const accounts = await discover(dshHome);
    const active = accounts.find((entry) => entry.account.active);
    if ((active?.id ?? null) !== expectedActiveId || accountTag(active?.payload?.accountId) !== expectedActiveAccountTag) fail("当前账号已变化，请刷新后重新确认", 409);
    const assertCurrent = (record) => {
      const payload = oauthPayload(record);
      if (active ? !payload || payload.accountId !== active.payload.accountId : record !== undefined) fail("当前账号已变化，请刷新后重新确认", 409);
      return payload;
    };
    const target = accounts.find((entry) => entry.id === id);
    if (!target?.account.switchable || target.providerId !== "openai-codex") fail("请选择可切换的已保存 Codex 账号");
    if (target.account.active) fail("该账号已经是当前账号", 409);
    const dir = snapshotFolder(dshHome, target.account.label);
    const targetPath = join(dir, "credential.yaml");
    let targetText = readRegular(targetPath).text;
    let { fields } = codexRecord(targetText);
    const accountId = target.payload.accountId;
    checkIdentity(fields, accountId);
    const assertTarget = () => {
      if (snapshotFolder(dshHome, target.account.label) !== dir || readRegular(targetPath).text !== targetText) fail("目标账号凭据已变化，请刷新后重试", 409);
    };
    const refresh = async () => {
      // A different Host may already have activated the target. Decide under
      // the same lock as live activation and model OAuth; never rotate a stale copy.
      await credentials.modifyRecord(CODEX_KEY, async (record) => {
        assertCurrent(record);
        assertTarget();
        const { payload, attempt } = await rotateGrant(fields, { refreshTokens, journal });
        // Persist the verified rotation before quota validation; never roll it back.
        const updated = withFields(targetText, { access: payload.access, refresh: payload.refresh, expires: payload.expires });
        atomicWrite(targetPath, updated, targetText);
        targetText = updated;
        fields = payload;
        await attempt.committed();
        return undefined;
      });
    };
    const refreshed = !fields.access || accessExpired(fields, Date.now() + 10 * 60 * 1000);
    if (refreshed) await refresh();
    let quota = await queryQuota(fields, target.account);
    // Unexpired but revoked access can still be recovered, once. Other errors
    // (network/403/etc.) never cause a speculative refresh/installation.
    if (quota?.unauthorized === true && !refreshed && fields.refresh) { await refresh(); quota = await queryQuota(fields, target.account); }
    if (quota?.status !== "ok") fail("目标账号额度验证失败，未切换；请检查登录或网络后重试", 502);
    checkIdentity(fields, accountId);

    // No quota network work in the final transaction. Save the freshest departure
    // grant (including a model rotation during preflight) under the DSH lock.
    const stored = await credentials.modifyRecord(CODEX_KEY, async (record) => {
      const current = assertCurrent(record);
      assertTarget();
      if (current) {
        const block = snapshotBlock(current);
        for (const entry of readdirSync(join(dshHome, "accounts"), { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "_previous") continue;
          const folder = snapshotFolder(dshHome, entry.name);
          let saved;
          try { saved = codexRecord(readRegular(join(folder, "credential.yaml")).text); } catch { continue; }
          if (saved.fields.accountId === current.accountId) saveSnapshot(dshHome, entry.name, block, current);
        }
        saveSnapshot(dshHome, "_previous", block, current);
      }
      const expires = Number(fields.expires);
      return { kind: "grant", payload: { type: "oauth", accountId, access: fields.access,
        ...(fields.refresh !== undefined ? { refresh: fields.refresh } : {}),
        ...(Number.isFinite(expires) && expires > 0 ? { expires } : {}) } };
    });
    if (oauthPayload(stored)?.accountId !== accountId) fail("无法确认账号已切换，请刷新核对", 409);
    return { id: target.id, accountId, quota, message: "已切换全局 Codex 账号，无需重启 DSH" };
  } catch (error) {
    if (error instanceof AccountSwitchError) throw error;
    if (error instanceof CodexRenewalError) fail(error.kind === "rejected" ? "目标账号登录已过期且无法续期，请重新登录" : "目标账号续期结果未确认，未重发旧令牌", 502);
    throw new AccountSwitchError("账号切换失败，请检查本地凭据或网络后重试", 500);
  } finally { flights.delete(dshHome); }
}
