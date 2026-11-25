import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { apply } from "./index.mjs";

// All paths and credentials passed to Host are fixture-owned; no subprocess or HTTP server.
export const key = "llm-pi-ai/openai-codex";
export const jwt = (id, exp = Math.floor(Date.now() / 1000) + 7200, marker = "signature") => `fake.${Buffer.from(JSON.stringify({ exp, "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.${marker}`;
export const grant = (accountId, updates = {}) => ({ type: "oauth", accountId, access: jwt(accountId), refresh: `FAKE-REFRESH-${accountId}`, expires: Date.now() + 7200000, ...updates });
export const block = (payload, kind = "grant") => `  ${key}:\n    kind: ${kind}\n    payload:\n${Object.entries(payload).map(([name, value]) => `      ${name}: ${JSON.stringify(value)}`).join("\n")}\n`;
export const livePrefix = "# unchanged prefix\nrefs:\n  OTHER_KEY: fake-unrelated-key\nrecords:\n  unrelated/provider:\n    kind: secret\n    payload:\n      access: fake-unrelated-access\n";
export const liveSuffix = "  after/provider:\n    payload:\n      nested: unchanged\n# unchanged suffix\n";
export const quotaReply = (rateLimit = {}) => ({ status: 200, text: JSON.stringify({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 }, ...rateLimit } }), timedOut: false });

export function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

export async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "usage-lite-host-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const livePath = join(home, ".credentials.yaml");
  const live = () => readFile(livePath, "utf8");
  const current = async (fields, mode = 0o600, kind = "grant") => {
    await writeFile(livePath, `${livePrefix}${block(fields, kind)}${liveSuffix}`, { mode });
    await chmod(livePath, mode);
  };
  const snapshot = async (label, fields, mode = 0o600) => {
    const dir = join(home, "accounts", label);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "credential.yaml"), `records:\n${block(fields)}`, { mode });
    await chmod(join(dir, "credential.yaml"), mode);
    await writeFile(join(dir, "meta.json"), JSON.stringify({ accountId: fields.accountId, custom: "retained" }), { mode });
    await chmod(join(dir, "meta.json"), mode);
    return dir;
  };
  const saved = (label) => readFile(join(home, "accounts", label, "credential.yaml"), "utf8");

  // Deliberately only decodes our fixture YAML. The fake service, not the Host,
  // writes the live record; unrelated text doubles as a direct-write sentinel.
  const parse = (text) => {
    const match = new RegExp(`^  ${key}:\\n    kind: ([^\\n]+)\\n    payload:\\n((?: {6}[^\\n]*\\n)+)`, "m").exec(text);
    if (!match) return {};
    const payload = Object.fromEntries(match[2].trimEnd().split("\n").map((row) => {
      const [, name, raw] = /^ {6}([^:]+): (.+)$/.exec(row);
      return [name, JSON.parse(raw)];
    }));
    return { match, record: { kind: match[1], payload } };
  };
  const readDocument = () => live().catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
  let queue = Promise.resolve();
  const notices = [];
  const store = {
    calls: 0,
    writes: 0,
    locked: false,
    beforeModify: null,
    beforeSave: null,
    notices,
    read: async () => parse(await readDocument()).record,
    modifyRecord(name, mutate) {
      assert.equal(name, key);
      store.calls++;
      const run = queue.then(async () => {
        store.locked = true;
        try {
          const beforeModify = store.beforeModify;
          store.beforeModify = null;
          await beforeModify?.();
          const text = await readDocument();
          const { match, record } = parse(text);
          const updated = await mutate(record);
          // DSH returns the current record for a no-op; it does not delete it.
          if (updated === undefined) { notices.push("noop"); return record; }
          await store.beforeSave?.(updated);
          const replacement = block(updated.payload, updated.kind);
          const next = match ? `${text.slice(0, match.index)}${replacement}${text.slice(match.index + match[0].length)}`
            : `${text || livePrefix}${replacement}${text ? "" : liveSuffix}`;
          await writeFile(livePath, next, { mode: 0o600 });
          store.writes++;
          notices.push("commit");
          return updated;
        } finally { store.locked = false; }
      });
      queue = run.catch(() => {});
      return run;
    },
  };
  return { home, live, livePath, current, snapshot, saved, store };
}

const owner = { principal: { kind: "owner" } };
function trustedAuthority({ origin, host }) {
  // Model the carrier's check before it calls the handler. The carrier retains
  // the public Host on a TLS proxy; X-Forwarded-* does not authorize requests.
  if (!host) return false;
  if (origin === undefined) return true;
  try {
    const url = new URL(origin);
    return ["http:", "https:"].includes(url.protocol) && url.host === new URL(`${url.protocol}//${host}`).host;
  } catch { return false; }
}

export function host(t, f, { quotaRequest = async () => assert.fail("unexpected quota request"), refreshTokens = async () => assert.fail("unexpected token refresh"), renewalEnabled = false, credentials = f.store, peer = owner } = {}) {
  let route;
  const cleanups = [];
  const logs = [];
  const requests = [];
  const refreshes = [];
  apply({
    get: (name) => ({
      dshHomePath: (...parts) => join(f.home, ...parts),
      credentials,
    })[name],
    logger: { warn: (...args) => logs.push(args.join(" ")), error: (...args) => logs.push(args.join(" ")) },
    sessionQuery: { listSessions: async () => [], readSession: async () => ({ events: [] }) },
    webServer: { register: (entry) => { route = entry; } },
    effect: (fn) => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); },
  }, {
    quotaRequest(url, options) { requests.push({ url, ...options }); return quotaRequest(url, options); },
    refreshTokens(...args) { refreshes.push(args); return refreshTokens(...args); },
    renewalEnabled,
  });
  t.after(() => cleanups.forEach((fn) => fn()));
  return {
    logs, requests, refreshes,
    get auth() { return route.auth; },
    async request(path, { method = "GET", body, headers = {}, socket = {} } = {}) {
      const req = Readable.from(body === undefined ? [] : [typeof body === "string" ? body : JSON.stringify(body)]);
      req.method = method;
      req.url = path;
      req.socket = socket;
      req.headers = { host: "localhost:1234", origin: "http://localhost:1234", "content-type": "application/json; charset=utf-8", ...headers };
      if (!trustedAuthority(req.headers)) return { ok: false, status: 403 };
      let status, result;
      await route.handler(req, { writeHead(code) { status = code; }, end(text) { result = JSON.parse(text); } }, peer ?? undefined);
      return { ...result, status };
    },
    get(refresh = false) { return this.request(`/usage-lite/quotas${refresh ? "?refresh=1" : ""}`); },
  };
}
