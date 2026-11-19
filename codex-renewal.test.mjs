import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { accountTag } from "./codex-renewal.mjs";
import { createQuotaTransport, createTokenRefresher, TokenRefreshError } from "./quota-transport.mjs";
import { deferred, fixture, grant, host, jwt, livePrefix, liveSuffix, quotaReply } from "./host-fixture.test-helpers.mjs";

const QUOTA_URL = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const expected = { expectedActiveId: "openai-codex:alpha", expectedActiveAccountTag: accountTag("a") };
const renew = (h, body = expected, headers = {}) => h.request("/usage-lite/quotas/renew", {
  method: "POST", body, headers: { "x-usage-lite-action": "renew-codex", ...headers },
});
const renewalStatus = (h) => h.request("/usage-lite/quotas/renewal-status");
const active = (result) => result.providers.find((card) => card.account?.active);
const rotatingGrant = (marker = "ROTATED", id = "a") => grant(id, { access: jwt(id, undefined, marker), refresh: `FAKE-${marker}-REFRESH` });
const networkResponse = (status, timedOut = false) => ({ status, timedOut, text: '{"error":"FAKE-RAW-UPSTREAM-BODY"}' });
const journalDir = (f) => join(f.home, "usage-lite", "codex-renewal-attempts");
const quotaFile = (f) => join(f.home, "usage-lite", "quotas.json");
const accessHeaders = (h) => h.requests.map(({ headers }) => headers.find((line) => line.startsWith("Authorization: ")));

async function accounts(t, live = grant("a")) {
  const f = await fixture(t);
  await f.current(live);
  await f.snapshot("alpha", grant("a", { refresh: "STALE-FAKE-SNAPSHOT-REFRESH" }));
  return f;
}

test("manual local expiry rotates only the active grant before quota; inactive expiry and 401 stay read-only", async (t) => {
  const expired = grant("a", { expires: 1, access: jwt("a", undefined, "FAKE-OLD-ACCESS"), extra: { retained: true } });
  const f = await accounts(t, expired);
  await f.snapshot("beta", grant("b", { expires: 1, access: jwt("b", 1) }));
  const archived = grant("c");
  await f.snapshot("gamma", archived);
  const snapshots = await Promise.all(["alpha", "beta", "gamma"].map(f.saved));
  const rotated = rotatingGrant();
  const h = host(t, f, {
    renewalEnabled: true,
    refreshTokens: async (token) => { assert.equal(token, expired.refresh); assert.equal(f.store.locked, true); return rotated; },
    quotaRequest: async (url, { headers }) => {
      assert.equal(url, QUOTA_URL);
      if (headers.includes("chatgpt-account-id: c")) return networkResponse(401);
      assert.equal(f.store.locked, false, "active quota follow-up must run after the rotation transaction");
      assert.equal((await f.store.read()).payload.refresh, rotated.refresh);
      assert.deepEqual(headers, ["User-Agent: codex_cli_rs/0.163.0", `Authorization: Bearer ${rotated.access}`, "chatgpt-account-id: a", "originator: pi"]);
      return quotaReply();
    },
  });
  const result = await renew(h);
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.canRenew, true);
  assert.equal(result.activeAccountTag, expected.expectedActiveAccountTag);
  assert.equal(active(result).status, "ok");
  assert.equal(active(result).windows[0].usedPercent, 10);
  assert.ok(result.providers.filter((p) => ["openai-codex:beta", "openai-codex:gamma"].includes(p.id)).every((p) => p.status === "error"));
  const accessed = accessHeaders(h);
  assert.deepEqual(accessed.sort(), [`Authorization: Bearer ${archived.access}`, `Authorization: Bearer ${rotated.access}`].sort());
  assert.deepEqual(h.refreshes, [[expired.refresh]]);
  assert.deepEqual(f.store.notices, ["commit"]);
  assert.deepEqual((await f.store.read()).payload, { ...rotated, extra: expired.extra });
  const live = await f.live();
  assert.ok(live.startsWith(livePrefix) && live.endsWith(liveSuffix));
  assert.deepEqual(await Promise.all(["alpha", "beta", "gamma"].map(f.saved)), snapshots);
  assert.deepEqual(await readdir(journalDir(f)), [], "successful commit removes its journal entry");
  const exposed = JSON.stringify([result, h.logs, await readFile(quotaFile(f), "utf8")]);
  assert.doesNotMatch(exposed, /FAKE-OLD-ACCESS|FAKE-ROTATED-REFRESH|FAKE-REFRESH-|FAKE-RAW-UPSTREAM-BODY/);
});

test("an active 401 triggers one locked rotation and one quota retry with the new access", async (t) => {
  const original = grant("a");
  const f = await accounts(t, original);
  const rotated = rotatingGrant();
  const order = [];
  const h = host(t, f, { renewalEnabled: true,
    quotaRequest: async (_url, { headers }) => {
      assert.equal(f.store.locked, false);
      if (headers.includes(`Authorization: Bearer ${original.access}`)) { order.push("old quota"); return networkResponse(401); }
      order.push("new quota");
      assert.equal((await f.store.read()).payload.access, rotated.access);
      return quotaReply();
    },
    refreshTokens: async () => { assert.equal(f.store.locked, true); order.push("refresh"); return rotated; },
  });
  const result = await renew(h);
  assert.equal(result.status, 200);
  assert.equal(active(result).status, "ok");
  assert.deepEqual(order, ["old quota", "refresh", "new quota"]);
  assert.deepEqual(accessHeaders(h), [original, rotated].map(({ access }) => `Authorization: Bearer ${access}`));
  assert.deepEqual(h.refreshes, [[original.refresh]]);
  assert.equal(f.store.writes, 1);
});

test("paywall/exhaustion, 403, 429, timeout and 5xx never turn into OAuth refreshes", async (t) => {
  const variants = [
    ["403", networkResponse(403), "error"], ["429", networkResponse(429), "error"],
    ["timeout", networkResponse(0, true), "error"], ["503", networkResponse(503), "error"],
    ["exhausted", quotaReply({ limit_reached: true, primary_window: { used_percent: 100, limit_window_seconds: 18000 } }), "ok"],
  ];
  for (const [label, reply, cardStatus] of variants) await t.test(label, async (t) => {
    const f = await accounts(t);
    const before = await f.live();
    const h = host(t, f, { renewalEnabled: true, quotaRequest: async () => reply });
    const result = await renew(h);
    assert.equal(result.status, 200);
    assert.equal(active(result).status, cardStatus);
    if (label === "exhausted") {
      assert.equal(active(result).windows[0].usedPercent, 100);
      assert.match(active(result).note, /窗口上限/);
    }
    if (label === "timeout") assert.match(active(result).error, /超时/);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.refreshes, []);
    assert.equal(f.store.calls, 0);
    assert.equal(await f.live(), before);
    assert.doesNotMatch(JSON.stringify([result, h.logs]), /FAKE-RAW-UPSTREAM-BODY/);
  });
});

test("legacy GET and POST quota refresh never write or renew an expired or revoked active record", async (t) => {
  for (const cause of ["expired", "revoked"]) await t.test(cause, async (t) => {
    const f = await accounts(t, grant("a", cause === "expired" ? { access: jwt("a", 1) } : {}));
    const before = await f.live();
    const h = host(t, f, { renewalEnabled: true, quotaRequest: async () => networkResponse(401) });
    assert.equal((await h.get()).queriedAt, null);
    assert.equal(h.requests.length, 0);
    for (const result of [await h.get(true), await h.request("/usage-lite/quotas/refresh", { method: "POST" })]) {
      assert.equal(result.status, 200);
      assert.equal(result.canRenew, true);
      assert.equal(active(result).status, "error");
      assert.match(active(result).error, /重新登录/);
    }
    assert.equal(h.requests.length, cause === "expired" ? 0 : 2);
    assert.equal(h.refreshes.length, 0);
    assert.equal(f.store.calls, 0);
    assert.equal(await f.live(), before);
  });
});

test("manual same-account flight shares work; status is observable and conflicting mutations fail fast", async (t) => {
  const original = grant("a", { expires: 1 });
  const f = await accounts(t, original);
  const rotating = deferred(), finish = deferred();
  const h = host(t, f, { renewalEnabled: true, quotaRequest: async () => quotaReply(),
    refreshTokens: async () => { rotating.resolve(); await finish.promise; return rotatingGrant(); },
  });
  assert.deepEqual(await renewalStatus(h), { ok: true, renewing: false, status: 200 });
  const first = renew(h);
  assert.equal(await Promise.race([rotating.promise.then(() => true), first.then(() => false)]), true);
  let joined;
  try {
    assert.equal((await renewalStatus(h)).renewing, true);
    assert.equal(h.requests.length, 0);
    joined = renew(h);
    const conflict = await renew(h, { ...expected, expectedActiveAccountTag: accountTag("other") });
    assert.equal(conflict.status, 409);
    const switchBlocked = await h.request("/usage-lite/accounts/switch", {
      method: "POST", body: { ...expected, id: "openai-codex:beta", confirmed: true }, headers: { "x-usage-lite-action": "switch-account" },
    });
    assert.equal(switchBlocked.status, 409);
    assert.deepEqual(h.refreshes, [[original.refresh]]);
  } finally { finish.resolve(); }
  const results = await Promise.all([first, joined]);
  assert.ok(results.every((result) => result.status === 200 && active(result).status === "ok"));
  assert.equal(results[0].queriedAt, results[1].queriedAt);
  assert.equal(h.requests.length, 1);
  assert.deepEqual(f.store.notices, ["commit"]);
  assert.equal((await renewalStatus(h)).renewing, false);
});

test("a model's newer same-account grant at lock acquisition is reused, never refreshed or overwritten", async (t) => {
  const f = await accounts(t, grant("a", { expires: 1 }));
  const modelRotated = rotatingGrant("MODEL-ROTATED");
  f.store.beforeModify = async () => {
    assert.equal(f.store.locked, true);
    await f.current(modelRotated);
  };
  const h = host(t, f, { renewalEnabled: true, quotaRequest: async () => quotaReply() });
  const result = await renew(h);
  assert.equal(result.status, 200);
  assert.equal(active(result).status, "ok");
  assert.deepEqual(h.refreshes, []);
  assert.deepEqual(accessHeaders(h), [`Authorization: Bearer ${modelRotated.access}`]);
  assert.deepEqual(f.store.notices, ["noop"]);
  assert.deepEqual((await f.store.read()).payload, modelRotated);
});

test("manual stale identity fails closed both for a reused label and for a change under the lock", async (t) => {
  const f = await accounts(t, grant("a", { expires: 1 }));
  const replacement = grant("replacement");
  const h = host(t, f, { renewalEnabled: true });
  assert.equal((await h.get()).activeAccountTag, expected.expectedActiveAccountTag);
  await f.current(replacement);
  await f.snapshot("alpha", replacement);
  const view = await h.get();
  assert.equal(active(view).id, expected.expectedActiveId);
  assert.equal(view.activeAccountTag, accountTag("replacement"));
  assert.equal((await renew(h)).status, 409);
  assert.equal(f.store.calls, 0);

  await f.current(grant("a", { expires: 1 }));
  await f.snapshot("alpha", grant("a"));
  f.store.beforeModify = () => f.current(replacement);
  assert.equal((await renew(h)).status, 409);
  assert.equal(f.store.calls, 1);
  assert.equal(f.store.writes, 0);
  assert.equal(h.requests.length, 0);
  assert.equal(h.refreshes.length, 0);
  assert.deepEqual((await f.store.read()).payload, replacement);
});

test("unknown or rejected rotation fingerprints survive a fresh Host and prevent retrying old refresh tokens", async (t) => {
  const variants = [
    ["unknown downstream error", "pending", async () => { throw new Error("FAKE-SECRET-DOWNSTREAM"); }],
    ["mismatched JWT", "pending", async () => rotatingGrant("MISMATCH", "other-account")],
    ["verified response but store write failed", "pending", async () => rotatingGrant("NOT-COMMITTED")],
    ["rejected refresh", "rejected", async () => { throw new TokenRefreshError("rejected"); }],
  ];
  for (const [label, state, refreshTokens] of variants) await t.test(label, async (t) => {
    const old = grant("a", { expires: 1 });
    const f = await accounts(t, old);
    if (label === "verified response but store write failed") f.store.beforeSave = () => { throw new Error("FAKE-STORE-ERROR"); };
    const before = await f.live();
    const h = host(t, f, { renewalEnabled: true, refreshTokens });
    const first = await renew(h);
    assert.equal(first.status, 200);
    assert.equal(active(first).status, "error");
    assert.equal((await renewalStatus(h)).renewing, false);
    assert.match(active(first).error, state === "pending" ? /未确认.*未重发/ : /重新登录/);
    assert.deepEqual(h.refreshes, [[old.refresh]]);
    assert.equal(h.requests.length, 0);
    const filenames = await readdir(journalDir(f));
    assert.equal(filenames.length, 1);
    assert.match(filenames[0], /^[0-9a-f]{64}$/);
    const marker = join(journalDir(f), filenames[0]);
    assert.equal((await stat(marker)).mode & 0o777, 0o600);
    assert.equal(await readFile(marker, "utf8"), state);
    const reopened = host(t, f, { renewalEnabled: true });
    const second = await renew(reopened);
    assert.equal(second.status, 200);
    assert.equal(active(second).error, active(first).error);
    assert.deepEqual(reopened.requests, []);
    assert.deepEqual(reopened.refreshes, []);
    assert.equal(f.store.writes, 0);
    assert.equal(await f.live(), before);
    assert.doesNotMatch(JSON.stringify([first, second, h.logs, reopened.logs, await readFile(quotaFile(f), "utf8")]), /FAKE-(?:SECRET|STORE|REFRESH|MISMATCH|NOT-COMMITTED)/);
  });
});

test("a failed quota retry shows a previous result as stale but the rotated grant stays installed", async (t) => {
  const original = grant("a");
  const f = await accounts(t, original);
  const rotated = rotatingGrant();
  const replies = [quotaReply(), networkResponse(401), networkResponse(401)];
  const h = host(t, f, { renewalEnabled: true, quotaRequest: async () => replies.shift(), refreshTokens: async () => rotated });
  const initial = active(await h.get(true));
  assert.equal(initial.status, "ok");
  const result = await renew(h);
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  const card = active(result);
  assert.equal(card.status, "stale");
  assert.match(card.error, /登录已续期.*额度暂未更新/);
  assert.deepEqual(card.windows, initial.windows);
  assert.equal(card.lastSuccessAt, initial.lastSuccessAt);
  assert.deepEqual(h.refreshes, [[original.refresh]], "a second 401 must not trigger a second rotation");
  assert.equal(h.requests.length, 3);
  assert.deepEqual((await f.store.read()).payload, rotated);
  assert.equal((await renewalStatus(h)).renewing, false);
});

test("a quota cache persistence failure never rolls back the rotated grant", async (t) => {
  const f = await accounts(t, grant("a", { expires: 1 }));
  // Block only the quota file's atomic rename; allow credential and journal writes.
  await mkdir(quotaFile(f), { recursive: true });
  const rotated = rotatingGrant();
  const h = host(t, f, { renewalEnabled: true, quotaRequest: async () => quotaReply(), refreshTokens: async () => rotated });
  const result = await renew(h);
  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.equal(active(result).status, "ok");
  assert.deepEqual((await f.store.read()).payload, rotated);
  assert.equal(f.store.writes, 1);
  assert.equal(h.refreshes.length, 1);
  assert.equal(h.requests.length, 1);
  assert.ok(h.logs.some((line) => line.includes("quota snapshot persist failed")));
  assert.deepEqual(await readdir(journalDir(f)), []);
});

test("manual renewal requires opt-in, a writable store, action header, and exact JSON keys", async (t) => {
  const f = await accounts(t, grant("a", { expires: 1 }));
  const before = await f.live();
  for (const options of [{ renewalEnabled: false }, { renewalEnabled: true, credentials: null }]) {
    const h = host(t, f, options);
    assert.equal((await h.get()).canRenew, false);
    assert.equal((await renew(h)).status, 503);
    assert.equal(h.requests.length + h.refreshes.length, 0);
  }
  const h = host(t, f, { renewalEnabled: true });
  for (const [body, headers, status] of [
    [expected, { "x-usage-lite-action": "switch-account" }, 403], [expected, { "x-usage-lite-action": undefined }, 403],
    [expected, { "content-type": "text/plain" }, 415], [expected, { origin: "http://wrong.example.test" }, 403],
    [expected, { "sec-fetch-site": "cross-site" }, 403], ["{bad", {}, 400], ["null", {}, 400], ["[]", {}, 400],
    [{ ...expected, refresh: "FAKE-EXTRA" }, {}, 400], [{ ...expected, expectedActiveId: null }, {}, 400],
    [{ ...expected, expectedActiveId: "zai-coding-cn" }, {}, 400], [{ ...expected, expectedActiveAccountTag: null }, {}, 400],
    [{ expectedActiveId: expected.expectedActiveId }, {}, 400], [{ ...expected, expectedActiveAccountTag: 1 }, {}, 400],
    [" ".repeat(4097), {}, 413],
  ]) {
    const response = await renew(h, body, headers);
    assert.equal(response.status, status);
    assert.equal(response.ok, false);
    assert.equal(Object.hasOwn(response, "providers"), false);
  }
  assert.equal(h.requests.length + h.refreshes.length, 0);
  assert.equal(f.store.calls, 0);
  assert.equal(await f.live(), before);
});

// A fake child consumes the exact bytes sent to stdin; no curl is ever spawned.
function childRecorder(error, stdout) {
  const calls = [];
  const exec = (file, args, options, callback) => {
    const call = { file, args, options, input: "" };
    calls.push(call);
    return { stdin: new Writable({
      write(chunk, _encoding, next) { call.input += chunk.toString(); next(); },
      final(next) { callback(error, stdout, "FAKE-STDERR"); next(); },
    }) };
  };
  return { calls, exec };
}

test("curl quota headers and token form use stdin only, with exact safe flags, deadlines and proxy", async () => {
  const curlArgs = (seconds) => ["-q", "--proto", "=https", "-s", "-m", String(seconds), "-w", "\n%{http_code}"];
  const options = (timeout) => ({ timeout, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 1 << 20 });
  const proxy = "http://fixture-proxy.example.test:7897";
  const quotaChild = childRecorder(null, "{\n \"test\": true\n}\n200");
  const headers = ["Authorization: Bearer FAKE-STDIN-CODEX", "chatgpt-account-id: FAKE-ACCOUNT"];
  const quota = await createQuotaTransport(quotaChild.exec)(QUOTA_URL, { headers, proxy });
  assert.equal(quota.status, 200);
  assert.equal(quota.text, "{\n \"test\": true\n}");
  assert.equal(Boolean(quota.timedOut), false);
  assert.deepEqual(quotaChild.calls, [{ file: "/usr/bin/curl", args: [...curlArgs(12), "-x", proxy, "-H", "@-", QUOTA_URL], options: options(15000), input: `${headers.join("\n")}\n` }]);

  const oauthChild = childRecorder(null, '{"access_token":"FAKE-OAUTH-ACCESS","refresh_token":"FAKE-ROTATED","expires_in":3600}\n200');
  const oauthTransport = createQuotaTransport(oauthChild.exec);
  const token = "FAKE+REFRESH/&= trial";
  // Override only the proxy option passed to the transport; do not access or mutate the host environment.
  const refresh = createTokenRefresher((url, input) => oauthTransport(url, { ...input, proxy }));
  const rotated = await refresh(token);
  assert.equal(rotated.access, "FAKE-OAUTH-ACCESS");
  assert.equal(rotated.refresh, "FAKE-ROTATED");
  assert.ok(rotated.expires > Date.now());
  assert.deepEqual(oauthChild.calls, [{ file: "/usr/bin/curl",
    args: [...curlArgs(15), "-x", proxy, "-H", "Content-Type: application/x-www-form-urlencoded", "--data-binary", "@-", TOKEN_URL],
    options: options(18000), input: "grant_type=refresh_token&refresh_token=FAKE%2BREFRESH%2F%26%3D+trial&client_id=app_EMoamEEZ73f0CkXaXp7hrann",
  }]);
});

test("curl rejects invalid stdin header inputs and sanitizes process failures", async () => {
  let started = 0;
  const shouldNotSpawn = createQuotaTransport(() => { started++; throw new Error("FAKE-UNSAFE-INPUT"); });
  for (const options of [
    { headers: ["Authorization: Bearer FAKE\r\nBad: value"] }, { headers: ["Bad: FAKE\0VALUE"] },
    { headers: ["Content-Type: fake"], data: "FAKE-MIXED-DATA" },
  ]) assert.deepEqual(await shouldNotSpawn(QUOTA_URL, options), { status: 0, text: "", timedOut: false });
  assert.equal(started, 0);
  for (const [error, timedOut] of [[{ code: 28 }, true], [{ killed: true }, true], [new Error("FAKE-RAW-PROCESS-ERROR"), false]]) {
    const { exec } = childRecorder(error, "FAKE-RAW-STDOUT\n200");
    assert.deepEqual(await createQuotaTransport(exec)(QUOTA_URL), { status: 0, text: "", timedOut });
  }
  const thrown = createQuotaTransport(() => { throw new Error("FAKE-RAW-EXEC-ERROR"); });
  assert.deepEqual(await thrown(QUOTA_URL), { status: 0, text: "", timedOut: false });
});

test("OAuth classifies explicit grant rejection separately from ambiguous endpoint responses", async () => {
  for (const [status, text, kind] of [
    [400, '{"error":"invalid_grant","detail":"FAKE-DOWNSTREAM"}', "rejected"],
    [401, '{"error":{"code":"refresh_token_reused"}}', "rejected"],
    [403, '<html>FAKE-DOWNSTREAM</html>', "unknown"],
    [0, "", "unknown"], [429, '{"error":"invalid_grant"}', "unknown"], [500, '{"error":"invalid_token"}', "unknown"],
    [200, '{"access_token":"FAKE-INCOMPLETE"}', "unknown"],
  ]) {
    const refresh = createTokenRefresher(async () => ({ status, text, timedOut: status === 0 }));
    await assert.rejects(refresh("FAKE-ORIGINAL"), (error) => error instanceof TokenRefreshError && error.kind === kind && !error.message.includes("FAKE"));
  }
});
