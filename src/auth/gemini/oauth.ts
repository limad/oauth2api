import { PKCECodes, TokenData } from "../types";
import { timeout } from "../../utils/common";
import {
  RefreshTokenExhaustedError,
  detectExhaustedReason,
} from "../refresh-errors";

// Client id/secret: the Antigravity IDE's OAuth client (Google's official
// successor to gemini-cli for individual Code Assist access — as of
// 2026-08, Google returns UNSUPPORTED_CLIENT for gemini-cli's own client
// on the free tier and explicitly redirects to Antigravity, see
// docs/gemini-code-assist-notes.md). Captured from Antigravity's own OAuth
// traffic and cross-verified against two independently-maintained,
// actively-updated open source projects that reverse-engineered the same
// pair (30k+ and 2k+ GitHub stars respectively, both still pushing commits
// as of this writing):
//   - github.com/lbjlaq/Antigravity-Manager (src-tauri/src/modules/oauth.rs)
//   - github.com/Draculabo/AntigravityManager (cli/core.py)
// Google explicitly documents installed-app client secrets as non-sensitive:
// https://developers.google.com/identity/protocols/oauth2#installed
const ISSUER = "https://oauth2.googleapis.com";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = `${ISSUER}/token`;
export const GEMINI_CLIENT_ID =
  "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
const GEMINI_CLIENT_SECRET = "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";
export const GEMINI_CALLBACK_PORT = 54546;
export const GEMINI_CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${GEMINI_CALLBACK_PORT}${GEMINI_CALLBACK_PATH}`;
const SCOPE = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/cclog",
  "https://www.googleapis.com/auth/experimentsandconfigs",
  "https://www.googleapis.com/auth/aicode",
  "openid",
].join(" ");

export function generateGeminiAuthURL(state: string, pkce: PKCECodes): string {
  const params = new URLSearchParams({
    client_id: GEMINI_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${AUTH_URL}?${params.toString()}`;
}

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

interface GoogleUserInfo {
  email?: string;
  sub?: string;
}

async function fetchUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const resp = await fetch(
    "https://www.googleapis.com/oauth2/v3/userinfo",
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  if (!resp.ok) return {};
  try {
    return (await resp.json()) as GoogleUserInfo;
  } catch {
    return {};
  }
}

function netErr(prefix: string, err: any): Error {
  const cause = err?.cause;
  const detail = cause
    ? `${cause.code || cause.name || "error"}: ${cause.message || String(cause)}`
    : err?.message || String(err);
  return new Error(`${prefix}: ${detail}`);
}

async function tokenFromResponse(
  data: GoogleTokenResponse,
  fallbackRefreshToken: string,
): Promise<TokenData> {
  const expiresIn = data.expires_in ?? 3600;
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  const userInfo = await fetchUserInfo(data.access_token);
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || fallbackRefreshToken,
    email: userInfo.email || "unknown",
    expiresAt,
    accountUuid: userInfo.sub || userInfo.email || "",
    provider: "gemini",
    idToken: data.id_token,
  };
}

export async function exchangeGeminiCode(
  code: string,
  returnedState: string,
  expectedState: string,
  pkce: PKCECodes,
): Promise<TokenData> {
  if (returnedState !== expectedState) {
    throw new Error("OAuth state mismatch — possible CSRF attack");
  }

  let resp: Response;
  try {
    resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: GEMINI_CLIENT_ID,
        client_secret: GEMINI_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        code_verifier: pkce.codeVerifier,
      }).toString(),
    });
  } catch (err: any) {
    throw netErr("Gemini token exchange network error", err);
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Gemini token exchange failed (${resp.status}): ${text}`);
  }

  const token = await tokenFromResponse(
    (await resp.json()) as GoogleTokenResponse,
    "",
  );
  if (!token.refreshToken) {
    // Google only returns a refresh_token on the FIRST consent for a given
    // client/account pair unless `prompt=consent` forces re-issuance (which
    // generateGeminiAuthURL always sets), so this should not happen — but
    // fail loudly rather than silently produce a token that can't refresh.
    throw new Error(
      "Gemini token exchange did not return a refresh_token (missing access_type=offline/prompt=consent?)",
    );
  }
  return token;
}

export async function refreshGeminiTokens(
  refreshToken: string,
): Promise<TokenData> {
  let resp: Response;
  try {
    resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: GEMINI_CLIENT_ID,
        client_secret: GEMINI_CLIENT_SECRET,
      }).toString(),
    });
  } catch (err: any) {
    throw netErr("Gemini token refresh network error", err);
  }

  if (!resp.ok) {
    const text = await resp.text();
    const reason = detectExhaustedReason(text);
    if (reason) {
      throw new RefreshTokenExhaustedError(reason, resp.status, text);
    }
    // Google's refresh error shape is {"error":"invalid_grant","error_description":"..."}
    // — detectExhaustedReason only recognises the OpenAI-style {error:{code}}
    // shape, so also treat a bare "invalid_grant" as terminal here.
    try {
      const parsed = JSON.parse(text);
      if (parsed?.error === "invalid_grant") {
        throw new RefreshTokenExhaustedError("invalidated", resp.status, text);
      }
    } catch (e) {
      if (e instanceof RefreshTokenExhaustedError) throw e;
    }
    throw new Error(`Gemini token refresh failed (${resp.status}): ${text}`);
  }

  // Google's refresh grant does not return a new refresh_token — reuse the
  // one that was passed in.
  return tokenFromResponse((await resp.json()) as GoogleTokenResponse, refreshToken);
}

export async function refreshGeminiTokensWithRetry(
  refreshToken: string,
  maxRetries = 3,
): Promise<TokenData> {
  let lastErr: any;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await refreshGeminiTokens(refreshToken);
    } catch (err) {
      if (err instanceof RefreshTokenExhaustedError) throw err;
      lastErr = err;
      if (attempt >= maxRetries) break;
      await timeout(attempt * 1000);
    }
  }
  throw lastErr;
}
