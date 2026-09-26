import { ProviderId } from "../auth/types";
import { resolveModel } from "../upstream/translator";
import { buildAnthropicProvider } from "./anthropic";
import { buildCodexProvider } from "./codex";
import { buildCursorProvider } from "./cursor";
import { buildCopilotProvider } from "./copilot";
import { buildGeminiProvider } from "./gemini";
import { Provider } from "./types";

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
  const byId: Record<ProviderId, Provider> = {
    anthropic,
    codex,
    cursor,
    copilot,
    gemini,
  };
  const ordered: Provider[] = [anthropic, codex, cursor, copilot, gemini];

  return {
    get: (id) => {
      const p = byId[id];
      if (!p) throw new Error(`Unknown provider: ${id}`);
      return p;
    },
    forModel: (model) => {
      const resolved = resolveModel(model);
      // Explicit `cursor-` / `cr/` prefix always wins so users can force the
      // Cursor backend when they have multiple providers logged in.
      if (cursor.matchesModel(resolved)) return cursor;
      if (copilot.matchesModel(resolved)) return copilot;
      if (gemini.matchesModel(resolved)) return gemini;

      // "Cursor exclusive" mode: when only Cursor has accounts, route every
      // unknown / Anthropic-style / OpenAI-style model through Cursor. This
      // lets clients with hard-coded names (`claude-sonnet-4-5`, `gpt-5.5`,
      // `opus`) work against auth2api without a `cursor-` prefix.
      const cursorOnly =
        cursor.manager.accountCount > 0 &&
        anthropic.manager.accountCount === 0 &&
        codex.manager.accountCount === 0 &&
        copilot.manager.accountCount === 0 &&
        gemini.manager.accountCount === 0;
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
