import fs from "node:fs";
import path from "node:path";
import { AccountManager } from "../accounts/manager";
import { authHeaders, V1_INTERNAL_BASES, methodUrl } from "./gemini-api";

// `fetchAvailableModels` is what Antigravity itself calls at startup (captured
// 2026-10-05 with mitmproxy): body `{"project": <cloudaicompanionProject>}`, answer
// `{models: {<id>: {displayName, apiProvider, quotaInfo, ...}}, deprecatedModelIds, ...}`.
// The catalogue depends on the account (plan / entitlement), so it is cached per account.
const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_PROJECT = "aicode-consumers";

function ownedBy(apiProvider: string | undefined): string {
  return apiProvider === "API_PROVIDER_GOOGLE_GEMINI" ? "google" : "antigravity";
}

/** Keeps user-selectable chat models; drops internal/tab/completion backends. */
export function parseAvailableModels(
  data: any,
): Array<{ id: string; owned_by: string }> {
  const out: Array<{ id: string; owned_by: string }> = [];
  const models = data?.models;
  if (!models || typeof models !== "object") return out;
  for (const [id, m] of Object.entries<any>(models)) {
    if (!m?.displayName || m.apiProvider === "API_PROVIDER_INTERNAL") continue;
    if (/^(tab_|chat_)/.test(id) || /-tiered$/.test(id)) continue;
    if (/image/.test(id)) continue; // image generation: not a chat model
    out.push({ id, owned_by: ownedBy(m.apiProvider) });
  }
  return out;
}

async function fetchForAccount(
  token: { accessToken: string; geminiProjectId?: string; geminiApiBase?: string },
): Promise<Array<{ id: string; owned_by: string }> | null> {
  const base = token.geminiApiBase || V1_INTERNAL_BASES[0];
  try {
    const resp = await fetch(methodUrl(base, "fetchAvailableModels"), {
      method: "POST",
      headers: authHeaders(token.accessToken),
      body: JSON.stringify({ project: token.geminiProjectId || DEFAULT_PROJECT }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) {
      console.error(`[gemini] fetchAvailableModels returned ${resp.status}`);
      return null;
    }
    const list = parseAvailableModels(await resp.json());
    return list.length ? list : null;
  } catch (err: any) {
    console.error(`[gemini] fetchAvailableModels failed: ${err?.message || err}`);
    return null;
  }
}

const REFRESH_MS = 60 * 60 * 1000;

/**
 * Live Gemini/Antigravity catalogue. No hardcoded list: it is fetched from
 * `fetchAvailableModels`, refreshed hourly, and persisted to
 * `<auth-dir>/gemini-models.json` so it survives restarts and upstream outages.
 * Empty until the first successful fetch when there is no persisted copy.
 */
export class GeminiCatalog {
  private models: Array<{ id: string; owned_by: string }> = [];
  private fetchedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private readonly file: string;

  constructor(
    private readonly manager: AccountManager,
    authDir: string,
  ) {
    this.file = path.join(authDir, "gemini-models.json");
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (Array.isArray(saved?.models)) this.set(saved.models, saved.fetchedAt || 0);
    } catch {
      /* no persisted catalogue yet */
    }
  }

  private set(models: Array<{ id: string; owned_by: string }>, at: number): void {
    this.models = models;
    this.fetchedAt = at;
  }

  /** Starts the hourly refresh (and an immediate one). Safe to call twice. */
  start(): void {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref();
  }

  async refresh(): Promise<void> {
    const result = this.manager.getNextAccount();
    if (!result.account) return;
    const fresh = await fetchForAccount(result.account.token);
    if (!fresh) return;
    this.set(fresh, Date.now());
    try {
      fs.writeFileSync(
        this.file,
        JSON.stringify({ fetchedAt: this.fetchedAt, models: fresh }),
        { mode: 0o600 },
      );
    } catch (err: any) {
      console.error(`[gemini] cannot persist model catalogue: ${err?.message || err}`);
    }
  }

  async list(): Promise<Array<{ id: string; owned_by: string }>> {
    if (Date.now() - this.fetchedAt > CACHE_TTL_MS) await this.refresh();
    return this.models;
  }
}
