import { PKCECodes, TokenData } from "../auth/types";
import { AccountManager } from "../accounts/manager";
import {
  generateGeminiAuthURL,
  exchangeGeminiCode,
  refreshGeminiTokensWithRetry,
  GEMINI_CALLBACK_PATH,
  GEMINI_CALLBACK_PORT,
} from "../auth/gemini/oauth";
import { GeminiCatalog } from "../upstream/gemini-models";
import { resolveGeminiProject, callGeminiMessages } from "../upstream/gemini-api";
import { Provider, UpstreamCallContext, ProviderOAuthInfo } from "./types";

const GEMINI_OAUTH: ProviderOAuthInfo = {
  callbackPort: GEMINI_CALLBACK_PORT,
  callbackPath: GEMINI_CALLBACK_PATH,
};

const MODEL_RE = /^(gemini|gemma)[-/:]/i;

// The Code Assist backend isn't Gemini-only under the Antigravity entitlement —
// it also dispatches Claude and an open-weight GPT model through the same RPC.
// Which ids exist depends on the account, so they come from the live catalogue
// (upstream/gemini-models.ts), not from a hardcoded list. Bare Anthropic ids
// ("claude-sonnet-4-6") keep routing to the native `anthropic` OAuth provider;
// only Antigravity-flavoured ids ("-low/-medium/-high", "-thinking", gpt-oss) opt in.
const BARE_ANTHROPIC_ID = /^claude-[a-z]+-\d+(-\d+)*$/;

export function buildGeminiProvider(authDir: string): Provider {
  const manager = new AccountManager(authDir, {
    provider: "gemini",
    refresh: async (rt: string): Promise<TokenData> => {
      const token = await refreshGeminiTokensWithRetry(rt);
      return { ...token, provider: "gemini" };
    },
  });
  const catalog = new GeminiCatalog(manager, authDir);
  // Accounts are loaded right after construction; first live fetch shortly after.
  setTimeout(() => catalog.start(), 3000).unref();

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
      MODEL_RE.test(model) ||
      (catalog.has(model) && !BARE_ANTHROPIC_ID.test(model)),
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
    listModels: () => catalog.list(),
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
