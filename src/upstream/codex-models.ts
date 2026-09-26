import { AccountManager } from "../accounts/manager";

const BASE_URL = "https://chatgpt.com/backend-api";
const MODELS_PATH = "/codex/models";
const CACHE_TTL_MS = 5 * 60 * 1000; // matches codex-rs/models-manager DEFAULT_MODEL_CACHE_TTL
const CLIENT_VERSION = "auth2api/1.0.0";

// Static fallback used when no account is loaded or the upstream /codex/models
// call fails. User-confirmed list of models currently accepted by the
// ChatGPT-account codex backend; kept private since the upstream proxy is the
// authoritative source — this list only papers over startup and outages.
const FALLBACK_MODELS = [
  "gpt-5.5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2",
];

interface UpstreamModel {
  slug: string;
  display_name?: string;
  visibility?: string;
}

interface ModelsResponse {
  models: UpstreamModel[];
}

interface CacheEntry {
  fetchedAt: number;
  etag: string | null;
  models: UpstreamModel[];
}

let cache: CacheEntry | null = null;

async function fetchUpstream(
  manager: AccountManager,
): Promise<{ models: UpstreamModel[]; etag: string | null } | null> {
  const result = manager.getNextAccount();
  if (!result.account) return null;
  const account = result.account;

  const url = `${BASE_URL}${MODELS_PATH}?client_version=${encodeURIComponent(CLIENT_VERSION)}`;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${account.token.accessToken}`,
    Accept: "application/json",
    "User-Agent": `auth2api/1.0.0`,
  };
  if (account.chatgptAccountId) {
    headers["ChatGPT-Account-ID"] = account.chatgptAccountId;
  }
  if (cache?.etag) {
    headers["If-None-Match"] = cache.etag;
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: any) {
    const cause = err?.cause;
    const detail = cause
      ? `${cause.code || cause.name || "error"}: ${cause.message || String(cause)}`
      : err?.message || String(err);
    console.error(`[codex] /codex/models fetch failed: ${detail}`);
    return null;
  }

  // 304 Not Modified — cache is still valid.
  if (resp.status === 304 && cache) {
    return { models: cache.models, etag: cache.etag };
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error(
      `[codex] /codex/models returned ${resp.status}: ${text.slice(0, 200)}`,
    );
    return null;
  }

  let parsed: ModelsResponse;
  try {
    parsed = (await resp.json()) as ModelsResponse;
  } catch (err: any) {
    console.error(`[codex] /codex/models JSON parse failed: ${err.message}`);
    return null;
  }
  if (!Array.isArray(parsed.models)) {
    console.error("[codex] /codex/models response missing 'models' array");
    return null;
  }
  const etag = resp.headers.get("etag");
  return { models: parsed.models, etag };
}

export async function listCodexModels(
  manager: AccountManager,
): Promise<Array<{ id: string; owned_by: string }>> {
  // Cache hit within TTL — return immediately.
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.models.map((m) => ({ id: m.slug, owned_by: "openai" }));
  }

  const fresh = await fetchUpstream(manager);
  if (fresh) {
    cache = {
      fetchedAt: Date.now(),
      etag: fresh.etag,
      models: fresh.models,
    };
    return fresh.models.map((m) => ({ id: m.slug, owned_by: "openai" }));
  }

  // Stale-while-error: prefer slightly-stale cache over fallback if we have one.
  if (cache) {
    return cache.models.map((m) => ({ id: m.slug, owned_by: "openai" }));
  }

  return FALLBACK_MODELS.map((id) => ({ id, owned_by: "openai" }));
}

/** @internal — test hook to reset the module-level cache between cases. */
export function __resetCodexModelsCache(): void {
  cache = null;
}
