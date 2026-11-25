import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, readdir, stat, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { discoverCodexAccounts } from "./index.mjs";
import { AccountSwitchError, codexRecord, switchCodexAccount } from "./account-switch.mjs";
import { accountTag, createRenewalJournal } from "./codex-renewal.mjs";
import { block, deferred, fixture as makeFixture, grant, host, jwt, livePrefix, liveSuffix, quotaReply } from "./host-fixture.test-helpers.mjs";

const valid = { id: "openai-codex:beta", expectedActiveId: "openai-codex:alpha", expectedActiveAccountTag: accountTag("a"), confirmed: true };
const okQuota = { status: "ok", plan: "plus", windows: [{ label: "5 小时窗口", usedPercent: 10 }], note: null, error: null };
async function fixture(t) {
  const f = await makeFixture(t);
  await f.current(grant("a"));
  await f.snapshot("alpha", grant("a", { access: "STALE-A-SNAPSHOT", refresh: "STALE-A-REFRESH" }));
  await f.snapshot("beta", grant("b"));
  return f;
}
const switchOptions = (f, updates = {}) => ({ ...valid, dshHome: f.home, discover: discoverCodexAccounts, credentials: f.store,
  queryQuota: async () => okQuota, refreshTokens: async () => assert.fail("unexpected refresh"),
  journal: createRenewalJournal(join(f.home, "attempts")), ...updates });
const post = (h, body = valid, headers = {}, socket = {}) => h.request("/usage-lite/accounts/switch", {
  method: "POST", body, headers: { "x-usage-lite-action": "switch-account", ...headers }, socket,
});

test("only saved real account directories advertise switch capability, including expired refreshable targets", async (t) => {
  const f = await fixture(t);
  await f.snapshot("expired", grant("c", { expires: 1, access: jwt("c", 1) }));
  await f.snapshot("_previous", grant("hidden"));
  await symlink(join(f.home, "accounts", "beta"), join(f.home, "accounts", "linked-dir"));
  await mkdir(join(f.home, "accounts", "linked-file"));
  await symlink(join(f.home, "accounts", "beta", "credential.yaml"), join(f.home, "accounts", "linked-file", "credential.yaml"));
  let accounts = await discoverCodexAccounts(f.home);
  assert.equal(accounts.length, 3);
  assert.ok(accounts.every((entry) => entry.account.switchable));
  await f.current(grant("unsaved"));
  accounts = await discoverCodexAccounts(f.home);
  assert.equal(accounts.find((entry) => entry.account.active).account.switchable, false);
  const empty = await makeFixture(t);
  assert.equal((await discoverCodexAccounts(empty.home))[0].account.switchable, false);
});

test("validated switch writes only through the credential service; copies the live grant privately with no full YAML backup", async (t) => {
  const f = await fixture(t);
  await f.current(grant("a", { refresh: "LATEST-A-REFRESH", extra: "retained-current-field" }), 0o640);
  await f.snapshot("alpha-copy", grant("a", { refresh: "STALE-COPY" }), 0o640);
  let validated = false;
  const result = await switchCodexAccount(switchOptions(f, { queryQuota: async (fields) => {
    assert.equal(f.store.locked, false, "quota I/O must not be under the credential lock");
    assert.equal((await f.store.read()).payload.accountId, "a", "must validate before installing");
    assert.equal(fields.accountId, "b"); validated = true; return okQuota;
  } }));
  assert.equal(result.id, valid.id);
  assert.ok(validated);
  assert.deepEqual(f.store.notices, ["commit"]);
  const after = await f.live();
  assert.equal((await f.store.read()).payload.accountId, "b");
  assert.ok(after.startsWith(livePrefix));
  assert.ok(after.endsWith(liveSuffix));
  for (const label of ["alpha", "alpha-copy", "_previous"]) {
    const snapshot = await f.saved(label);
    assert.equal(codexRecord(snapshot).fields.refresh, "LATEST-A-REFRESH");
    assert.match(snapshot, /      extra: "retained-current-field"/);
    assert.doesNotMatch(snapshot, /fake-unrelated|refs:/);
    for (const name of ["credential.yaml", "meta.json"]) assert.equal((await stat(join(f.home, "accounts", label, name))).mode & 0o777, 0o600);
  }
  assert.equal((await stat(join(f.home, "accounts", "_previous"))).mode & 0o777, 0o700);
  assert.equal(JSON.parse(await readFile(join(f.home, "accounts", "alpha", "meta.json"), "utf8")).custom, "retained");
  assert.deepEqual((await readdir(f.home)).sort(), [".credentials.yaml", "accounts"]);
});

test("expired switch target is verified and saved before validation, even if quota verification fails", async (t) => {
  const f = await fixture(t);
  await f.snapshot("beta", grant("b", { expires: 1, access: jwt("b", 1) }));
  const before = await f.live();
  const rotated = grant("b", { refresh: "ROTATED-REFRESH-B" });
  let refreshed = 0;
  await assert.rejects(switchCodexAccount(switchOptions(f, {
    refreshTokens: async (old) => { assert.equal(old, "FAKE-REFRESH-b"); assert.equal(f.store.locked, true); refreshed++; return rotated; },
    queryQuota: async () => {
      assert.equal(f.store.locked, false);
      assert.equal(codexRecord(await f.saved("beta")).fields.refresh, rotated.refresh);
      return { status: "error", error: "RAW-FAKE-UPSTREAM" };
    },
  })), (error) => error.status === 502 && !error.message.includes("RAW-FAKE"));
  assert.equal(refreshed, 1);
  assert.equal(await f.live(), before);
  assert.equal(f.store.writes, 0);
  assert.deepEqual(f.store.notices, ["noop"]);
  assert.equal(codexRecord(await f.saved("beta")).fields.refresh, rotated.refresh);
  await switchCodexAccount(switchOptions(f));
  assert.equal((await f.store.read()).payload.refresh, rotated.refresh);
});

test("an unexpired revoked target refreshes once, but a non-401 failure never installs or refreshes", async (t) => {
  const f = await fixture(t);
  let queries = 0, refreshes = 0;
  await switchCodexAccount(switchOptions(f, {
    queryQuota: async () => { assert.equal(f.store.locked, false); return ++queries === 1 ? { status: "error", unauthorized: true } : okQuota; },
    refreshTokens: async () => { refreshes++; return grant("b", { refresh: "ROTATED-ON-401" }); },
  }));
  assert.equal(queries, 2); assert.equal(refreshes, 1);
  await f.current(grant("a"));
  const before = await f.live();
  await assert.rejects(switchCodexAccount(switchOptions(f, { queryQuota: async () => ({ status: "error", error: "403" }) })), /额度验证失败/);
  assert.equal(await f.live(), before);
});

test("invalid, stale, or unsupported switch actions make no quota request or credential write", async (t) => {
  const f = await fixture(t);
  const before = await f.live();
  for (const updates of [
    { id: "openai-codex:alpha" }, { id: "openai-codex:../../outside" }, { id: "zai-coding-cn" },
    { id: "openai-codex:_previous" }, { id: "openai-codex:b" }, { expectedActiveId: "openai-codex:old" },
    { expectedActiveAccountTag: accountTag("other") }, { credentials: null },
  ]) {
    let queried = false;
    await assert.rejects(switchCodexAccount(switchOptions(f, { ...updates, queryQuota: async () => { queried = true; return okQuota; } })), AccountSwitchError);
    assert.equal(queried, false);
    assert.equal(f.store.calls, 0);
    assert.equal(await f.live(), before);
  }
});

test("switch aborts when the actual live identity changes, but saves same-account model rotations under the lock", async (t) => {
  const f = await fixture(t);
  f.store.beforeModify = () => f.current(grant("external"));
  await assert.rejects(switchCodexAccount(switchOptions(f)), (error) => error.status === 409);
  assert.equal((await f.store.read()).payload.accountId, "external");
  assert.equal(f.store.writes, 0);
  await f.current(grant("a"));
  f.store.beforeModify = () => f.current(grant("a", { refresh: "ROTATED-BEFORE-LOCK-ENTRY" }));
  await switchCodexAccount(switchOptions(f));
  assert.equal(codexRecord(await f.saved("alpha")).fields.refresh, "ROTATED-BEFORE-LOCK-ENTRY");
  assert.equal(f.store.writes, 1);
});

test("a target changed during validation conflicts instead of installing a superseded snapshot", async (t) => {
  const f = await fixture(t);
  const before = await f.live();
  await assert.rejects(switchCodexAccount(switchOptions(f, {
    queryQuota: async () => { await f.snapshot("beta", grant("b", { refresh: "EXTERNAL-ROTATION" })); return okQuota; },
  })), (error) => error.status === 409);
  assert.equal(await f.live(), before);
  assert.equal(f.store.writes, 0);
  assert.equal(codexRecord(await f.saved("beta")).fields.refresh, "EXTERNAL-ROTATION");
});

test("a mismatched refresh grant is not saved, installed, or retried", async (t) => {
  const f = await fixture(t);
  await f.snapshot("beta", grant("b", { expires: 1 }));
  const before = await f.live(), snapshot = await f.saved("beta");
  let refreshes = 0, queries = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(switchCodexAccount(switchOptions(f, {
      refreshTokens: async () => { refreshes++; return grant("different", { refresh: "FAKE-DIFFERENT-REFRESH" }); },
      queryQuota: async () => { queries++; return okQuota; },
    })), (error) => error.status === 502 && /未确认/.test(error.message));
  }
  assert.equal(refreshes, 1);
  assert.equal(queries, 0);
  assert.equal(f.store.writes, 0);
  assert.equal(await f.live(), before);
  assert.equal(await f.saved("beta"), snapshot);
});

test("single-flight protects a home even across independent callers", async (t) => {
  const f = await fixture(t);
  const ready = deferred(), held = deferred();
  const first = switchCodexAccount(switchOptions(f, { queryQuota: async () => { ready.resolve(); await held.promise; return okQuota; } }));
  await ready.promise;
  try {
    await assert.rejects(switchCodexAccount(switchOptions(f)), (error) => error.status === 409 && /正在进行/.test(error.message));
  } finally { held.resolve(); await first; }
});

test("identity mismatch, malformed records, and unusable expired tokens fail closed", async (t) => {
  const f = await fixture(t);
  const before = await f.live();
  await f.snapshot("beta", grant("b", { access: jwt("different") }));
  await assert.rejects(switchCodexAccount(switchOptions(f)), /不一致/);
  await f.snapshot("beta", grant("b", { expires: 1, refresh: "" }));
  await assert.rejects(switchCodexAccount(switchOptions(f)), /无法续期/);
  assert.throws(() => codexRecord(`records:\n${block(grant("b"))}${block(grant("b"))}`), /重复/);
  assert.throws(() => codexRecord(`refs:\n${block(grant("b"))}`), /位置/);
  assert.throws(() => codexRecord(`records:\n${block(grant("b"), "secret")}`), /OAuth grant/);
  assert.equal(await f.live(), before);
});

test("snapshot symlinks are never written through and a failed snapshot prevents live install", async (t) => {
  const f = await fixture(t);
  const before = await f.live();
  const outside = join(f.home, "outside-credential.yaml");
  await writeFile(outside, "must-not-change");
  await mkdir(join(f.home, "accounts", "_previous"));
  await symlink(outside, join(f.home, "accounts", "_previous", "credential.yaml"));
  await assert.rejects(switchCodexAccount(switchOptions(f)), /普通文件/);
  assert.equal(await f.live(), before);
  assert.equal(await readFile(outside, "utf8"), "must-not-change");
});

test("HTTP switch returns a fresh snapshot and installs after successful quota validation", async (t) => {
  const f = await fixture(t);
  const h = host(t, f, { quotaRequest: async (_url, { headers }) => {
    assert.equal(f.store.locked, false);
    assert.ok(headers.includes("chatgpt-account-id: b"));
    return quotaReply();
  } });
  const result = await post(h);
  assert.equal(result.status, 200); assert.equal(result.ok, true); assert.match(result.message, /无需重启/);
  assert.equal(h.requests.length, 1);
  assert.equal(result.providers.find((provider) => provider.account?.active).id, valid.id);
  assert.equal(result.providers.find((provider) => provider.id === valid.id).status, "ok");
  assert.equal(result.activeAccountTag, accountTag("b"));
  assert.doesNotMatch(JSON.stringify(result), /FAKE-REFRESH/);
  const cached = await h.get();
  assert.equal(cached.providers.find((provider) => provider.account?.active).id, valid.id);
  assert.equal(h.requests.length, 1);
  const stale = await post(h);
  assert.equal(stale.status, 409); assert.equal(stale.ok, false);
  assert.equal((await h.get()).providers.find((provider) => provider.account?.active).id, valid.id);
});

test("HTTP switch requires action header, same-origin owner, and exact JSON body with a tag", async (t) => {
  const f = await fixture(t);
  const before = await f.live();
  const h = host(t, f);
  for (const [body, headers, status] of [
    [valid, { "x-usage-lite-action": undefined }, 403], [valid, { "x-usage-lite-action": "other" }, 403],
    [valid, { "content-type": "text/plain" }, 415], [valid, { origin: "https://evil.example" }, 403],
    [valid, { origin: "null" }, 403], [valid, { origin: "http://localhost:1234/path" }, 403],
    [valid, { origin: "http://localhost:9999" }, 403], [valid, { "sec-fetch-site": "cross-site" }, 403],
    ["{bad", {}, 400], ["[]", {}, 400], [{ ...valid, confirmed: false }, {}, 400],
    [{ ...valid, extra: "not-allowed" }, {}, 400], [{ ...valid, expectedActiveAccountTag: undefined }, {}, 400],
    [{ ...valid, expectedActiveAccountTag: "not-a-tag" }, {}, 400], [{ ...valid, id: { nested: true } }, {}, 400],
    [" ".repeat(4097), {}, 413],
  ]) {
    const result = await post(h, body, headers);
    assert.equal(result.status, status, JSON.stringify({ body: typeof body === "string" && body.length > 4096 ? "overlong" : body, headers }));
    assert.equal(result.ok, false);
    assert.equal(await f.live(), before);
  }
  assert.equal(h.requests.length, 0);
  assert.equal(f.store.calls, 0);
});

test("successful switch is not reported as a failure when the quota cache cannot be persisted", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, "usage-lite"), "not-a-directory");
  const h = host(t, f, { quotaRequest: async () => quotaReply() });
  const result = await post(h, valid, { origin: undefined });
  assert.equal(result.status, 200); assert.equal(result.ok, true);
  assert.equal((await f.store.read()).payload.accountId, "b");
  assert.equal(result.providers.find((provider) => provider.account?.active).id, valid.id);
  assert.ok(h.logs.some((line) => line.includes("quota snapshot persist failed")));
});

test("a trusted HTTPS proxy can switch from an empty live record with a null expected tag", async (t) => {
  const f = await fixture(t);
  await unlink(f.livePath);
  const h = host(t, f, { quotaRequest: async () => quotaReply() });
  const result = await post(h, { ...valid, expectedActiveId: null, expectedActiveAccountTag: null }, {
    origin: "https://example.test", host: "example.test",
  }, { encrypted: false });
  assert.equal(result.status, 200);
  assert.equal(f.store.writes, 1);
  assert.equal((await f.store.read()).payload.accountId, "b");
});

test("HTTP conflict is immediate while a request is in flight, with no second upstream call", async (t) => {
  const f = await fixture(t);
  const ready = deferred(), held = deferred();
  const h = host(t, f, { quotaRequest: async () => { ready.resolve(); await held.promise; return quotaReply(); } });
  const first = post(h);
  const started = await Promise.race([ready.promise.then(() => true), first.then(() => false)]);
  assert.equal(started, true, "first switch reached the fake quota server");
  try {
    const second = await post(h);
    assert.equal(second.status, 409); assert.equal(second.ok, false); assert.equal(h.requests.length, 1);
  } finally { held.resolve(); assert.equal((await first).ok, true); }
});

test("HTTP switch failures never return or log raw upstream output or install a target", async (t) => {
  const f = await fixture(t);
  await f.snapshot("beta", grant("b", { access: jwt("b", 1), expires: 1 }));
  const before = await f.live();
  const h = host(t, f, { refreshTokens: async (token) => { throw new Error(`FAKE-RAW-UPSTREAM ${token}`); } });
  const result = await post(h);
  assert.equal(result.status, 502); assert.equal(result.ok, false); assert.equal(await f.live(), before);
  assert.equal(h.refreshes.length, 1);
  assert.equal(h.requests.length, 0);
  assert.doesNotMatch(JSON.stringify([result, h.logs]), /FAKE-RAW-UPSTREAM|FAKE-REFRESH/);
});
