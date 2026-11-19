import { execFile } from "node:child_process";

/** Fixed HTTPS targets, no redirects/retries/.curlrc; request secrets only on stdin. */
export function createQuotaTransport(exec = execFile) {
  return (url, { headers = [], data, proxy, seconds = 12 } = {}) => new Promise((resolve) => {
    const failed = (error) => resolve({ status: 0, text: "", timedOut: error?.killed === true || error?.code === 28 });
    if (headers.some((header) => /[\r\n\0]/.test(header)) || (data !== undefined && headers.length)) {
      failed(); return;
    }
    const args = ["-q", "--proto", "=https", "-s", "-m", String(seconds), "-w", "\n%{http_code}"];
    if (proxy) args.push("-x", proxy);
    if (data !== undefined) args.push("-H", "Content-Type: application/x-www-form-urlencoded", "--data-binary", "@-");
    else if (headers.length) args.push("-H", "@-");
    args.push(url);
    try {
      const child = exec("/usr/bin/curl", args, {
        timeout: (seconds + 3) * 1000, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: 1 << 20,
      }, (error, stdout) => {
        if (error) return failed(error);
        const pos = stdout?.lastIndexOf("\n") ?? -1;
        const status = pos < 0 ? 0 : Number(stdout.slice(pos + 1).trim());
        resolve({ status: Number.isInteger(status) ? status : 0, text: pos < 0 ? "" : stdout.slice(0, pos) });
      });
      // curl may exit before consuming stdin; errors here must not become unhandled events.
      child.stdin.on("error", () => {});
      child.stdin.end(data ?? (headers.length ? `${headers.join("\n")}\n` : ""));
    } catch (error) { failed(error); }
  });
}

export const codexProxy = () => process.env.HTTPS_PROXY || process.env.https_proxy || "http://127.0.0.1:7897";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const REJECTED = new Set(["invalid_grant", "invalid_token", "refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"]);

export class TokenRefreshError extends Error {
  constructor(kind) { super(kind); this.kind = kind; }
}

export function createTokenRefresher(request = createQuotaTransport()) {
  return async (refresh) => {
    const data = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT_ID }).toString();
    const { status, text } = await request(TOKEN_URL, { data, proxy: codexProxy(), seconds: 15 });
    let json;
    try { json = JSON.parse(text); } catch {}
    if (status !== 200) {
      const code = typeof json?.error === "string" ? json.error : json?.error?.code;
      if ([400, 401, 403].includes(status) && REJECTED.has(code)) throw new TokenRefreshError("rejected");
      // No upstream content is included. A failed or truncated response may follow a rotation.
      throw new TokenRefreshError("unknown");
    }
    const seconds = json?.expires_in;
    if (typeof json?.access_token !== "string" || !json.access_token || typeof json?.refresh_token !== "string" || !json.refresh_token || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 365 * 86400) throw new TokenRefreshError("unknown");
    return { access: json.access_token, refresh: json.refresh_token, expires: Date.now() + seconds * 1000 };
  };
}
