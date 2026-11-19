import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { TokenRefreshError } from "./quota-transport.mjs";

export const CODEX_KEY = "llm-pi-ai/openai-codex";
const hash = (value) => createHash("sha256").update(value).digest("hex");
export const accountTag = (accountId) => typeof accountId === "string" && accountId ? hash(`codex-account:${accountId}`) : null;
export const oauthPayload = (record) => record?.kind === "grant" && record.payload?.type === "oauth" && typeof record.payload.accountId === "string" && record.payload.accountId ? record.payload : null;
export const canModifyCodex = (credentials) => typeof credentials?.modifyRecord === "function";

export function jwtClaims(access) {
  try {
    const claims = JSON.parse(Buffer.from(access.split(".")[1], "base64url").toString("utf8"));
    return claims && typeof claims === "object" ? claims : {};
  } catch { return {}; }
}

export const tokenAccountId = (access) => jwtClaims(access)["https://api.openai.com/auth"]?.chatgpt_account_id;
export function accessExpired(payload, deadline = Date.now()) {
  return [Number(payload?.expires), Number(jwtClaims(payload?.access).exp) * 1000]
    .some((expiry) => Number.isFinite(expiry) && expiry > 0 && expiry <= deadline);
}
export const sameGrant = (a, b) => a?.accountId === b?.accountId && a?.access === b?.access && a?.refresh === b?.refresh && Number(a?.expires || 0) === Number(b?.expires || 0);

const MESSAGES = {
  conflict: "当前 Codex 账号已变化，请刷新后重试",
  unavailable: "当前环境不支持安全续期，请到设置 → 模型重新登录",
  rejected: "当前账号登录已失效，请到设置 → 模型重新登录",
  unknown: "续期结果未确认，未重发旧令牌；若仍过期，请到设置 → 模型重新登录",
};

export class CodexRenewalError extends Error {
  constructor(kind) { super(MESSAGES[kind]); this.kind = kind; }
}

/** Retain a fingerprint, never a token, if the outcome cannot be confirmed. */
export function createRenewalJournal(directory) {
  return async (refresh) => {
    const file = join(directory, hash(`codex-refresh:${refresh}`));
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const dir = await lstat(directory);
      if (!dir.isDirectory() || (dir.mode & 0o077) !== 0) throw new CodexRenewalError("unavailable");
      const handle = await open(file, "wx", 0o600);
      try { await handle.writeFile("pending"); await handle.sync(); }
      finally { await handle.close(); }
    } catch (error) {
      if (error?.code !== "EEXIST") throw new CodexRenewalError("unavailable");
      let rejected = false;
      try {
        const info = await lstat(file);
        if (info.isFile() && info.size === 8 && !(info.mode & 0o077)) {
          const existing = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try {
            const data = Buffer.alloc(8);
            rejected = (await existing.read(data)).bytesRead === 8 && data.toString() === "rejected";
          } finally { await existing.close(); }
        }
      } catch {}
      throw new CodexRenewalError(rejected ? "rejected" : "unknown");
    }
    return {
      rejected: async () => {
        try {
          const handle = await open(file, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          try { await handle.writeFile("rejected"); await handle.sync(); }
          finally { await handle.close(); }
        } catch {}
      },
      committed: () => unlink(file).catch(() => {}),
    };
  };
}

export async function rotateGrant(payload, { refreshTokens, journal, onRenewing = () => {} }) {
  if (typeof payload.refresh !== "string" || !payload.refresh) throw new CodexRenewalError("rejected");
  const claimed = tokenAccountId(payload.access);
  if (claimed !== undefined && claimed !== payload.accountId) throw new CodexRenewalError("rejected");
  const attempt = await journal(payload.refresh);
  let updated;
  try {
    onRenewing(true);
    updated = await refreshTokens(payload.refresh);
    if (typeof updated?.access !== "string" || tokenAccountId(updated.access) !== payload.accountId || typeof updated.refresh !== "string" || !updated.refresh || !Number.isFinite(updated.expires) || updated.expires <= Date.now() || accessExpired(updated)) throw new CodexRenewalError("unknown");
  } catch (error) {
    if (error instanceof TokenRefreshError && error.kind === "rejected") {
      await attempt.rejected();
      throw new CodexRenewalError("rejected");
    }
    throw new CodexRenewalError("unknown");
  }
  return { payload: { ...payload, access: updated.access, refresh: updated.refresh, expires: updated.expires }, attempt };
}

export async function renewActiveCodex({ credentials, expected, refreshTokens, journal, onRenewing = () => {} }) {
  if (!canModifyCodex(credentials)) throw new CodexRenewalError("unavailable");
  let attempt;
  try {
    const stored = await credentials.modifyRecord(CODEX_KEY, async (record) => {
      const current = oauthPayload(record);
      if (!current || current.accountId !== expected.accountId) throw new CodexRenewalError("conflict");
      // A GPT request or sign-in can win the race. Never use the old refresh token.
      if (!sameGrant(current, expected)) return undefined;
      const rotated = await rotateGrant(current, { refreshTokens, journal, onRenewing });
      attempt = rotated.attempt;
      return { ...record, payload: rotated.payload };
    });
    if (attempt) await attempt.committed();
    const payload = oauthPayload(stored);
    if (!payload || payload.accountId !== expected.accountId) throw new CodexRenewalError("conflict");
    return { payload, renewed: Boolean(attempt) };
  } catch (error) {
    if (error instanceof CodexRenewalError) throw error;
    throw new CodexRenewalError(attempt ? "unknown" : "unavailable");
  } finally { onRenewing(false); }
}
