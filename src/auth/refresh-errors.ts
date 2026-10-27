/**
 * Thrown when an OAuth refresh attempt returns a server-side signal that the
 * refresh token is permanently unusable (expired, reused, or invalidated).
 * AccountManager treats this as a terminal state — it sets a long cooldown
 * and surfaces a clear "re-run --login" message in /admin/accounts so the
 * operator knows the account needs a fresh login, not just another retry.
 *
 * Mirrors codex-rs/login/src/auth/manager.rs RefreshTokenFailedReason
 * (Expired, Exhausted, Revoked).
 */
export class RefreshTokenExhaustedError extends Error {
  readonly reason: "expired" | "reused" | "invalidated" | "other";
  readonly httpStatus: number;
  constructor(
    reason: RefreshTokenExhaustedError["reason"],
    httpStatus: number,
    detail?: string,
  ) {
    super(
      detail
        ? `refresh token ${reason} (HTTP ${httpStatus}): ${detail}`
        : `refresh token ${reason} (HTTP ${httpStatus})`,
    );
    this.name = "RefreshTokenExhaustedError";
    this.reason = reason;
    this.httpStatus = httpStatus;
  }
}

/**
 * Inspect an OAuth error body to detect a permanent-failure signal.
 * Recognises the codes the OpenAI auth backend sends, plus the standard OAuth 2.0
 * `invalid_grant` returned by Anthropic and Google.
 */
export function detectExhaustedReason(
  body: string,
): RefreshTokenExhaustedError["reason"] | null {
  if (!body || !body.trim()) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  let code: string | null = null;
  const err = parsed?.error;
  if (typeof err === "string") code = err;
  else if (err && typeof err === "object" && typeof err.code === "string")
    code = err.code;
  else if (typeof parsed?.code === "string") code = parsed.code;
  if (!code) return null;
  const normalized = code.toLowerCase();
  if (normalized === "refresh_token_expired") return "expired";
  if (normalized === "refresh_token_reused") return "reused";
  // "refresh_token_invalidated" is the code-name form; OpenAI's actual auth
  // backend returns "invalid_refresh_token" for the same terminal condition
  // (seen on codex refresh 401s: "Could not validate your refresh token.
  // Please try signing in again."). Both mean the token is dead, not retryable.
  if (normalized === "refresh_token_invalidated") return "invalidated";
  if (normalized === "invalid_refresh_token") return "invalidated";
  // RFC 6749 §5.2 "invalid_grant": the refresh token is expired, revoked or
  // otherwise unusable — retrying can never succeed. Anthropic and Google
  // answer with the bare string form {"error":"invalid_grant",
  // "error_description":"Refresh token expired"}.
  if (normalized === "invalid_grant") {
    const description = String(parsed?.error_description ?? "").toLowerCase();
    return description.includes("expired") ? "expired" : "invalidated";
  }
  return null;
}
