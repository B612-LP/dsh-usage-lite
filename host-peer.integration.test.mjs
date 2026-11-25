import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import * as usage from "./index.mjs";

// Desktop: ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_EXECUTABLE" --test host-peer.integration.test.mjs
// DSH_INSTALL_DIR must be the CLI package directory from that same installation.
const installDir = process.env.DSH_INSTALL_DIR && resolve(process.env.DSH_INSTALL_DIR);
const manifestPath = installDir && join(installDir, "package.json");
const skip = !installDir ? "DSH_INSTALL_DIR is not set"
  : /[\\/]app\.asar[\\/]/i.test(installDir) && !existsSync(manifestPath)
    ? "Desktop ASAR is unreadable; use the installed Electron with ELECTRON_RUN_AS_NODE=1"
    : false;

function importHostPackage(name) {
  const sibling = join(dirname(installDir), name, "lib", "index.js");
  if (existsSync(sibling)) return import(pathToFileURL(sibling).href);
  // Built source checkouts / non-hoisted npm installs resolve from the CLI.
  const requireFromCli = createRequire(manifestPath);
  const packageDir = dirname(requireFromCli.resolve(`@deepseek-ai/${name}/package.json`));
  return import(pathToFileURL(join(packageDir, "lib", "index.js")).href);
}

const proxyHost = "usage-lite-proxy.test";
const fakeKey = "test-only-zai-key";
const credentialsDocument = `version: 1\nrefs:\n  ZAI_CODING_CN_API_KEY: ${fakeKey}\n`;

function hit(t, port, path, { method = "GET", cookie, origin } = {}) {
  // The authority is proxy-shaped, but the actual socket is always loopback.
  return new Promise((resolveReply, reject) => {
    const req = request({
      hostname: "127.0.0.1", port, path: `/usage-lite${path}`, method, agent: false,
      signal: AbortSignal.any([t.signal, AbortSignal.timeout(3_000)]),
      headers: { host: proxyHost, ...(cookie && { cookie }), ...(origin && { origin }) },
    }, async (res) => {
      try {
        res.setEncoding("utf8");
        let body = "";
        for await (const chunk of res) body += chunk;
        resolveReply({ status: res.statusCode, body });
      } catch (error) { reject(error); }
    });
    req.on("error", reject);
    req.end();
  });
}

function ok({ status, body }) {
  assert.equal(status, 200, body);
  const payload = JSON.parse(body);
  assert.equal(payload.ok, true);
  return payload;
}

test("usage-lite quotas with the installed Host Peer", { skip, timeout: 15_000 }, async (t) => {
  assert.equal(JSON.parse(await readFile(manifestPath, "utf8")).name, "@deepseek-ai/dsh");
  const [{ Context }, { WebServer }, { LocalCredentialProvider }, connection, desktopAuth] = await Promise.all([
    importHostPackage("cordis"), importHostPackage("dsh-host-webserver"),
    importHostPackage("dsh-credentials-local"), importHostPackage("dsh-client-connection"),
    importHostPackage("dsh-host-authentication-desktop"),
  ]);

  const ctx = new Context();
  const tempRoot = resolve(tmpdir());
  const profile = await mkdtemp(join(tempRoot, "dsh-usage-lite-peer-"));
  t.after(async () => {
    try { await ctx.fiber.dispose(); }
    finally {
      assert.equal(dirname(profile), tempRoot);
      await rm(profile, { recursive: true, force: true });
    }
  });
  const credentialsPath = join(profile, ".credentials.yaml");
  await writeFile(credentialsPath, credentialsDocument, { mode: 0o600 });
  ctx.provide("dshHomePath", (...parts) => join(profile, ...parts));
  ctx.provide("sessionQuery", { listSessions: async () => [] });
  await ctx.plugin(WebServer, { host: "127.0.0.1", port: 0, compression: "none" }).await();
  await ctx.plugin(LocalCredentialProvider, { path: credentialsPath, dshHome: profile, watch: false }).await();
  await ctx.plugin(connection, { trustedHosts: [proxyHost] }).await();
  const secret = randomBytes(32).toString("base64url");
  await ctx.plugin(desktopAuth, { readSecret: () => secret }).await();

  const requests = [];
  let refreshTokensCalls = 0;
  // Keep the production injection declaration intact; a permissive test context
  // or extra injections would hide Cordis's caller-scope enforcement.
  await ctx.plugin(usage, {
    quotaRequest: async (url, options) => {
      requests.push({ url, headers: options.headers });
      return { status: 200, text: JSON.stringify({ success: true, data: {
        limits: [{ type: "CREDIT_LIMIT", unit: 3, percentage: 17 }],
      } }) };
    },
    refreshTokens: async () => { refreshTokensCalls++; throw new Error("unexpected token renewal"); },
    renewalEnabled: false,
  }).await();

  const port = ctx.webServer.port;
  assert.ok(Number.isInteger(port) && port > 0);
  const cookie = `dsh-desktop-session=${secret}`;
  await t.test("owner GET /quotas without Origin", async (t) => {
    const data = ok(await hit(t, port, "/quotas", { cookie }));
    assert.equal(data.canRenew, false);
    assert.equal(data.providers.find(({ id }) => id === "zai-coding-cn")?.status, "pending");
    assert.equal(requests.length, 0);
  });
  await t.test("owner GET /quotas/renewal-status without Origin", async (t) => {
    assert.deepEqual(ok(await hit(t, port, "/quotas/renewal-status", { cookie })), { ok: true, renewing: false });
  });
  await t.test("owner POST /quotas/refresh without Origin queries quotas, not tokens", async (t) => {
    const data = ok(await hit(t, port, "/quotas/refresh", { method: "POST", cookie }));
    const glm = data.providers.find(({ id }) => id === "zai-coding-cn");
    assert.equal(glm?.status, "ok");
    assert.equal(glm.windows[0]?.usedPercent, 17);
    assert.deepEqual(requests, [{
      url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit", headers: [`Authorization: Bearer ${fakeKey}`],
    }]);
    assert.equal(refreshTokensCalls, 0);
    assert.equal(await readFile(credentialsPath, "utf8"), credentialsDocument);
  });
  await t.test("no Desktop cookie returns 401", async (t) => {
    const reply = await hit(t, port, "/quotas");
    assert.equal(reply.status, 401, reply.body);
  });
  await t.test("mismatched Origin returns 403 even for the owner", async (t) => {
    const reply = await hit(t, port, "/quotas/refresh", { method: "POST", cookie, origin: "https://other.test" });
    assert.equal(reply.status, 403, reply.body);
  });
});
