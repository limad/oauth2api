import { PKCECodes, TokenData } from "../auth/types";
import { loadAllTokens } from "../auth/token-storage";
import { AccountManager } from "../accounts/manager";
import { callCopilotChatCompletions, listCopilotModels } from "../upstream/copilot-api";
import { Provider, UpstreamCallContext, ProviderOAuthInfo } from "./types";

const COPILOT_OAUTH: ProviderOAuthInfo = {
  callbackPort: 0,
  callbackPath: "/github/device",
};

const MODEL_RE = /^(copilot[-/:]|ghcp\/)/i;

export function stripCopilotPrefix(model: string): string {
  return model.replace(/^(copilot[:/-]|ghcp\/)/i, "").trim();
}

export function buildCopilotProvider(authDir: string): Provider {
  const manager = new AccountManager(authDir, {
    provider: "copilot",
    refresh: async (rt: string): Promise<TokenData> => {
      const previous =
        loadAllTokens(authDir, "copilot").find((t) => t.refreshToken === rt) ||
        loadAllTokens(authDir, "copilot")[0];
      if (!previous) throw new Error("Copilot token refresh is not available");
      return { ...previous, provider: "copilot" };
    },
    refreshPolicy: { kind: "since-last-refresh", maxAgeMs: 3650 * 86_400_000 },
  });

  return {
    id: "copilot",
    nativeFormat: "openai-responses",
    manager,
    oauth: COPILOT_OAUTH,
    matchesModel: (model: string) => MODEL_RE.test(model),
    buildAuthUrl: (_state: string, _pkce: PKCECodes) => {
      throw new Error("Copilot provider uses GitHub device flow from Jeedom panel");
    },
    exchangeCode: async () => {
      throw new Error("Copilot provider does not implement browser callback OAuth");
    },
    listModels: () => listCopilotModels(manager),
    callMessages: (opts: UpstreamCallContext) =>
      callCopilotChatCompletions({
        body: opts.body,
        request: opts.request,
        account: opts.account,
        config: opts.config,
        signal: opts.signal,
      }),
  };
}
