import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { discoverCodexAccounts } from "./index.mjs";
import { accountTag } from "./codex-renewal.mjs";
import { fixture, grant, host, quotaReply } from "./host-fixture.test-helpers.mjs";

const jwt = (claims) => `test.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
const payload = (id, access = jwt({ email: `${id}@example.test` }), expires = Date.now() + 3600000) => grant(id, { access, expires, refresh: "NEVER-REFRESH-THIS-FAKE-TOKEN" });
const success = async () => quotaReply({ primary_window: { used_percent: 27, limit_window_seconds: 18000 } });
const codex = (result) => result.providers.filter((p) => p.providerId === "openai-codex");

async function setMeta(f, label, meta) {
  await writeFile(join(f.home, "accounts", label, "meta.json"), JSON.stringify(meta), { mode: 0o600 });
}

test("discovery deduplicates IDs, skips hidden/_previous, and always substitutes live payload", async (t) => {
  const f = await fixture(t);
  const live = payload("a", jwt({ "https://api.openai.com/profile": { email: "live@example.test" } }));
  await f.current(live);
  await f.snapshot("alpha", payload("a", "STALE-SNAPSHOT", 1));
  await setMeta(f, "alpha", { email: "stale@example.test" });
  await f.snapshot("duplicate", payload("a"));
  await f.snapshot("beta", payload("b", "opaque-token"));
  await setMeta(f, "beta", { email: "metadata@example.test" });
  await f.snapshot(".hidden", payload("hidden"));
  await f.snapshot("_previous", payload("previous"));
  const accounts = await discoverCodexAccounts(f.home);
  assert.equal(accounts.length, 2);
  assert.deepEqual(accounts[0].account, { label: "alpha", email: "live@example.test", active: true, switchable: true });
  assert.deepEqual(accounts[0].payload, { ...live, expires: String(live.expires) });
  assert.equal(accounts[1].account.email, "metadata@example.test");
  assert.equal(accounts[1].account.active, false);
});

test("without snapshots there is one current card, including missing credentials", async (t) => {
  const f = await fixture(t);
  assert.equal((await discoverCodexAccounts(f.home)).length, 1);
  await f.current(payload("current"));
  const h = host(t, f, { quotaRequest: success });
  const result = await h.get(true);
  assert.equal(codex(result).length, 1);
  assert.equal(codex(result)[0].id, "openai-codex:current");
  assert.equal(codex(result)[0].account.active, true);
  assert.equal(result.activeAccountTag, accountTag("current"));
  assert.equal(result.providers.find((p) => p.id === "zai-coding-cn").status, "unconfigured");
});

test("queries accounts independently; expired snapshots never send requests or refresh", async (t) => {
  const f = await fixture(t);
  await f.current(payload("a", "LIVE-ACCESS"));
  await f.snapshot("alpha", payload("a", "STALE-ACCESS", 1));
  await f.snapshot("beta", payload("b", "EXPIRED-ACCESS", 1));
  await f.snapshot("gamma", payload("c", jwt({ exp: 1 })));
  await f.snapshot("delta", payload("d", "VALID-OTHER"));
  const before = await f.live();
  const h = host(t, f, { renewalEnabled: true, quotaRequest: async (_url, { headers }) =>
    headers.includes("chatgpt-account-id: d") ? { status: 401, text: "{}", timedOut: false } : success(),
  });
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
  assert.equal(h.requests.length, 2);
  assert.ok(h.requests.some(({ headers }) => headers.includes("Authorization: Bearer LIVE-ACCESS")));
  assert.doesNotMatch(JSON.stringify(h.requests), /STALE-ACCESS|EXPIRED-ACCESS|NEVER-REFRESH/);
  assert.deepEqual(h.refreshes, []);
  assert.equal(f.store.calls, 0);
  assert.equal(await f.live(), before);
  assert.doesNotMatch(JSON.stringify(result), /LIVE-ACCESS/);
  assert.doesNotMatch(await readFile(join(f.home, "usage-lite", "quotas.json"), "utf8"), /LIVE-ACCESS/);
});

test("JWT expiry fallback blocks expired access without refreshing", async (t) => {
  const f = await fixture(t);
  const p = payload("expired", jwt({ exp: 1 })); delete p.expires;
  await f.current(p);
  const h = host(t, f);
  assert.match(codex(await h.get(true))[0].error, /重新登录/);
  assert.deepEqual(h.requests, []);
  assert.deepEqual(h.refreshes, []);
});

test("cached GET and reloaded cache derive active flags afresh after switching", async (t) => {
  const f = await fixture(t);
  await f.current(payload("a"));
  await f.snapshot("alpha", payload("a"));
  await f.snapshot("beta", payload("b"));
  const h = host(t, f, { quotaRequest: success });
  await h.get(true);
  assert.equal(h.requests.length, 2);
  await f.current(payload("b"));
  const restarted = host(t, f);
  for (const instance of [h, restarted]) {
    const result = await instance.get();
    assert.equal(result.version, 3);
    assert.equal(result.activeAccountTag, accountTag("b"));
    assert.equal(codex(result).find((p) => p.account.label === "alpha").account.active, false);
    assert.equal(codex(result).find((p) => p.account.label === "beta").account.active, true);
    assert.ok(codex(result).every((p) => p.status === "ok"));
  }
  assert.equal(h.requests.length, 2);
  assert.equal(restarted.requests.length, 0);
});

test("quota transport failures, thrown exceptions, and server bodies cannot leak tokens", async (t) => {
  const f = await fixture(t);
  await f.current(payload("a", "FAKE-ACCESS-TOKEN"));
  await f.snapshot("alpha", payload("a"));
  await f.snapshot("beta", payload("b", "SECOND-FAKE"));
  await f.snapshot("gamma", payload("c", "THIRD-FAKE"));
  const h = host(t, f, { quotaRequest: async (_url, { headers }) => {
    if (headers.includes("chatgpt-account-id: a")) return { status: 0, text: "FAKE-ACCESS-TOKEN", timedOut: true };
    if (headers.includes("chatgpt-account-id: b")) throw new Error(`Command failed ${headers.join(" ")}`);
    return { status: 500, text: '{"detail":"THIRD-FAKE"}', timedOut: false };
  } });
  const result = await h.get(true);
  assert.ok(codex(result).every((p) => p.status === "error"));
  const exposed = JSON.stringify([result, h.logs, await readFile(join(f.home, "usage-lite", "quotas.json"), "utf8")]);
  assert.doesNotMatch(exposed, /FAKE-ACCESS-TOKEN|SECOND-FAKE|THIRD-FAKE|NEVER-REFRESH/);
  assert.equal(h.requests.length, 3);
});

test("a reused snapshot label with a different account never displays the old quota result", async (t) => {
  const f = await fixture(t);
  await f.current(payload("a"));
  await f.snapshot("alpha", payload("a"));
  const h = host(t, f, { quotaRequest: success });
  const old = await h.get(true);
  assert.equal(codex(old)[0].status, "ok");
  await f.current(payload("new-a"));
  await f.snapshot("alpha", payload("new-a"));
  const result = await h.get();
  assert.equal(codex(result)[0].id, codex(old)[0].id);
  assert.equal(codex(result)[0].status, "pending");
  assert.deepEqual(codex(result)[0].windows, []);
  assert.equal(result.activeAccountTag, accountTag("new-a"));
  assert.equal(h.requests.length, 1);
});
