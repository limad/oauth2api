import { PKCECodes, TokenData } from "../auth/types";
import { AccountManager } from "../accounts/manager";
import {
  generateGeminiAuthURL,
  exchangeGeminiCode,
  refreshGeminiTokensWithRetry,
  GEMINI_CALLBACK_PATH,
  GEMINI_CALLBACK_PORT,
} from "../auth/gemini/oauth";
import { resolveGeminiProject, callGeminiMessages } from "../upstream/gemini-api";
import { Provider, UpstreamCallContext, ProviderOAuthInfo } from "./types";

const GEMINI_OAUTH: ProviderOAuthInfo = {
  callbackPort: GEMINI_CALLBACK_PORT,
  callbackPath: GEMINI_CALLBACK_PATH,
};

const MODEL_RE = /^(gemini|gemma)[-/:]/i;

// The Code Assist backend isn't Gemini-only under the Antigravity
// entitlement — it also dispatches to Claude and an open-weight GPT model
// through the exact same `:generateContent` RPC and `contents/parts`
// envelope (verified against Draculabo/AntigravityManager's
// model-specs.ts, where these three sit in the same `models` map as every
// Gemini id, same shape: max_output_tokens/thinking_budget/is_thinking).
// Matched by exact id (not a prefix like MODEL_RE) so a bare "claude-sonnet-4-6"
// still routes to the native `anthropic` OAuth provider — only the
// Antigravity-flavored "-thinking"/full ids opt into this backend.
const ANTIGRAVITY_EXTRA_MODELS = new Set([
  "claude-sonnet-4-6-thinking",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
]);

// Real Code Assist backend ids (per resolveGeminiModel in
// upstream/gemini-translator.ts) plus the friendly "gemini-3.1-pro" alias
// that maps to "-high" — matches what Antigravity's own model picker
// exposes (captured 2026-08-23: "Gemini 3.1 Pro / Low", flash tiers 3.5/3.6/3.7,
// plus the Claude/GPT-OSS entries above).
const ADVERTISED_MODELS = [
  "gemini-3.1-pro",
  "gemini-3.1-pro-low",
  "gemini-3.5-flash-high",
  "gemini-3.5-flash-medium",
  "gemini-3.5-flash-low",
  "gemini-3-flash",
  "claude-sonnet-4-6-thinking",
  "claude-opus-4-6-thinking",
  "gpt-oss-120b-medium",
];

export function buildGeminiProvider(authDir: string): Provider {
  const manager = new AccountManager(authDir, {
    provider: "gemini",
    refresh: async (rt: string): Promise<TokenData> => {
      const token = await refreshGeminiTokensWithRetry(rt);
      return { ...token, provider: "gemini" };
    },
  });

  return {
    id: "gemini",
    // Callers only ever see Anthropic Messages in/out — callMessages below
    // hides the Code Assist wire format entirely (request translation,
    // response translation, and SSE re-encoding all happen inside
    // upstream/gemini-api.ts). This lets the generic /v1/chat/completions,
    // /v1/responses and /v1/messages handlers route to gemini exactly like
    // they do for anthropic, with no gemini-specific branch needed there.
    nativeFormat: "anthropic-messages",
    manager,
    oauth: GEMINI_OAUTH,
    matchesModel: (model: string) =>
      MODEL_RE.test(model) || ANTIGRAVITY_EXTRA_MODELS.has(model),
    buildAuthUrl: (state: string, pkce: PKCECodes) =>
      generateGeminiAuthURL(state, pkce),
    exchangeCode: async (code, returnedState, expectedState, pkce) => {
      const token = await exchangeGeminiCode(
        code,
        returnedState,
        expectedState,
        pkce,
      );
      // Resolve the Code Assist project/tier once at login time so every
      // request afterwards is a plain authenticated call (see
      // resolveGeminiProject's doc comment for what this replicates from
      // gemini-cli). Login is inherently a one-off, human-driven flow, so
      // the extra round-trip here is not a hot-path cost.
      const { projectId, userTier, apiBase } = await resolveGeminiProject(
        token.accessToken,
      );
      return {
        ...token,
        provider: "gemini",
        geminiProjectId: projectId,
        geminiUserTier: userTier,
        geminiApiBase: apiBase,
      };
    },
    listModels: async () =>
      ADVERTISED_MODELS.map((id) => ({
        id,
        owned_by: ANTIGRAVITY_EXTRA_MODELS.has(id) ? "antigravity" : "google",
      })),
    callMessages: (opts: UpstreamCallContext) =>
      callGeminiMessages({
        body: opts.body,
        request: opts.request,
        account: opts.account,
        config: opts.config,
        signal: opts.signal,
      }),
    // No callCountTokens — Code Assist's countTokens uses a distinct request
    // envelope (see converter.ts CaCountTokenRequest); not wired up yet.
    // No applyCloaking — no special headers needed.
  };
}
