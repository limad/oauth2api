import { PKCECodes, TokenData } from "../auth/types";
import { AccountManager } from "../accounts/manager";
import { RefreshTokenExhaustedError } from "../auth/refresh-errors";
import {
  callMistralChatCompletions,
  MistralCatalog,
  MISTRAL_PREFIX,
} from "../upstream/mistral-api";
import { Provider, UpstreamCallContext, ProviderOAuthInfo } from "./types";

const MISTRAL_OAUTH: ProviderOAuthInfo = {
  callbackPort: 0,
  callbackPath: "/vibe/sign-in",
};

// Mistral's own model families: none of them clashes with another provider, so
// they are routed bare; `mistral/<id>` forces this provider for any other id.
const MODEL_RE =
  /^(mistral|codestral|magistral|ministral|devstral|pixtral|voxtral)-/i;

/** Id advertised on /v1/models: bare for Mistral families, `mistral/<id>` otherwise. */
export function mistralListedId(id: string): string {
  return MODEL_RE.test(id) ? id : `${MISTRAL_PREFIX}${id}`;
}

export function buildMistralProvider(authDir: string): Provider {
  const manager = new AccountManager(authDir, {
    provider: "mistral",
    // A Vibe key has no refresh token. Throwing the terminal error turns an
    // upstream 401 into a long cooldown + "log in again" message instead of
    // resending the whole prompt with the same key.
    refresh: async (_rt: string): Promise<TokenData> => {
      throw new RefreshTokenExhaustedError(
        "invalidated",
        401,
        "Mistral Vibe key rejected or revoked",
      );
    },
    refreshPolicy: { kind: "since-last-refresh", maxAgeMs: 3650 * 86_400_000 },
  });
  const catalog = new MistralCatalog(manager);

  return {
    id: "mistral",
    nativeFormat: "openai-chat",
    manager,
    oauth: MISTRAL_OAUTH,
    matchesModel: (model: string) =>
      MODEL_RE.test(model) || model.toLowerCase().startsWith(MISTRAL_PREFIX),
    buildAuthUrl: (_state: string, _pkce: PKCECodes) => {
      throw new Error(
        "Mistral uses the Vibe sign-in: run --login --provider=mistral",
      );
    },
    exchangeCode: async () => {
      throw new Error("Mistral does not implement browser callback OAuth");
    },
    // Ids outside the families above (`labs-leanstral-*`, partner models such as
    // `zai-glm-*`) are listed under `mistral/` so they route back here.
    listModels: async () =>
      (await catalog.list()).map((m) => ({ ...m, id: mistralListedId(m.id) })),
    callMessages: (opts: UpstreamCallContext) =>
      callMistralChatCompletions({
        body: opts.body,
        request: opts.request,
        account: opts.account,
        config: opts.config,
        signal: opts.signal,
      }),
  };
}
