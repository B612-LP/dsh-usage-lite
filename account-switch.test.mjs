import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { apply, discoverCodexAccounts } from "./index.mjs";
import { AccountSwitchError, codexRecord, createTokenRefresher, switchCodexAccount } from "./account-switch.mjs";

const jwt = (id, exp = Math.floor(Date.now() / 1000) + 7200) => `fake.${Buffer.from(JSON.stringify({ exp, "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.signature`;
const payload = (id, updates = {}) => ({ type: "oauth", accountId: id, access: jwt(id), refresh: `SECRET-REFRESH-${id}`, expires: Date.now() + 7200000, ...updates });
const block = (fields) => `  llm-pi-ai/openai-codex:\n    kind: grant\n    payload:\n${Object.entries(fields).map(([key, value]) => `      ${key}: ${JSON.stringify(value)}`).join("\n")}\n`;
const yaml = (fields) => `# unchanged prefix\nrefs:\n  OTHER_KEY: secret-other-key\nrecords:\n  unrelated/provider:\n    kind: secret\n    payload:\n      access: secret-other-access\n${block(fields)}  after/provider:\n    payload:\n      nested: unchanged\n# unchanged suffix\n`;
const okQuota = { status: "ok", plan: "plus", windows: [{ label: "5 小时窗口", usedPercent: 10 }], note: null, error: null };
const quotaJSON = JSON.stringify({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } });

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "usage-lite-switch-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const current = async (fields, mode = 0o600) => {
    const path = join(home, ".credentials.yaml");
    await writeFile(path, yaml(fields)); await chmod(path, mode);
  };
  const snapshot = async (label, fields, mode = 0o600) => {
    const dir = join(home, "accounts", label);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, "credential.yaml"), `records:\n${block(fields)}`);
    await chmod(join(dir, "credential.yaml"), mode);
    await writeFile(join(dir, "meta.json"), JSON.stringify({ accountId: fields.accountId, custom: "retained" }));
    return dir;
  };
  await current(payload("a"));
  await snapshot("alpha", payload("a", { access: "STALE-A-SNAPSHOT", refresh: "STALE-A-REFRESH" }));
  await snapshot("beta", payload("b"));
  return { home, current, snapshot, live: () => readFile(join(home, ".credentials.yaml"), "utf8"), saved: (label) => readFile(join(home, "accounts", label, "credential.yaml"), "utf8") };
}
const switchOptions = (home, updates = {}) => ({ dshHome: home, id: "openai-codex:beta", expectedActiveId: "openai-codex:alpha", discover: discoverCodexAccounts, queryQuota: async () => okQuota, refreshTokens: async () => assert.fail("unexpected refresh"), ...updates });

function host(t, home, curl = (_file, _args, _opts, cb) => cb(null, `${quotaJSON}\n200`, "")) {
  let handler;
  const cleanups = [];
  const logs = [];
  apply({
    get: (key) => key === "dshHomePath" ? (...parts) => join(home, ...parts) : undefined,
    logger: { warn: (line) => logs.push(line), error: (line) => logs.push(line) },
    sessionQuery: { listSessions: async () => [] },
    webServer: { register: (route) => { handler = route.handler; } },
    effect: (fn) => { const cleanup = fn(); if (cleanup) cleanups.push(cleanup); },
  }, { quotaExecFile: curl });
  t.after(() => cleanups.forEach((fn) => fn()));
  return {
    logs,
    request: async (body = { id: "openai-codex:beta", expectedActiveId: "openai-codex:alpha", confirmed: true }, headers = {}, path = "/usage-lite/accounts/switch", method = "POST") => {
      const req = Readable.from([typeof body === "string" ? body : JSON.stringify(body)]);
      req.method = method; req.url = path;
      req.headers = { host: "localhost:1234", origin: "http://localhost:1234", "content-type": "application/json; charset=utf-8", "x-usage-lite-action": "switch-account", ...headers };
      let status, result;
      await handler(req, { writeHead: (code) => { status = code; }, end: (text) => { result = JSON.parse(text); } });
      return { status, ...result };
    },
  };
}

test("only saved real account directories advertise switch capability, including expired refreshable targets", async (t) => {
  const f = await fixture(t);
  await f.snapshot("expired", payload("c", { expires: 1, access: jwt("c", 1) }));
  await f.snapshot("_previous", payload("hidden"));
  await symlink(join(f.home, "accounts", "beta"), join(f.home, "accounts", "linked-dir"));
  await mkdir(join(f.home, "accounts", "linked-file"));
  await symlink(join(f.home, "accounts", "beta", "credential.yaml"), join(f.home, "accounts", "linked-file", "credential.yaml"));
  let accounts = await discoverCodexAccounts(f.home);
  assert.equal(accounts.length, 3);
  assert.ok(accounts.every((entry) => entry.account.switchable));
  await f.current(payload("unsaved"));
  accounts = await discoverCodexAccounts(f.home);
  assert.equal(accounts.find((entry) => entry.account.active).account.switchable, false);
  const empty = await mkdtemp(join(tmpdir(), "usage-lite-no-accounts-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  assert.equal((await discoverCodexAccounts(empty))[0].account.switchable, false);
});

test("validated switch changes one record, preserves permissions, and saves current live rotations to every named copy", async (t) => {
  const f = await fixture(t);
  await f.current(payload("a", { access: jwt("a"), refresh: "LATEST-A-REFRESH", extra: "retained-current-field" }), 0o640);
  await f.snapshot("alpha-copy", payload("a", { refresh: "STALE-COPY" }), 0o640);
  const before = await f.live();
  const record = codexRecord(before);
  const beforePrefix = record.lines.slice(0, record.start).join("\n");
  const beforeSuffix = record.lines.slice(record.end).join("\n");
  let validated = false;
  const result = await switchCodexAccount(switchOptions(f.home, { queryQuota: async (fields) => {
    assert.equal(codexRecord(await f.live()).fields.accountId, "a", "must validate before installing");
    assert.equal(fields.accountId, "b"); validated = true; return okQuota;
  } }));
  assert.equal(result.id, "openai-codex:beta");
  assert.ok(validated);
  const after = await f.live();
  assert.equal(codexRecord(after).fields.accountId, "b");
  const installed = codexRecord(after);
  assert.equal(installed.lines.slice(0, installed.start).join("\n"), beforePrefix);
  assert.equal(installed.lines.slice(installed.end).join("\n"), beforeSuffix);
  assert.equal(installed.block, codexRecord(await f.saved("beta")).block);
  assert.equal((await stat(join(f.home, ".credentials.yaml"))).mode & 0o777, 0o640);
  for (const label of ["alpha", "alpha-copy", "_previous"]) {
    const fields = codexRecord(await f.saved(label)).fields;
    assert.equal(fields.refresh, "LATEST-A-REFRESH");
    assert.match(await f.saved(label), /      extra: "retained-current-field"/);
  }
  assert.equal((await stat(join(f.home, "accounts", "alpha-copy", "credential.yaml"))).mode & 0o777, 0o640);
  assert.equal((await stat(join(f.home, "accounts", "_previous"))).mode & 0o777, 0o700);
  assert.equal((await stat(join(f.home, "accounts", "_previous", "credential.yaml"))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(join(f.home, "accounts", "alpha", "meta.json"), "utf8")).custom, "retained");
  const backups = (await readdir(f.home)).filter((name) => name.includes(".bak-usage-lite-"));
  assert.equal(backups.length, 1); assert.equal(await readFile(join(f.home, backups[0]), "utf8"), before);
  assert.equal((await stat(join(f.home, backups[0]))).mode & 0o777, 0o600);
});

test("record-boundary comments, blank lines, refs and missing terminal newline remain byte-exact", async (t) => {
  const f = await fixture(t);
  const cases = [
    `refs:\n  key: unchanged\nrecords:\n${block(payload("a"))}  # comment for next provider\n  other:\n    payload:\n      value: unchanged\n`,
    `records:\n${block(payload("a"))}\n# root comment\nrefs:\n  key: unchanged`,
    `refs:\n  key: unchanged\nrecords:\n${block(payload("a")).trimEnd()}`,
    `records:\n${block(payload("a"))}\n\n`,
  ];
  for (const before of cases) {
    await writeFile(join(f.home, ".credentials.yaml"), before);
    const oldRecord = codexRecord(before);
    const expected = [...oldRecord.lines.slice(0, oldRecord.start), ...`${codexRecord(await f.saved("beta")).block}${oldRecord.lines.slice(oldRecord.start, oldRecord.end).join("\n").match(/\n*$/)[0]}`.split("\n"), ...oldRecord.lines.slice(oldRecord.end)].join("\n");
    await switchCodexAccount(switchOptions(f.home));
    assert.equal(await f.live(), expected);
  }
});

test("expired target refresh is persisted before validation, including when validation fails", async (t) => {
  const f = await fixture(t);
  await f.snapshot("beta", payload("b", { expires: 1, access: jwt("b", 1) }));
  const before = await f.live();
  const rotated = { access: jwt("b"), refresh: "ROTATED-REFRESH-B", expires: Date.now() + 7200000 };
  let refreshed = 0;
  await assert.rejects(switchCodexAccount(switchOptions(f.home, {
    refreshTokens: async (old) => { assert.equal(old, "SECRET-REFRESH-b"); refreshed++; return rotated; },
    queryQuota: async () => {
      assert.equal(codexRecord(await f.saved("beta")).fields.refresh, rotated.refresh);
      return { status: "error", error: "RAW-SECRET-UPSTREAM" };
    },
  })), (error) => error.status === 502 && !error.message.includes("RAW-SECRET"));
  assert.equal(refreshed, 1); assert.equal(await f.live(), before);
  assert.equal(codexRecord(await f.saved("beta")).fields.refresh, rotated.refresh);
  await switchCodexAccount(switchOptions(f.home));
  assert.equal(codexRecord(await f.live()).fields.refresh, rotated.refresh);
});

test("an unexpired revoked target refreshes once, but a 403/network failure never installs or refreshes", async (t) => {
  const f = await fixture(t);
  let queries = 0, refreshes = 0;
  await switchCodexAccount(switchOptions(f.home, {
    queryQuota: async () => ++queries === 1 ? { status: "error", unauthorized: true } : okQuota,
    refreshTokens: async () => { refreshes++; return { access: jwt("b"), refresh: "ROTATED-ON-401", expires: Date.now() + 7200000 }; },
  }));
  assert.equal(queries, 2); assert.equal(refreshes, 1);
  await f.current(payload("a"));
  const before = await f.live();
  await assert.rejects(switchCodexAccount(switchOptions(f.home, { queryQuota: async () => ({ status: "error", error: "403" }) })), /额度验证失败/);
  assert.equal(await f.live(), before);
});

test("invalid/active/stale/undiscovered IDs are rejected without network or credential writes", async (t) => {
  const f = await fixture(t);
  const before = await f.live();
  for (const updates of [
    { id: "openai-codex:alpha" }, { id: "openai-codex:../../outside" },
    { id: "zai-coding-cn" }, { id: "openai-codex:_previous" },
    { id: "openai-codex:b" }, { expectedActiveId: "openai-codex:old" },
  ]) {
    await assert.rejects(switchCodexAccount(switchOptions(f.home, { ...updates, queryQuota: async () => assert.fail("must reject before query") })), AccountSwitchError);
    assert.equal(await f.live(), before);
  }
});

test("account changes during preflight conflict; live token refreshes for the same account are backed up", async (t) => {
  const f = await fixture(t);
  await assert.rejects(switchCodexAccount(switchOptions(f.home, { queryQuota: async () => { await f.current(payload("external")); return okQuota; } })), (error) => error.status === 409);
  assert.equal(codexRecord(await f.live()).fields.accountId, "external");
  await f.current(payload("a"));
  await switchCodexAccount(switchOptions(f.home, { queryQuota: async () => { await f.current(payload("a", { refresh: "ROTATED-DURING-PREFLIGHT" })); return okQuota; } }));
  assert.equal(codexRecord(await f.saved("alpha")).fields.refresh, "ROTATED-DURING-PREFLIGHT");
});

test("a target changed during validation conflicts instead of installing a superseded snapshot", async (t) => {
  const f = await fixture(t);
  const before = await f.live();
  await assert.rejects(switchCodexAccount(switchOptions(f.home, {
    queryQuota: async () => { await f.snapshot("beta", payload("b", { refresh: "EXTERNAL-ROTATION" })); return okQuota; },
  })), (error) => error.status === 409);
  assert.equal(await f.live(), before);
  assert.equal(codexRecord(await f.saved("beta")).fields.refresh, "EXTERNAL-ROTATION");
});

test("rotated refresh survives an identity mismatch but the mismatched account is never installed", async (t) => {
  const f = await fixture(t);
  await f.snapshot("beta", payload("b", { expires: 1 }));
  const before = await f.live();
  await assert.rejects(switchCodexAccount(switchOptions(f.home, {
    refreshTokens: async () => ({ access: jwt("different"), refresh: "PERSISTED-DESPITE-MISMATCH", expires: Date.now() + 7200000 }),
  })), /不一致/);
  assert.equal(await f.live(), before);
  assert.equal(codexRecord(await f.saved("beta")).fields.refresh, "PERSISTED-DESPITE-MISMATCH");
});

test("single-flight protects a home even across independent callers", async (t) => {
  const f = await fixture(t);
  let release, started;
  const ready = new Promise((resolve) => { started = resolve; });
  const waiting = new Promise((resolve) => { release = resolve; });
  const first = switchCodexAccount(switchOptions(f.home, { queryQuota: async () => { started(); await waiting; return okQuota; } }));
  await ready;
  await assert.rejects(switchCodexAccount(switchOptions(f.home)), (error) => error.status === 409 && /正在进行/.test(error.message));
  release(); await first;
});

test("identity mismatch, malformed records, and unusable expired tokens fail closed", async (t) => {
  const f = await fixture(t);
  const before = await f.live();
  await f.snapshot("beta", payload("b", { access: jwt("different") }));
  await assert.rejects(switchCodexAccount(switchOptions(f.home)), /不一致/);
  await f.snapshot("beta", payload("b", { expires: 1, refresh: "" }));
  await assert.rejects(switchCodexAccount(switchOptions(f.home)), /无法续期/);
  assert.throws(() => codexRecord(`records:\n${block(payload("b"))}${block(payload("b"))}`), /重复/);
  assert.throws(() => codexRecord(`refs:\n${block(payload("b"))}`), /位置/);
  assert.throws(() => codexRecord(`records:\n${block(payload("b")).replace("kind: grant", "kind: secret")}`), /OAuth grant/);
  assert.equal(await f.live(), before);
});

test("snapshot/backup preflight failures do not install target and symlinks are never written through", async (t) => {
  const f = await fixture(t);
  const before = await f.live();
  const outside = join(f.home, "outside-credential.yaml");
  await writeFile(outside, "must-not-change");
  await mkdir(join(f.home, "accounts", "_previous"));
  await symlink(outside, join(f.home, "accounts", "_previous", "credential.yaml"));
  await assert.rejects(switchCodexAccount(switchOptions(f.home)), /普通文件/);
  assert.equal(await f.live(), before);
  assert.equal(await readFile(outside, "utf8"), "must-not-change");
});

test("HTTP route returns a fresh snapshot and only installs after successful validation", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const h = host(t, f.home, (_file, args, _opts, cb) => {
    calls++;
    assert.ok(args.includes("chatgpt-account-id: b"));
    cb(null, `${quotaJSON}\n200`, "");
  });
  const result = await h.request();
  assert.equal(result.status, 200); assert.equal(result.ok, true); assert.match(result.message, /无需重启/);
  assert.equal(calls, 1);
  assert.equal(result.providers.find((provider) => provider.account?.active).id, "openai-codex:beta");
  assert.equal(result.providers.find((provider) => provider.id === "openai-codex:beta").status, "ok");
  assert.ok(!JSON.stringify(result).includes("SECRET-REFRESH"));
  const cached = await h.request({}, {}, "/usage-lite/quotas", "GET");
  assert.equal(cached.providers.find((provider) => provider.account?.active).id, "openai-codex:beta");
  assert.equal(calls, 1);
  const stale = await h.request();
  assert.equal(stale.status, 409); assert.equal(stale.ok, false);
  assert.equal(stale.providers.find((provider) => provider.account?.active).id, "openai-codex:beta");
});

test("HTTP switch requires header/JSON/same origin and exact allowlisted body", async (t) => {
  const f = await fixture(t);
  const before = await f.live();
  const h = host(t, f.home, () => assert.fail("invalid request must not query"));
  const valid = { id: "openai-codex:beta", expectedActiveId: "openai-codex:alpha", confirmed: true };
  for (const [body, headers, status] of [
    [valid, { "x-usage-lite-action": undefined }, 403],
    [valid, { "x-usage-lite-action": "other" }, 403],
    [valid, { "content-type": "text/plain" }, 415],
    [valid, { origin: "https://evil.example" }, 403],
    [valid, { origin: "null" }, 403],
    [valid, { origin: "http://localhost:1234/path" }, 403],
    [valid, { origin: "http://localhost:9999" }, 403],
    [valid, { origin: "https://localhost:1234" }, 403],
    ["{bad", {}, 400], ["[]", {}, 400],
    [{ ...valid, confirmed: false }, {}, 400],
    [{ ...valid, extra: "not-allowed" }, {}, 400],
    [{ id: valid.id, confirmed: true }, {}, 400],
    [{ ...valid, id: { nested: true } }, {}, 400],
    [" ".repeat(4097), {}, 413],
  ]) {
    const result = await h.request(body, headers);
    assert.equal(result.status, status); assert.equal(result.ok, false);
    assert.ok(Array.isArray(result.providers), "failure includes fresh quota snapshot");
    assert.equal(await f.live(), before);
  }
});

test("successful installation is not reported as failure when quota cache cannot be persisted", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, "usage-lite"), "not-a-directory");
  const h = host(t, f.home);
  const result = await h.request(undefined, { origin: undefined });
  assert.equal(result.status, 200); assert.equal(result.ok, true);
  assert.equal(codexRecord(await f.live()).fields.accountId, "b");
  assert.equal(result.providers.find((provider) => provider.account?.active).id, "openai-codex:beta");
  assert.ok(h.logs.some((line) => line.includes("quota snapshot persist failed")));
});

test("HTTP conflict is immediate while a request is in flight, with no second upstream call", async (t) => {
  const f = await fixture(t);
  let release, started, calls = 0;
  const ready = new Promise((resolve) => { started = resolve; });
  const h = host(t, f.home, (_file, _args, _opts, cb) => { calls++; release = () => cb(null, `${quotaJSON}\n200`, ""); started(); });
  const first = h.request(); await ready;
  const second = await h.request();
  assert.equal(second.status, 409); assert.equal(second.ok, false); assert.equal(calls, 1);
  release(); assert.equal((await first).ok, true);
});

test("HTTP refresh and upstream failures never return or log raw child output or install target", async (t) => {
  const f = await fixture(t);
  await f.snapshot("beta", payload("b", { access: jwt("b", 1), expires: 1 }));
  const before = await f.live();
  const h = host(t, f.home, (_file, args, _opts, cb) => cb(new Error(`SECRET-CHILD-ERROR ${args.join(" ")}`), "SECRET-STDOUT", "SECRET-STDERR"));
  const result = await h.request();
  assert.equal(result.status, 502); assert.equal(result.ok, false); assert.equal(await f.live(), before);
  const exposed = JSON.stringify([result, h.logs]);
  for (const secret of ["SECRET-CHILD", "SECRET-STDOUT", "SECRET-STDERR", "SECRET-REFRESH"]) assert.ok(!exposed.includes(secret));
});

test("token refresher uses fixed endpoint, validates rotation response, and sanitizes thrown/callback errors", async () => {
  const refresh = createTokenRefresher((file, args, opts, cb) => {
    assert.equal(file, "/usr/bin/curl");
    assert.equal(args.at(-1), "https://auth.openai.com/oauth/token");
    assert.ok(args.includes("grant_type=refresh_token&refresh_token=FAKE&client_id=app_EMoamEEZ73f0CkXaXp7hrann"));
    assert.equal(opts.timeout, 23000);
    cb(null, `${JSON.stringify({ access_token: "FAKE-ACCESS", refresh_token: "NEW-FAKE-REFRESH", expires_in: 3600 })}\n200`, "");
  });
  assert.equal((await refresh("FAKE")).refresh, "NEW-FAKE-REFRESH");
  for (const fake of [
    (_file, _args, _opts, cb) => cb(null, '{"access_token":"SECRET"}\n200'),
    (_file, _args, _opts, cb) => cb(new Error("SECRET"), "SECRET", "SECRET"),
    () => { throw new Error("SECRET"); },
  ]) await assert.rejects(createTokenRefresher(fake)("FAKE"), (error) => error.status === 502 && !error.message.includes("SECRET"));
});
