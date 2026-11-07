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

// Vibe sends its session id as `x-affinity` so a conversation stays on the
// same Mistral backend (prompt cache hits). Forwarded only when the client
// sends one; nothing is generated here.
const AFFINITY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function clientAffinity(request?: Pick<Request, "header">): string | undefined {
  const v = request?.header?.("x-affinity");
  return typeof v === "string" && AFFINITY_RE.test(v.trim()) ? v.trim() : undefined;
}

function buildHeaders(
  account: AvailableAccount,
  stream: boolean,
  affinity?: string,
  contentType: string = "application/json",
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    Accept: stream ? "text/event-stream" : "application/json",
    Authorization: `Bearer ${account.token.accessToken}`,
    "User-Agent": MISTRAL_VIBE_USER_AGENT,
  };
  if (affinity) headers["x-affinity"] = affinity;
  return headers;
}

/**
 * Mistral reasoning models (mistral-large-4, magistral with thinking) answer
 * `content` as chunks: [{type:"thinking", thinking:[{type:"text",text}]},
 * {type:"text", text}] — non-stream and in stream deltas (seen live on
 * 2026-11-07). OpenAI clients expect a string: the text goes to `content`, the
 * thinking to `reasoning_content` (DeepSeek convention, already used by our
 * Codex/Cursor chat output). Strings are left untouched.
 */
export function splitMistralContent(
  content: unknown,
): { text: string; reasoning: string } | null {
  if (!Array.isArray(content)) return null;
  let text = "";
  let reasoning = "";
  const textOf = (v: unknown): string =>
    typeof v === "string"
      ? v
      : Array.isArray(v)
        ? v
            .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
            .join("")
        : "";
  for (const part of content as any[]) {
    if (part?.type === "thinking") reasoning += textOf(part.thinking);
    else if (part?.type === "text" && typeof part.text === "string")
      text += part.text;
  }
  return { text, reasoning };
}

function normalizeChoiceContent(target: any, isDelta: boolean): boolean {
  if (!target || typeof target !== "object") return false;
  const split = splitMistralContent(target.content);
  if (!split) return false;
  if (split.text || !isDelta) target.content = split.text;
  else delete target.content;
  if (split.reasoning) {
    target.reasoning_content =
      (target.reasoning_content || "") + split.reasoning;
  }
  return true;
}

/** Non-stream body: rewrites choices[].message; returns true when something changed. */
export function normalizeMistralChatResponse(json: any): boolean {
  let changed = false;
  for (const c of Array.isArray(json?.choices) ? json.choices : []) {
    if (normalizeChoiceContent(c?.message, false)) changed = true;
  }
  return changed;
}

/** Stream chunk: rewrites choices[].delta; returns true when something changed. */
export function normalizeMistralChunk(json: any): boolean {
  let changed = false;
  for (const c of Array.isArray(json?.choices) ? json.choices : []) {
    if (normalizeChoiceContent(c?.delta, true)) changed = true;
  }
  return changed;
}

/** SSE byte stream -> same stream; only `data:` lines whose content is an array are re-encoded. */
export function mistralSseTransform(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const fix = (line: string): string => {
    if (!line.startsWith("data:") || !line.includes('"content":[')) return line;
    try {
      const json = JSON.parse(line.slice(5).trim());
      return normalizeMistralChunk(json)
        ? `data: ${JSON.stringify(json)}`
        : line;
    } catch {
      return line;
    }
  };
  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (lines.length)
        controller.enqueue(encoder.encode(lines.map(fix).join("\n") + "\n"));
    },
    flush(controller) {
      buffer += decoder.decode();
      if (buffer) controller.enqueue(encoder.encode(fix(buffer)));
    },
  });
}

function rebuilt(resp: Response, body: BodyInit): Response {
  const headers = new Headers(resp.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return new Response(body, {
    status: resp.status,
    statusText: resp.statusText,
    headers,
  });
}

async function normalizeMistralResponse(
  resp: Response,
  stream: boolean,
): Promise<Response> {
  if (!resp.ok || !resp.body) return resp;
  if (stream)
    return rebuilt(resp, resp.body.pipeThrough(mistralSseTransform()));
  const text = await resp.text();
  try {
    const json = JSON.parse(text);
    if (normalizeMistralChatResponse(json))
      return rebuilt(resp, JSON.stringify(json));
  } catch {
    /* not JSON: hand it back as is */
  }
  return rebuilt(resp, text);
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
    const resp = await fetch(CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: buildHeaders(account, stream, clientAffinity(request)),
      body: JSON.stringify(body),
      signal: withTimeoutSignal(timeoutMs, options.signal),
    });
    return await normalizeMistralResponse(resp, stream);
  } catch (err: any) {
    const cause = err?.cause;
    const detail = cause
      ? `${cause.code || cause.name || "error"}: ${cause.message || String(cause)}`
      : err?.message || String(err);
    throw new Error(`mistral upstream fetch failed: ${detail}`);
  }
}

/** Mistral-only routes relayed as is (no OpenAI equivalent upstream elsewhere). */
export const MISTRAL_EXTRA_PATHS = {
  fim: "/v1/fim/completions",
  embeddings: "/v1/embeddings",
  ocr: "/v1/ocr",
  transcriptions: "/v1/audio/transcriptions",
} as const;
export type MistralExtraKind = keyof typeof MISTRAL_EXTRA_PATHS;

export interface CallMistralExtraOptions {
  kind: MistralExtraKind;
  /** JSON object, or the raw multipart body (audio). */
  body: any;
  contentType?: string;
  stream: boolean;
  account: AvailableAccount;
  config: Config;
  affinity?: string;
  signal?: AbortSignal;
}

/** Pass-through POST to one of MISTRAL_EXTRA_PATHS: the body is sent untouched. */
export async function callMistralExtra(
  options: CallMistralExtraOptions,
): Promise<Response> {
  const { kind, body, account, config, stream } = options;
  const raw = Buffer.isBuffer(body);
  const timeoutMs = stream
    ? config.timeouts["stream-messages-ms"]
    : config.timeouts["messages-ms"];
  try {
    const resp = await fetch(`${MISTRAL_API_BASE}${MISTRAL_EXTRA_PATHS[kind]}`, {
      method: "POST",
      headers: buildHeaders(
        account,
        stream,
        options.affinity,
        raw ? options.contentType || "application/octet-stream" : "application/json",
      ),
      body: raw ? new Uint8Array(body) : JSON.stringify(body),
      signal: withTimeoutSignal(timeoutMs, options.signal),
    });
    return resp;
  } catch (err: any) {
    const cause = err?.cause;
    const detail = cause
      ? `${cause.code || cause.name || "error"}: ${cause.message || String(cause)}`
      : err?.message || String(err);
    throw new Error(`mistral upstream fetch failed: ${detail}`);
  }
}

/** Value of one text field of a multipart/form-data body (null when absent). */
export function multipartField(body: Buffer, name: string): string | null {
  const marker = Buffer.from(`name="${name}"`);
  const at = body.indexOf(marker);
  if (at < 0) return null;
  const start = body.indexOf("\r\n\r\n", at);
  if (start < 0) return null;
  const end = body.indexOf("\r\n--", start + 4);
  if (end < 0) return null;
  return body.subarray(start + 4, end).toString("utf8");
}

/** Same body with one multipart text field replaced (unchanged if absent). */
export function replaceMultipartField(
  body: Buffer,
  name: string,
  value: string,
): Buffer {
  const marker = Buffer.from(`name="${name}"`);
  const at = body.indexOf(marker);
  if (at < 0) return body;
  const start = body.indexOf("\r\n\r\n", at);
  if (start < 0) return body;
  const end = body.indexOf("\r\n--", start + 4);
  if (end < 0) return body;
  return Buffer.concat([
    body.subarray(0, start + 4),
    Buffer.from(value, "utf8"),
    body.subarray(end),
  ]);
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
