import { PKCECodes, TokenData } from "../auth/types";
import { AccountManager } from "../accounts/manager";
import {
  generateCodexAuthURL,
  exchangeCodexCode,
  refreshCodexTokensWithRetry,
  CODEX_CALLBACK_PATH,
  CODEX_CALLBACK_PORT,
} from "../auth/codex/oauth";
import { callCodexResponses } from "../upstream/codex-api";
import { listCodexModels } from "../upstream/codex-models";
import { Provider, UpstreamCallContext, ProviderOAuthInfo } from "./types";

const CODEX_OAUTH: ProviderOAuthInfo = {
  callbackPort: CODEX_CALLBACK_PORT,
  callbackPath: CODEX_CALLBACK_PATH,
};

// gpt-5*, o\d* (o3, o4-mini), codex-* — but NOT legacy gpt-3/gpt-4* which the
// codex backend doesn't serve.
const MODEL_RE = /^(gpt-5(\.|-)|gpt-5$|o\d|codex-)/i;

export function buildCodexProvider(authDir: string): Provider {
  const manager = new AccountManager(authDir, {
    provider: "codex",
    refresh: async (rt: string): Promise<TokenData> => {
      const token = await refreshCodexTokensWithRetry(rt);
      return { ...token, provider: "codex" };
    },
    // Mirrors codex-rs/login/src/auth/manager.rs TOKEN_REFRESH_INTERVAL = 8 days.
    refreshPolicy: { kind: "since-last-refresh", maxAgeMs: 8 * 86_400_000 },
  });

  return {
    id: "codex",
    nativeFormat: "openai-responses",
    manager,
    oauth: CODEX_OAUTH,
    matchesModel: (model: string) => MODEL_RE.test(model),
    buildAuthUrl: (state: string, pkce: PKCECodes) =>
      generateCodexAuthURL(state, pkce),
    exchangeCode: async (code, returnedState, expectedState, pkce) => {
      const token = await exchangeCodexCode(
        code,
        returnedState,
        expectedState,
        pkce,
      );
      return { ...token, provider: "codex" };
    },
    listModels: () => listCodexModels(manager),
    callMessages: (opts: UpstreamCallContext) =>
      callCodexResponses({
        body: opts.body,
        request: opts.request,
        account: opts.account,
        config: opts.config,
        signal: opts.signal,
      }),
    // No callCountTokens — codex backend has no equivalent endpoint.
    // No applyCloaking — protocol headers live in codex-api.ts; identity
    // injection is intentionally NOT done here.
  };
}
