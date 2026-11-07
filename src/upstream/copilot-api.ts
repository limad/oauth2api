import { Request } from "express";
import { Config } from "../config";
import { AccountManager, AvailableAccount } from "../accounts/manager";
import { withTimeoutSignal } from "../utils/abort";

const BASE_URL = "https://api.githubcopilot.com";
const CHAT_COMPLETIONS_PATH = "/chat/completions";
const MODELS_PATH = "/models";
const CLIENT_VERSION = "auth2api/1.0.0";

const FALLBACK_MODELS = [
  "copilot-gpt-5.1-codex",
  "copilot-gpt-5",
  "copilot-gpt-4.1",
  "copilot-claude-sonnet-4.5",
];

interface CopilotModel {
  id: string;
  name?: string;
  model_picker_enabled?: boolean;
  policy?: { state?: string };
}

interface ModelsResponse {
  data?: CopilotModel[];
}

export interface CallCopilotOptions {
  body?: any;
  request: Request;
  account: AvailableAccount;
  config: Config;
  signal?: AbortSignal;
}

function stripModelPrefix(model: string): string {
  return String(model || "").replace(/^(copilot[:/-]|ghcp\/)/i, "").trim();
}

function buildHeaders(account: AvailableAccount, stream: boolean): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    Authorization: `Bearer ${account.token.accessToken}`,
    "User-Agent": CLIENT_VERSION,
    "Openai-Intent": "conversation-edits",
    "x-initiator": "user",
  };
}

function normalizeChatBody(body: any): any {
  if (!body || typeof body !== "object") return body;
  const next = { ...body };
  if (next.model) next.model = stripModelPrefix(next.model);
  return next;
}

export async function callCopilotChatCompletions(
  options: CallCopilotOptions,
): Promise<Response> {
  const { request, account, config } = options;
  const body = normalizeChatBody(options.body ?? request.body);
  const stream = !!body.stream;
  const timeoutMs = stream
    ? config.timeouts["stream-messages-ms"]
    : config.timeouts["messages-ms"];

  try {
    return await fetch(`${BASE_URL}${CHAT_COMPLETIONS_PATH}`, {
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
    throw new Error(`copilot upstream fetch failed: ${detail}`);
  }
}

const EMBEDDINGS_PATH = "/embeddings";

/** Copilot's embedding models (OpenAI `text-embedding-*`), bare or `copilot-`/`ghcp/` prefixed. */
export function isCopilotEmbeddingModel(model: string): boolean {
  return /^text-embedding-/i.test(stripModelPrefix(model));
}

/**
 * Copilot answers a plain-text "400 Bad Request" when `input` is a single
 * string (seen live on 2026-11-07), which OpenAI accepts: it is sent as a
 * one-item list, same tokens and same `data[0]` in the answer.
 */
export function normalizeCopilotEmbeddingsBody(body: any): any {
  const next = normalizeChatBody(body);
  if (next && typeof next.input === "string") return { ...next, input: [next.input] };
  return next;
}

/** POST /embeddings, body relayed as is (`copilot-` prefix removed, string input listed). */
export async function callCopilotEmbeddings(options: {
  body: any;
  account: AvailableAccount;
  config: Config;
  signal?: AbortSignal;
}): Promise<Response> {
  const { account, config } = options;
  const body = normalizeCopilotEmbeddingsBody(options.body);
  try {
    return await fetch(`${BASE_URL}${EMBEDDINGS_PATH}`, {
      method: "POST",
      headers: buildHeaders(account, false),
      body: JSON.stringify(body),
      signal: withTimeoutSignal(config.timeouts["messages-ms"], options.signal),
    });
  } catch (err: any) {
    const cause = err?.cause;
    const detail = cause
      ? `${cause.code || cause.name || "error"}: ${cause.message || String(cause)}`
      : err?.message || String(err);
    throw new Error(`copilot upstream fetch failed: ${detail}`);
  }
}

export async function listCopilotModels(
  manager: AccountManager,
): Promise<Array<{ id: string; owned_by: string }>> {
  const result = manager.getNextAccount();
  if (!result.account) {
    return FALLBACK_MODELS.map((id) => ({ id, owned_by: "github-copilot" }));
  }

  try {
    const resp = await fetch(`${BASE_URL}${MODELS_PATH}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${result.account.token.accessToken}`,
        Accept: "application/json",
        "User-Agent": CLIENT_VERSION,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const parsed = (await resp.json()) as ModelsResponse;
    const models = Array.isArray(parsed.data) ? parsed.data : [];
    const ids = models
      .filter((m) => m.model_picker_enabled !== false && m.policy?.state !== "disabled")
      .map((m) => m.id)
      .filter(Boolean);
    if (ids.length) {
      return ids.map((id) => ({ id: `copilot-${id}`, owned_by: "github-copilot" }));
    }
  } catch (err: any) {
    console.error(`[copilot] /models failed: ${err?.message || String(err)}`);
  }

  return FALLBACK_MODELS.map((id) => ({ id, owned_by: "github-copilot" }));
}
