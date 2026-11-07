import { createHash, randomBytes } from "node:crypto";
import { TokenData } from "../types";

/**
 * Mistral Vibe browser sign-in (same flow as `vibe --setup`, mistral-vibe 3.1.0,
 * `vibe/setup/auth/http_browser_sign_in_gateway.py` + `browser_sign_in.py`).
 * It does NOT yield an OAuth token: the browser approval is exchanged for a
 * long-lived Mistral API key (no refresh token), scoped to the account's
 * "Vibe" monthly budget. Internal, undocumented protocol:
 *
 *   1. POST {api}/vibe/sign-in {code_challenge, code_challenge_method:"S256"}
 *      -> {process_id, sign_in_url, poll_url, expires_at}
 *   2. the user opens sign_in_url (console.mistral.ai/codestral/cli/authenticate?...)
 *   3. GET poll_url every 3 s -> {status: pending|completed|expired|denied|error,
 *      exchange_token?}; HTTP 410 = expired
 *   4. POST {api}/vibe/sign-in/{process_id}/exchange {exchange_token, code_verifier}
 *      -> {api_key}; 403 with error_code 9004 = workspace not eligible.
 *
 * {api} is https://console.mistral.ai/api (Vibe's DEFAULT_MISTRAL_BROWSER_AUTH_API_BASE_URL).
 * The experimental OIDC flow of Vibe 3.1 is deliberately not used.
 */

export const MISTRAL_CONSOLE_URL = "https://console.mistral.ai";
export const MISTRAL_SIGN_IN_API = `${MISTRAL_CONSOLE_URL}/api`;
export const MISTRAL_API_BASE = "https://api.mistral.ai";
/** User-Agent of the official CLI whose sign-in flow and key we reuse. */
export const MISTRAL_VIBE_USER_AGENT = "Mistral-Vibe/3.1.0";

/** Placeholder stored as refresh_token: a Vibe key cannot be refreshed. */
export const MISTRAL_NO_REFRESH = "mistral-vibe-key";
/** No expiry is announced for the key; stored far in the future like Copilot. */
const KEY_LIFETIME_MS = 3650 * 86_400_000;

const POLL_INTERVAL_MS = 3000;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
/**
 * console.mistral.ai rate-limits /api/vibe/sign-in* (429 with `retry-after: 0`,
 * seen live on 2026-11-07 after ~5 min of polling every 3 s). A 429 is not a
 * failure of the sign-in: wait longer (doubling, capped) and keep polling until
 * the process expires.
 */
const RATE_LIMIT_MAX_WAIT_MS = 30_000;
const EXCHANGE_MAX_ATTEMPTS = 3;
const WORKSPACE_NOT_ELIGIBLE_CODE = 9004;

export interface VibeLoginOptions {
  onLoginUrl?: (url: string) => void | Promise<void>;
  /** Hard cap on top of the server's expires_at (default 15 min). */
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface SignInProcess {
  process_id: string;
  sign_in_url: string;
  poll_url: string;
  expires_at: string;
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Same sizes as Vibe: verifier = token_urlsafe(64), S256 challenge. */
export function generateVibePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(64));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

/**
 * Refuses any URL that is not on `base` (origin + path prefix), as Vibe does:
 * the sign-in server must not be able to send us (or the user) elsewhere.
 */
export function assertUnderBase(
  value: unknown,
  base: string,
  what: string,
): string {
  if (typeof value !== "string")
    throw new Error(`Mistral sign-in: ${what} missing`);
  let url: URL;
  let ref: URL;
  try {
    url = new URL(value);
    ref = new URL(base);
  } catch {
    throw new Error(`Mistral sign-in: invalid ${what}`);
  }
  const basePath = ref.pathname.replace(/\/+$/, "");
  const path = decodeURIComponent(url.pathname);
  const pathOk =
    !basePath || path === basePath || path.startsWith(`${basePath}/`);
  if (url.origin !== ref.origin || !pathOk || path.includes("/../")) {
    throw new Error(`Mistral sign-in: unexpected ${what} host or path`);
  }
  return url.toString();
}

function headers(extra?: Record<string, string>): Record<string, string> {
  return {
    Accept: "application/json",
    "User-Agent": MISTRAL_VIBE_USER_AGENT,
    ...extra,
  };
}

/** Next wait after a 429: Retry-After when given (> 0), else doubling from 2x the poll interval. */
export function rateLimitWait(
  resp: Response,
  previousMs: number,
  intervalMs: number,
): number {
  const ra = Number(resp.headers.get("retry-after"));
  if (Number.isFinite(ra) && ra > 0)
    return Math.min(ra * 1000, RATE_LIMIT_MAX_WAIT_MS);
  return Math.min(
    Math.max(previousMs * 2, intervalMs * 2),
    RATE_LIMIT_MAX_WAIT_MS,
  );
}

async function readJson(resp: Response): Promise<any> {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

export async function runVibeBrowserLogin(
  opts: VibeLoginOptions = {},
): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const { verifier, challenge } = generateVibePkce();

  const startResp = await doFetch(`${MISTRAL_SIGN_IN_API}/vibe/sign-in`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      code_challenge: challenge,
      code_challenge_method: "S256",
    }),
    signal: opts.signal,
  });
  if (startResp.status === 429) {
    throw new Error(
      "Mistral limits sign-in attempts (HTTP 429): retry in a few minutes",
    );
  }
  if (!startResp.ok) {
    throw new Error(`Mistral sign-in start failed (HTTP ${startResp.status})`);
  }
  const proc = (await readJson(startResp)) as SignInProcess | null;
  if (
    !proc ||
    typeof proc.process_id !== "string" ||
    !/^[A-Za-z0-9_-]{1,200}$/.test(proc.process_id)
  ) {
    throw new Error("Mistral sign-in start: invalid response");
  }
  const signInUrl = assertUnderBase(
    proc.sign_in_url,
    MISTRAL_CONSOLE_URL,
    "sign_in_url",
  );
  const pollUrl = assertUnderBase(
    proc.poll_url,
    MISTRAL_SIGN_IN_API,
    "poll_url",
  );
  const serverDeadline = Date.parse(proc.expires_at);
  const hardDeadline = now() + (opts.pollTimeoutMs ?? 15 * 60 * 1000);
  const deadline = Number.isFinite(serverDeadline)
    ? Math.min(serverDeadline, hardDeadline)
    : hardDeadline;

  await opts.onLoginUrl?.(signInUrl);

  let exchangeToken = "";
  let failures = 0;
  let backoff = 0;
  while (now() < deadline) {
    if (opts.signal?.aborted) throw new Error("Mistral sign-in aborted");
    let resp: Response;
    try {
      resp = await doFetch(pollUrl, {
        headers: headers(),
        signal: opts.signal,
      });
    } catch (err: any) {
      if (++failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new Error(`Mistral sign-in poll failed: ${err?.message || err}`);
      }
      await sleep(interval);
      continue;
    }
    if (resp.status === 410) throw new Error("Mistral sign-in expired");
    if (resp.status === 429) {
      backoff = rateLimitWait(resp, backoff, interval);
      await sleep(backoff);
      continue;
    }
    if (!resp.ok) {
      if (++failures >= MAX_CONSECUTIVE_POLL_FAILURES) {
        throw new Error(`Mistral sign-in poll failed (HTTP ${resp.status})`);
      }
      await sleep(interval);
      continue;
    }
    failures = 0;
    backoff = 0;
    const data = await readJson(resp);
    const status = data?.status;
    if (status === "pending") {
      await sleep(interval);
      continue;
    }
    if (status === "completed") {
      if (typeof data.exchange_token !== "string" || !data.exchange_token) {
        throw new Error("Mistral sign-in completed without exchange token");
      }
      exchangeToken = data.exchange_token;
      break;
    }
    if (status === "expired") throw new Error("Mistral sign-in expired");
    if (status === "denied") throw new Error("Mistral sign-in was denied");
    if (status === "error") {
      throw new Error(
        `Mistral sign-in failed: ${String(data?.message || "unknown error").slice(0, 200)}`,
      );
    }
    throw new Error("Mistral sign-in returned an unknown state");
  }
  if (!exchangeToken) throw new Error("Mistral sign-in timed out");

  // A 429 means the exchange was not processed: retrying it is safe.
  let exResp: Response;
  let exWait = 0;
  for (let attempt = 1; ; attempt++) {
    exResp = await doFetch(
      `${MISTRAL_SIGN_IN_API}/vibe/sign-in/${encodeURIComponent(proc.process_id)}/exchange`,
      {
        method: "POST",
        headers: headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          exchange_token: exchangeToken,
          code_verifier: verifier,
        }),
        signal: opts.signal,
      },
    );
    if (exResp.status !== 429 || attempt >= EXCHANGE_MAX_ATTEMPTS) break;
    exWait = rateLimitWait(exResp, exWait, interval);
    await sleep(exWait);
  }
  if (!exResp.ok) {
    const body = await readJson(exResp);
    if (
      exResp.status === 403 &&
      body?.error_code === WORKSPACE_NOT_ELIGIBLE_CODE
    ) {
      throw new Error(
        "Mistral workspace not eligible for Vibe: sign in again and pick another workspace",
      );
    }
    throw new Error(`Mistral sign-in exchange failed (HTTP ${exResp.status})`);
  }
  const exData = await readJson(exResp);
  const apiKey =
    typeof exData?.api_key === "string" ? exData.api_key.trim() : "";
  if (!apiKey) throw new Error("Mistral sign-in exchange returned no API key");
  return apiKey;
}

/**
 * Builds the stored account from a Vibe key: e-mail from GET /v1/users/me and
 * plan from GET /v1/billing/subscription (both read-only, no quota cost).
 * A rejected key (401/403 on /users/me) is an error; other failures only lose
 * the label.
 */
export async function mistralTokenFromKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenData> {
  const auth = headers({ Authorization: `Bearer ${apiKey}` });
  let email = "";
  let accountUuid = "";
  const me = await fetchImpl(`${MISTRAL_API_BASE}/v1/users/me`, {
    headers: auth,
    signal: AbortSignal.timeout(15_000),
  });
  if (me.status === 401 || me.status === 403) {
    throw new Error(`Mistral key rejected (HTTP ${me.status})`);
  }
  if (me.ok) {
    const data = await readJson(me);
    email = typeof data?.email === "string" ? data.email : "";
    accountUuid = typeof data?.id === "string" ? data.id : "";
  }
  let planType: string | undefined;
  try {
    const sub = await fetchImpl(`${MISTRAL_API_BASE}/v1/billing/subscription`, {
      headers: auth,
      signal: AbortSignal.timeout(15_000),
    });
    if (sub.ok) {
      const data = await readJson(sub);
      if (typeof data?.plan_name === "string") planType = data.plan_name;
    }
  } catch {
    /* plan is cosmetic */
  }
  const now = Date.now();
  return {
    accessToken: apiKey,
    refreshToken: MISTRAL_NO_REFRESH,
    email:
      email ||
      `vibe-${createHash("sha256").update(apiKey).digest("hex").slice(0, 8)}`,
    expiresAt: new Date(now + KEY_LIFETIME_MS).toISOString(),
    accountUuid,
    provider: "mistral",
    lastRefreshAt: new Date(now).toISOString(),
    planType,
  };
}
