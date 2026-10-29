import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, discoverCodexAccounts } from "./index.mjs";

const jwt = (claims) => `test.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const payload = (accountId, access = jwt({ email: `${accountId}@example.test` }), expires = Date.now() + 3600000) => ({ accountId, access, expires, refresh: "NEVER-REFRESH-THIS-TOKEN" });
const yaml = (p) => `records:\n  llm-pi-ai/openai-codex:\n    payload:\n${Object.entries(p).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`).join("\n")}\n`;
async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "usage-lite-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return {
    home,
    current: (p) => writeFile(join(home, ".credentials.yaml"), yaml(p)),
    snapshot: async (label, p, meta = {}) => {
      const dir = join(home, "accounts", label);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "credential.yaml"), yaml(p));
      await writeFile(join(dir, "meta.json"), JSON.stringify(meta));
    },
  };
}
function host(home, fakeCurl) {
  let handler;
  const cleanups = [];
  const logs = [];
  apply({
    get: (key) => key === "dshHomePath" ? (...parts) => join(home, ...parts) : undefined,
    logger: { warn: (s) => logs.push(s), error: (s) => logs.push(s) },
    sessionQuery: { listSessions: async () => [], readSession: async () => ({ events: [] }) },
    webServer: { register: (route) => { handler = route.handler; } },
    effect: (fn) => { const dispose = fn(); if (dispose) cleanups.push(dispose); },
  }, { quotaExecFile: fakeCurl });
  return {
    logs,
    close: () => cleanups.forEach((fn) => fn()),
    get: async (refresh = false) => {
      let body;
      await handler({ method: "GET", url: `/usage-lite/quotas${refresh ? "?refresh=1" : ""}` }, {
        writeHead: () => {}, end: (s) => { body = s; },
      });
      return JSON.parse(body);
    },
  };
}
const successBody = JSON.stringify({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 27, limit_window_seconds: 18000 } } });
const success = (_file, _args, _opts, cb) => cb(null, `${successBody}\n200`, "");
const codex = (result) => result.providers.filter((p) => p.providerId === "openai-codex");

test("discovery deduplicates IDs, skips hidden/_previous, and always substitutes live payload", async (t) => {
  const f = await fixture(t);
  const live = payload("a", jwt({ "https://api.openai.com/profile": { email: "live@example.test" } }));
  await f.current(live);
  await f.snapshot("alpha", payload("a", "STALE-SNAPSHOT", 1), { email: "stale@example.test" });
  await f.snapshot("duplicate", payload("a"));
  await f.snapshot("beta", payload("b", "opaque-token"), { email: "metadata@example.test" });
  await f.snapshot(".hidden", payload("hidden"));
  await f.snapshot("_previous", payload("previous"));
  const accounts = await discoverCodexAccounts(f.home);
  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts[0].account, { label: "alpha", email: "live@example.test", active: true });
  assert.deepEqual(accounts[0].payload, { ...live, expires: String(live.expires) });
  assert.equal(accounts[1].account.email, "metadata@example.test");
  assert.equal(accounts[1].account.active, false);
});

test("without snapshots there is one current card, including missing credentials", async (t) => {
  const f = await fixture(t);
  assert.equal((await discoverCodexAccounts(f.home)).length, 1);
  await f.current(payload("current"));
  const h = host(f.home, success); t.after(h.close);
  const result = await h.get(true);
  assert.equal(codex(result).length, 1);
  assert.equal(codex(result)[0].id, "openai-codex:current");
  assert.equal(codex(result)[0].account.active, true);
  assert.equal(result.providers.find((p) => p.id === "zai-coding-cn").status, "unconfigured");
});

test("queries accounts independently; expired snapshots never send requests or refresh", async (t) => {
  const f = await fixture(t);
  const live = payload("a", "LIVE-ACCESS");
  await f.current(live);
  await f.snapshot("alpha", payload("a", "STALE-ACCESS", 1));
  await f.snapshot("beta", payload("b", "EXPIRED-ACCESS", 1));
  await f.snapshot("gamma", payload("c", jwt({ exp: 1 })));
  await f.snapshot("delta", payload("d", "VALID-OTHER"));
  const before = await readFile(join(f.home, ".credentials.yaml"), "utf8");
  const requests = [];
  const h = host(f.home, (file, args, opts, cb) => {
    requests.push(args);
    if (args.includes("chatgpt-account-id: d")) cb(null, "{}\n401", "");
    else success(file, args, opts, cb);
  }); t.after(h.close);
  const result = await h.get(true);
  const cards = codex(result);
  assert.equal(cards.find((p) => p.account.label === "alpha").status, "ok");
  for (const label of ["beta", "gamma", "delta"]) {
    const card = cards.find((p) => p.account.label === label);
    assert.equal(card.status, "error");
    assert.match(card.error, new RegExp(label));
    assert.match(card.error, /切换.*重新登录/);
  }
  // Either the credential expiry or JWT expiry can mark an account expired.
  assert.equal(requests.length, 2);
  assert.ok(requests.flat().includes("Authorization: Bearer LIVE-ACCESS"));
  assert.ok(!requests.flat().some((v) => v.includes("STALE-ACCESS") || v.includes("EXPIRED-ACCESS") || v.includes("NEVER-REFRESH")));
  assert.equal(await readFile(join(f.home, ".credentials.yaml"), "utf8"), before);
  assert.ok(!JSON.stringify(result).includes("LIVE-ACCESS"));
  assert.ok(!(await readFile(join(f.home, "usage-lite", "quotas.json"), "utf8")).includes("LIVE-ACCESS"));
});

test("JWT expiry fallback blocks expired access without refreshing", async (t) => {
  const f = await fixture(t);
  const p = payload("expired", jwt({ exp: 1 })); delete p.expires;
  await f.current(p);
  const h = host(f.home, () => assert.fail("expired token must not be queried")); t.after(h.close);
  assert.match(codex(await h.get(true))[0].error, /重新登录/);
});

test("cached GET and reloaded cache derive active flags afresh after switching", async (t) => {
  const f = await fixture(t);
  await f.current(payload("a"));
  await f.snapshot("alpha", payload("a"));
  await f.snapshot("beta", payload("b"));
  let requests = 0;
  const curl = (...args) => { requests++; success(...args); };
  const h = host(f.home, curl); t.after(h.close);
  await h.get(true);
  assert.equal(requests, 2);
  await f.current(payload("b"));
  for (const instance of [h, host(f.home, curl)]) {
    if (instance !== h) t.after(instance.close);
    const result = await instance.get();
    assert.equal(result.version, 2);
    assert.equal(codex(result).find((p) => p.account.label === "alpha").account.active, false);
    assert.equal(codex(result).find((p) => p.account.label === "beta").account.active, true);
    assert.ok(codex(result).every((p) => p.status === "ok"));
  }
  assert.equal(requests, 2);
});

test("curl callback errors, thrown exceptions, and server bodies cannot leak tokens", async (t) => {
  const f = await fixture(t);
  await f.current(payload("a", "SECRET-ACCESS-TOKEN"));
  await f.snapshot("alpha", payload("a"));
  await f.snapshot("beta", payload("b", "SECOND-SECRET"));
  await f.snapshot("gamma", payload("c", "THIRD-SECRET"));
  const h = host(f.home, (_file, args, _opts, cb) => {
    if (args.includes("chatgpt-account-id: a")) cb(new Error(`Command failed ${args.join(" ")}`), "SECRET-ACCESS-TOKEN", "SECRET-ACCESS-TOKEN");
    else if (args.includes("chatgpt-account-id: b")) throw new Error("SECOND-SECRET");
    else cb(null, '{"detail":"THIRD-SECRET"}\n500', "");
  }); t.after(h.close);
  const result = await h.get(true);
  assert.ok(codex(result).every((p) => p.status === "error"));
  const exposed = JSON.stringify([result, h.logs, await readFile(join(f.home, "usage-lite", "quotas.json"), "utf8")]);
  for (const secret of ["SECRET-ACCESS-TOKEN", "SECOND-SECRET", "THIRD-SECRET", "NEVER-REFRESH"]) assert.ok(!exposed.includes(secret));
});
