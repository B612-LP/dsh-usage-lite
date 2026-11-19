import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverCodexAccounts } from "./index.mjs";
import { accountTag } from "./codex-renewal.mjs";
import { fixture, grant, host, quotaReply } from "./host-fixture.test-helpers.mjs";

test("malformed snapshots and JWT claims do not prevent independent discovery", async (t) => {
  const { home } = await fixture(t);
  for (const label of ["bad", "good"]) await mkdir(join(home, "accounts", label), { recursive: true });
  await writeFile(join(home, "accounts", "bad", "credential.yaml"), "not a record");
  await writeFile(join(home, "accounts", "bad", "meta.json"), "{invalid JSON");
  await writeFile(join(home, "accounts", "good", "credential.yaml"), "  llm-pi-ai/openai-codex:\n    payload:\n      accountId: good\n      access: test.bnVsbA.signature\n");
  await writeFile(join(home, "accounts", "good", "meta.json"), JSON.stringify({ email: "fallback@example.test" }));
  const accounts = await discoverCodexAccounts(home);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].account.email, "fallback@example.test");
  assert.equal(accounts[0].account.active, false);
});

test("old quota version is ignored and GLM quota fields remain unchanged", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.home, "usage-lite"));
  await writeFile(join(f.home, "usage-lite", "quotas.json"), JSON.stringify({ version: 2, providers: [{ id: "openai-codex", status: "ok" }] }));
  await writeFile(f.livePath, "refs:\n  ZAI_CODING_CN_API_KEY: FAKE-GLM-KEY\n", { mode: 0o600 });
  const h = host(t, f, { quotaRequest: async () => ({
    status: 200, timedOut: false,
    text: JSON.stringify({ success: true, data: { level: "Pro", limits: [{ type: "CREDIT_LIMIT", unit: 3, percentage: 10, usage: 100, currentValue: 10, remaining: 90, nextResetTime: 12345 }] } }),
  }) });
  const cached = await h.get();
  assert.equal(cached.version, 3);
  assert.equal(cached.queriedAt, null);
  assert.ok(cached.providers.every((p) => p.status === "pending"));
  assert.equal(h.requests.length, 0);
  const refreshed = await h.get(true);
  const glm = refreshed.providers.find((p) => p.id === "zai-coding-cn");
  assert.equal(glm.label, "智谱 GLM Coding Pro");
  assert.equal(glm.plan, "Pro");
  assert.equal(glm.status, "ok");
  assert.deepEqual(glm.windows, [{ label: "5 小时窗口", usedPercent: 10, detail: "已用 10 / 100 · 剩 90 积分", resetAfterSeconds: null, resetAt: 12345 }]);
  assert.deepEqual(h.requests, [{ url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit", headers: ["Authorization: Bearer FAKE-GLM-KEY"] }]);
  assert.deepEqual(h.refreshes, []);
  assert.equal(f.store.calls, 0);
});

test("admitted quota responses and the saved cache omit discovered JWT and snapshot emails", async (t) => {
  const f = await fixture(t);
  const jwtEmail = "fake-jwt-email@example.test";
  const metaEmail = "fake-meta-email@example.test";
  const claims = { "https://api.openai.com/auth": { chatgpt_account_id: "a" }, "https://api.openai.com/profile": { email: jwtEmail } };
  const current = grant("a", { access: `fake.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature` });
  await f.current(current);
  await f.snapshot("alpha", grant("a"));
  const beta = await f.snapshot("beta", grant("b"));
  await writeFile(join(beta, "meta.json"), JSON.stringify({ email: metaEmail }));
  const discovered = await discoverCodexAccounts(f.home);
  assert.deepEqual(discovered.map((entry) => entry.account.email), [jwtEmail, metaEmail]);

  const h = host(t, f, { quotaRequest: async () => quotaReply() });
  const pending = await h.get();
  const fresh = await h.get(true);
  const reloaded = await host(t, f).get();
  const cache = await readFile(join(f.home, "usage-lite", "quotas.json"), "utf8");
  assert.deepEqual(fresh.providers.filter((p) => p.account).map((p) => p.status), ["ok", "ok"]);
  for (const view of [pending, fresh, reloaded, JSON.parse(cache)]) {
    const accounts = view.providers.filter((p) => p.account).map((p) => p.account);
    assert.deepEqual(accounts, [
      { label: "alpha", active: true, switchable: true }, { label: "beta", active: false, switchable: true },
    ]);
  }
  assert.doesNotMatch(JSON.stringify([pending, fresh, reloaded, cache]), /fake-(?:jwt|meta)-email@example\.test/);
});

const protectedRoutes = [
  ["/usage-lite/quotas"], ["/usage-lite/quotas?refresh=1"], ["/usage-lite/quotas/renewal-status"],
  ["/usage-lite/quotas/refresh", { method: "POST" }],
  ["/usage-lite/quotas/renew", { method: "POST", body: { expectedActiveId: "openai-codex:current", expectedActiveAccountTag: accountTag("a") }, headers: { "x-usage-lite-action": "renew-codex" } }],
  ["/usage-lite/accounts/switch", { method: "POST", body: { id: "openai-codex:beta", expectedActiveId: "openai-codex:current", expectedActiveAccountTag: accountTag("a"), confirmed: true }, headers: { "x-usage-lite-action": "switch-account" } }],
];

test("all quota and switch routes fail closed for missing, rejected, or non-owner DSH admissions", async (t) => {
  const f = await fixture(t);
  await f.current(grant("a"));
  await f.snapshot("beta", grant("b"));
  for (const [connection, status] of [
    [{ admit: () => ({ rejection: 401 }) }, 401], [{ admit: () => ({ rejection: 403 }) }, 403],
    [{ admit: () => ({ peer: { principal: { kind: "guest" } } }) }, 403], [null, 503],
  ]) {
    const before = await f.live();
    const h = host(t, f, { connection, renewalEnabled: true });
    for (const [path, options] of protectedRoutes) {
      const result = await h.request(path, options);
      assert.equal(result.status, status, path);
      assert.equal(result.ok, false);
      assert.equal(Object.hasOwn(result, "providers"), false);
      assert.equal(Object.hasOwn(result, "renewing"), false);
    }
    assert.deepEqual(h.requests, []);
    assert.deepEqual(h.refreshes, []);
    assert.equal(h.admits.length, connection ? protectedRoutes.length : 0);
    assert.equal(f.store.calls, 0);
    assert.equal(await f.live(), before);
  }
});

test("admitted Desktop and same-origin TLS proxy can refresh quota without local scheme guessing", async (t) => {
  const f = await fixture(t);
  await f.current(grant("a"));
  const h = host(t, f, { quotaRequest: async () => quotaReply() });
  const path = "/usage-lite/quotas/refresh";
  for (const options of [
    { headers: { origin: undefined } },
    { headers: { origin: "https://proxy.example.test", host: "proxy.example.test", "sec-fetch-site": "same-origin" }, socket: { encrypted: false } },
  ]) {
    const result = await h.request(path, { method: "POST", ...options });
    assert.equal(result.status, 200);
    assert.equal(result.providers.find((p) => p.account?.active).status, "ok");
  }
  const blocked = await h.request(path, { method: "POST", headers: {
    origin: "https://other.example.test", host: "proxy.example.test", "x-forwarded-host": "other.example.test", "x-forwarded-proto": "https",
  } });
  assert.equal(blocked.status, 403);
  assert.equal(h.admits.length, 3);
  assert.equal(h.requests.length, 2);
  assert.equal(f.store.calls, 0);
});
