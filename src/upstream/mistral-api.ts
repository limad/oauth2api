import { Request } from "express";
import { Config } from "../config";
import { AccountManager, AvailableAccount } from "../accounts/manager";
import { withTimeoutSignal } from "../utils/abort";
import { ModelInfo } from "../providers/types";
import {
  MISTRAL_API_BASE,
  MISTRAL_VIBE_USER_AGENT,
} from "../auth/mistral/vibe-login";

/**
 * Mistral La Plateforme, called with the long-lived key obtained by the Vibe
 * sign-in. The API speaks OpenAI Chat Completions, so requests are passed
 * through; only what Mistral rejects (422 "extra_forbidden", checked live on
 * 2026-11-07) is renamed or dropped. Nothing is ever added: the proxy stays
 * token-neutral.
 */

const CHAT_COMPLETIONS_URL = `${MISTRAL_API_BASE}/v1/chat/completions`;
const MODELS_URL = `${MISTRAL_API_BASE}/v1/models`;
const MODELS_TTL_MS = 10 * 60 * 1000;

/** Optional explicit routing prefix (`mistral/<id>`), stripped before the call. */
export const MISTRAL_PREFIX = "mistral/";

// Shown while no live catalogue is available (no account, upstream down).
const FALLBACK_MODELS = [
  "mistral-medium-latest",
  "mistral-small-latest",
  "magistral-medium-latest",
  "codestral-latest",
  "mistral-vibe-cli-latest",
];

/** OpenAI fields Mistral rejects and that have no Mistral equivalent. */
const DROPPED_BODY_FIELDS = [
  "user",
  "store",
  "safety_identifier",
  "verbosity",
  "web_search_options",
  "logit_bias",
  "thinking",
];

/** Message fields Mistral rejects (assistant echoes from OpenAI SDKs, `name`). */
const DROPPED_MESSAGE_FIELDS = [
  "refusal",
  "annotations",
  "audio",
  "reasoning_content",
];

export interface CallMistralOptions {
  body?: any;
  request: Request;
  account: AvailableAccount;
  config: Config;
  signal?: AbortSignal;
}

export function stripMistralPrefix(model: string): string {
  const m = String(model || "").trim();
  return m.toLowerCase().startsWith(MISTRAL_PREFIX)
    ? m.slice(MISTRAL_PREFIX.length)
    : m;
}

function normalizeMessage(msg: any): any {
  if (!msg || typeof msg !== "object") return msg;
  const out = { ...msg };
  if (out.role === "developer") out.role = "system";
  // Mistral only accepts `name` on tool messages.
  if (out.role !== "tool") delete out.name;
  if (out.role === "assistant") {
    for (const f of DROPPED_MESSAGE_FIELDS) delete out[f];
    // Legacy single function call -> tool_calls (dropped when null/empty).
    const fc = out.function_call;
    delete out.function_call;
    if (fc && typeof fc === "object" && fc.name && !out.tool_calls) {
      out.tool_calls = [
        {
          id: "call_legacy",
          type: "function",
          function: { name: fc.name, arguments: fc.arguments ?? "{}" },
        },
      ];
    }
  }
  return out;
}

/** OpenAI Chat Completions body -> body accepted by Mistral. Pure, no additions. */
export function normalizeMistralChatBody(body: any): any {
  if (!body || typeof body !== "object") return body;
  const next: any = { ...body };
  if (next.model) next.model = stripMistralPrefix(next.model);
  for (const f of DROPPED_BODY_FIELDS) delete next[f];
  if (next.max_completion_tokens !== undefined) {
    if (next.max_tokens === undefined)
      next.max_tokens = next.max_completion_tokens;
    delete next.max_completion_tokens;
  }
  if (next.seed !== undefined) {
    if (next.random_seed === undefined) next.random_seed = next.seed;
    delete next.seed;
  }
  // Legacy `functions` / `function_call` -> `tools` / `tool_choice`.
  if (Array.isArray(next.functions)) {
    if (!next.tools && next.functions.length) {
      next.tools = next.functions.map((f: any) => ({
        type: "function",
        function: f,
      }));
    }
  }
  delete next.functions;
  if (next.function_call !== undefined) {
    const fc = next.function_call;
    if (next.tool_choice === undefined) {
      if (fc === "auto" || fc === "none") next.tool_choice = fc;
      else if (fc && typeof fc === "object" && fc.name) {
        next.tool_choice = { type: "function", function: { name: fc.name } };
      }
    }
    delete next.function_call;
  }
  if (Array.isArray(next.messages))
    next.messages = next.messages.map(normalizeMessage);
  return next;
}

function buildHeaders(
  account: AvailableAccount,
  stream: boolean,
): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    Authorization: `Bearer ${account.token.accessToken}`,
    "User-Agent": MISTRAL_VIBE_USER_AGENT,
  };
}

export async function callMistralChatCompletions(
  options: CallMistralOptions,
): Promise<Response> {
  const { request, account, config } = options;
  const body = normalizeMistralChatBody(options.body ?? request.body);
  const stream = !!body?.stream;
  const timeoutMs = stream
    ? config.timeouts["stream-messages-ms"]
    : config.timeouts["messages-ms"];
  try {
    return await fetch(CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: buildHeaders(account, stream),
      body: JSON.stringify(body),
      signal: withTimeoutSignal(timeoutMs, options.signal),
    });
  } catch (err: any) {
    const cause = err?.cause;
    const detail = cause
      ? `${cause.code || cause.name || "error"}: ${cause.message || String(cause)}`
      : err?.message || String(err);
    throw new Error(`mistral upstream fetch failed: ${detail}`);
  }
}

interface MistralModel {
  id?: string;
  name?: string;
  max_context_length?: number;
  deprecation?: string | null;
  capabilities?: Record<string, unknown>;
}

/** Chat-capable, non-deprecated entries of GET /v1/models, sorted by id. */
export function mistralModelsFromResponse(
  data: any,
  now = Date.now(),
): ModelInfo[] {
  const list: MistralModel[] = Array.isArray(data?.data) ? data.data : [];
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const m of list) {
    const id = typeof m?.id === "string" ? m.id : "";
    if (!id || seen.has(id)) continue;
    if (m.capabilities && m.capabilities.completion_chat !== true) continue;
    if (m.deprecation && Date.parse(m.deprecation) <= now) continue;
    seen.add(id);
    const info: ModelInfo = { id, owned_by: "mistral" };
    if (typeof m.max_context_length === "number")
      info.context_length = m.max_context_length;
    if (m.capabilities) {
      info.capabilities = {
        tools: m.capabilities.function_calling === true,
        vision: m.capabilities.vision === true,
        reasoning: m.capabilities.reasoning === true,
      };
    }
    out.push(info);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Live catalogue of the key (the Vibe key opens more models than a plain API
 * key), cached 10 min. Fetched on demand only (/v1/models), never at startup.
 */
export class MistralCatalog {
  private cache: { at: number; models: ModelInfo[] } | null = null;
  private inflight: Promise<ModelInfo[]> | null = null;

  constructor(private readonly manager: AccountManager) {}

  async list(): Promise<ModelInfo[]> {
    if (this.cache && Date.now() - this.cache.at < MODELS_TTL_MS)
      return this.cache.models;
    if (!this.inflight) {
      this.inflight = this.fetchModels().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async fetchModels(): Promise<ModelInfo[]> {
    const fallback = FALLBACK_MODELS.map((id) => ({ id, owned_by: "mistral" }));
    const result = this.manager.getNextAccount();
    if (!result.account) return fallback;
    try {
      const resp = await fetch(MODELS_URL, {
        headers: {
          Authorization: `Bearer ${result.account.token.accessToken}`,
          Accept: "application/json",
          "User-Agent": MISTRAL_VIBE_USER_AGENT,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const models = mistralModelsFromResponse(await resp.json());
      if (models.length) {
        this.cache = { at: Date.now(), models };
        return models;
      }
    } catch (err: any) {
      console.error(
        `[mistral] /v1/models failed: ${err?.message || String(err)}`,
      );
    }
    return this.cache?.models ?? fallback;
  }
}
