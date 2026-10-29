import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, discoverCodexAccounts } from "./index.mjs";

async function home(t) {
  const path = await mkdtemp(join(tmpdir(), "usage-lite-edge-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

test("malformed snapshots and JWT claims do not prevent independent discovery", async (t) => {
  const root = await home(t);
  for (const label of ["bad", "good"]) await mkdir(join(root, "accounts", label), { recursive: true });
  await writeFile(join(root, "accounts", "bad", "credential.yaml"), "not a record");
  await writeFile(join(root, "accounts", "bad", "meta.json"), "{invalid JSON");
  await writeFile(join(root, "accounts", "good", "credential.yaml"), "  llm-pi-ai/openai-codex:\n    payload:\n      accountId: good\n      access: test.bnVsbA.signature\n");
  await writeFile(join(root, "accounts", "good", "meta.json"), JSON.stringify({ email: "fallback@example.test" }));
  const accounts = await discoverCodexAccounts(root);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].account.email, "fallback@example.test");
  assert.equal(accounts[0].account.active, false);
});

test("old quota version is ignored and GLM quota fields remain unchanged", async (t) => {
  const root = await home(t);
  await mkdir(join(root, "usage-lite"));
  await writeFile(join(root, "usage-lite", "quotas.json"), JSON.stringify({ version: 1, providers: [{ id: "openai-codex", status: "ok" }] }));
  await writeFile(join(root, ".credentials.yaml"), "refs:\n  ZAI_CODING_CN_API_KEY: FAKE-GLM-KEY\n");
  let handler;
  let requests = 0;
  const disposers = [];
  apply({
    get: () => (...parts) => join(root, ...parts),
    logger: { warn() {}, error() {} },
    sessionQuery: { listSessions: async () => [] },
    effect: (fn) => { const cleanup = fn(); if (cleanup) disposers.push(cleanup); },
    webServer: { register: (route) => { handler = route.handler; } },
  }, { quotaExecFile: (_file, args, _opts, cb) => {
    requests++;
    assert.ok(args.includes("Authorization: Bearer FAKE-GLM-KEY"));
    cb(null, `${JSON.stringify({ success: true, data: { level: "Pro", limits: [{ type: "CREDIT_LIMIT", unit: 3, percentage: 10, usage: 100, currentValue: 10, remaining: 90, nextResetTime: 12345 }] } })}\n200`, "");
  } });
  t.after(() => disposers.forEach((fn) => fn()));
  const get = async (refresh = false) => {
    let data;
    await handler({ method: "GET", url: `/usage-lite/quotas${refresh ? "?refresh=1" : ""}` }, { writeHead() {}, end(s) { data = JSON.parse(s); } });
    return data;
  };
  const cached = await get();
  assert.equal(cached.version, 2);
  assert.equal(cached.queriedAt, null);
  assert.ok(cached.providers.every((p) => p.status === "pending"));
  assert.equal(requests, 0);
  const refreshed = await get(true);
  const glm = refreshed.providers.find((p) => p.id === "zai-coding-cn");
  assert.equal(glm.label, "智谱 GLM Coding Pro");
  assert.equal(glm.plan, "Pro");
  assert.equal(glm.status, "ok");
  assert.deepEqual(glm.windows, [{ label: "5 小时窗口", usedPercent: 10, detail: "已用 10 / 100 · 剩 90 积分", resetAfterSeconds: null, resetAt: 12345 }]);
  assert.equal(requests, 1);
});
