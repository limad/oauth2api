import { ProviderId } from "../auth/types";
import { ANTHROPIC_PREFIX, resolveModel } from "../upstream/translator";
import { buildAnthropicProvider } from "./anthropic";
import { buildCodexProvider } from "./codex";
import { buildCursorProvider } from "./cursor";
import { buildCopilotProvider } from "./copilot";
import { buildGeminiProvider } from "./gemini";
import { buildMistralProvider } from "./mistral";
import { Provider } from "./types";
import type { Config } from "../config";

export interface ProviderRegistry {
  get(id: ProviderId): Provider;
  /** Provider that should serve `model`. Falls back to anthropic. */
  forModel(model: string): Provider;
  all(): Provider[];
  /** Providers that have at least one logged-in account. */
  withAccounts(): Provider[];
}

export function buildRegistry(authDir: string): ProviderRegistry {
  const anthropic = buildAnthropicProvider(authDir);
  const codex = buildCodexProvider(authDir);
  const cursor = buildCursorProvider(authDir);
  const copilot = buildCopilotProvider(authDir);
  const gemini = buildGeminiProvider(authDir);
  const mistral = buildMistralProvider(authDir);
  const byId: Record<ProviderId, Provider> = {
    anthropic,
    codex,
    cursor,
    copilot,
    gemini,
    mistral,
  };
  const ordered: Provider[] = [anthropic, codex, cursor, copilot, gemini, mistral];

  return {
    get: (id) => {
      const p = byId[id];
      if (!p) throw new Error(`Unknown provider: ${id}`);
      return p;
    },
    forModel: (model) => {
      // `at/<id>` forces the native Anthropic backend (prefix stripped by resolveModel).
      if (model.startsWith(ANTHROPIC_PREFIX)) return anthropic;
      const resolved = resolveModel(model);
      // Explicit `cursor-` / `cr/` prefix always wins so users can force the
      // Cursor backend when they have multiple providers logged in.
      if (cursor.matchesModel(resolved)) return cursor;
      if (copilot.matchesModel(resolved)) return copilot;
      if (gemini.matchesModel(resolved)) return gemini;
      if (mistral.matchesModel(resolved)) return mistral;

      // "Cursor exclusive" mode: when only Cursor has accounts, route every
      // unknown / Anthropic-style / OpenAI-style model through Cursor. This
      // lets clients with hard-coded names (`claude-sonnet-4-5`, `gpt-5.5`,
      // `opus`) work against auth2api without a `cursor-` prefix.
      const cursorOnly =
        cursor.manager.accountCount > 0 &&
        anthropic.manager.accountCount === 0 &&
        codex.manager.accountCount === 0 &&
        copilot.manager.accountCount === 0 &&
        gemini.manager.accountCount === 0 &&
        mistral.manager.accountCount === 0;
      if (cursorOnly) return cursor;

      // Multi-provider setups: fall back to the explicit family routes.
      if (codex.matchesModel(resolved)) return codex;
      if (anthropic.matchesModel(resolved)) return anthropic;
      // Unknown model + multi-provider: keep historical behaviour and
      // dispatch to anthropic so the client gets a clear "no account" error
      // for the right provider.
      return anthropic;
    },
    all: () => ordered.slice(),
    withAccounts: () => ordered.filter((p) => p.manager.accountCount > 0),
  };
}

/**
 * The provider as the Anthropic-format handlers (/v1/messages, /v1/responses)
 * should see it: a Chat-Completions-only provider with an Anthropic adapter
 * becomes Anthropic-native there (no cloaking, local count_tokens estimate).
 * Any other provider is returned as is.
 */
export function anthropicView(provider: Provider): Provider {
  if (provider.nativeFormat !== "openai-chat" || !provider.callAnthropicMessages) return provider;
  return {
    ...provider,
    nativeFormat: "anthropic-messages",
    callMessages: provider.callAnthropicMessages,
    callCountTokens: undefined,
    applyCloaking: undefined,
  };
}

/** Applies `account-strategy` (and its per-provider overrides) to every provider's account manager. */
export function applyAccountStrategies(
  registry: ProviderRegistry,
  config: Pick<Config, "account-strategy" | "account-strategy-by-provider">,
): void {
  for (const p of registry.all()) {
    const strategy = config["account-strategy-by-provider"][p.id] ?? config["account-strategy"];
    p.manager.setStrategy(strategy);
    if (strategy !== "sticky") console.log(`[${p.id}] account strategy: ${strategy}`);
  }
}
