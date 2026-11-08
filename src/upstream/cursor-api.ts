import { createHash } from "node:crypto";
import { Request } from "express";
import { v4 as uuidv4, v5 as uuidv5 } from "uuid";
import { AccountManager, AvailableAccount } from "../accounts/manager";
import { Config } from "../config";
import { withTimeoutSignal } from "../utils/abort";
import type { ConnectError } from "./cursor-proto";
import { ensureCursorClientVersion, getCursorClientVersion } from "./cursor-version";
import {
  agentSessionDeltas,
  buildAgentRunFrame,
  CursorAgentSession,
  DEFAULT_AGENT_SERVICE_URL,
  openCursorAgentRun,
  readAgentError,
  resolveAgentModel,
} from "./cursor-agent";
import type { CursorTurnUsage } from "./cursor-agent";
import {
  agentMessagesFromBody,
  clientToolsFromBody,
  CursorToolCall,
  encodeMcpToolDefinitions,
} from "./cursor-tools";

// Model list only; chat goes to AgentService (cursor-agent.ts).
const DEFAULT_API_BASE_URL = "https://api2.cursor.sh";
const MODELS_PATH = "/aiserver.v1.AiService/AvailableModels";
const UUID_DNS_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

const FALLBACK_MODELS = ["cursor-premium", "cursor-fast", "cursor-composer"];

/**
 * Wire format the caller wants for the streamed Cursor response.
 *  - openai-responses: OpenAI Responses API SSE (`response.output_text.delta`, …)
 *  - anthropic-messages: Anthropic Messages SSE (`content_block_delta`, …)
 *  - openai-chat-completions: OpenAI Chat Completions SSE (`chat.completion.chunk`)
 */
export type CursorSseFormat =
  | "openai-responses"
  | "anthropic-messages"
  | "openai-chat-completions";

export interface CallCursorResponsesOptions {
  body?: any;
  request: Request;
  /** SSE format the caller wants back. Defaults to OpenAI Responses. */
  responseFormat?: CursorSseFormat;
  account: AvailableAccount;
  config: Config;
  signal?: AbortSignal;
}

/**
 * Mapping from "publicly-known" model names (the ones Anthropic / OpenAI
 * SDKs and Claude Code use by default) to the names Cursor expects on its
 * `StreamUnifiedChatWithTools` endpoint.
 *
 * The Cursor backend has its own internal SKU naming — e.g. Anthropic's
 * `claude-sonnet-4-5` is exposed as `claude-4.5-sonnet`. Without this map a
 * naive client request like `{"model":"claude-sonnet-4-5"}` would either be
 * routed to Cursor's `default` Auto router (silent fallback) or rejected.
 */
const PUBLIC_MODEL_TO_CURSOR: Record<string, string> = {
  // Anthropic Claude — public name → Cursor SKU
  "claude-3-5-haiku-20241022": "claude-4.5-haiku",
  "claude-3-5-haiku-latest": "claude-4.5-haiku",
  "claude-3-5-sonnet-20241022": "claude-4.5-sonnet",
  "claude-3-5-sonnet-latest": "claude-4.5-sonnet",
  "claude-3-7-sonnet-20250219": "claude-4-sonnet",
  "claude-3-7-sonnet-latest": "claude-4-sonnet",
  "claude-haiku-4-5": "claude-4.5-haiku",
  "claude-haiku-4-5-20251001": "claude-4.5-haiku",
  "claude-haiku-4-5-latest": "claude-4.5-haiku",
  "claude-haiku-latest": "claude-4.5-haiku",
  "claude-sonnet-4-5": "claude-4.5-sonnet",
  "claude-sonnet-4-5-20250929": "claude-4.5-sonnet",
  "claude-sonnet-4-5-latest": "claude-4.5-sonnet",
  "claude-sonnet-4-6": "claude-4.6-sonnet-medium",
  "claude-sonnet-4-7": "claude-4.6-sonnet-medium",
  "claude-sonnet-latest": "claude-4.6-sonnet-medium",
  "claude-opus-4-1": "claude-4.5-opus-high",
  "claude-opus-4-1-latest": "claude-4.5-opus-high",
  "claude-opus-4-5": "claude-4.5-opus-high",
  "claude-opus-4-6": "claude-4.6-opus-high",
  "claude-opus-4-7": "claude-opus-4-7-medium",
  "claude-opus-latest": "claude-opus-4-7-medium",
  // Anthropic short aliases used by Claude Code
  haiku: "claude-4.5-haiku",
  sonnet: "claude-4.6-sonnet-medium",
  opus: "claude-opus-4-7-medium",
  // OpenAI — common GPT-5 family names
  "gpt-5": "gpt-5.5-medium",
  "gpt-5-mini": "gpt-5-mini",
  "gpt-5.5": "gpt-5.5-medium",
  "gpt-5-codex": "gpt-5.3-codex",
  "gpt-5.3-codex": "gpt-5.3-codex",
  o3: "gpt-5.5-medium",
  "o4-mini": "gpt-5.4-mini-medium",
  "o4-high": "gpt-5.4-high",
};

/**
 * Normalise an inbound model id for the Cursor upstream:
 *   1. strip the auth2api routing prefix (`cursor-`, `cursor:`, `cr/`)
 *   2. translate well-known public names (`claude-sonnet-4-5`, `opus`,
 *      `gpt-5.5`, `o3`, …) into Cursor's internal SKU
 *   3. otherwise keep the trimmed name verbatim — it's already a Cursor SKU
 */
function normaliseModel(model: string): string {
  const stripped = model.replace(/^(cursor[:/-]|cr\/)/i, "").trim();
  if (!stripped) return "default";
  const lower = stripped.toLowerCase();
  if (PUBLIC_MODEL_TO_CURSOR[lower]) return PUBLIC_MODEL_TO_CURSOR[lower];
  // Allow alias overrides via env for power users wanting custom mapping
  // without forking. Format: `MODEL_FOO=cursor-bar,MODEL_BAZ=cursor-qux`.
  const overrides = parseModelAliases(process.env.CURSOR_MODEL_ALIASES);
  if (overrides[lower]) return overrides[lower];
  return stripped;
}

function parseModelAliases(input: string | undefined): Record<string, string> {
  if (!input) return {};
  const out: Record<string, string> = {};
  for (const pair of input.split(",")) {
    const [k, v] = pair.split("=", 2).map((s) => s.trim());
    if (k && v) out[k.toLowerCase()] = v;
  }
  return out;
}

export function __resolveCursorModel(model: string): string {
  return normaliseModel(model);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

const URL_SAFE_BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function jyhEncode(bytes: Uint8Array): string {
  // Jyh cipher used by Cursor's desktop client; see cursor_api_demo TASK-18.
  // We replicate it byte-for-byte so api2.cursor.sh accepts our checksum.
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += URL_SAFE_BASE64[a >> 2];
    out += URL_SAFE_BASE64[((a & 3) << 4) | (b >> 4)];
    if (i + 1 < bytes.length) out += URL_SAFE_BASE64[((b & 15) << 2) | (c >> 6)];
    if (i + 2 < bytes.length) out += URL_SAFE_BASE64[c & 63];
  }
  return out;
}

function buildCursorChecksum(token: string, machineId: string): string {
  const stableMachineId = machineId || sha256Hex(`${token}machineId`);
  const timestamp = Math.floor(Date.now() / 1_000_000);
  const buf = Uint8Array.from([
    (timestamp >>> 40) & 0xff,
    (timestamp >>> 32) & 0xff,
    (timestamp >>> 24) & 0xff,
    (timestamp >>> 16) & 0xff,
    (timestamp >>> 8) & 0xff,
    timestamp & 0xff,
  ]);
  let prev = 165;
  for (let i = 0; i < buf.length; i++) {
    buf[i] = ((buf[i] ^ prev) + (i % 256)) & 0xff;
    prev = buf[i];
  }
  return `${jyhEncode(buf)}${stableMachineId}`;
}

/**
 * Which client version/commit to report. An explicit `cloaking.cursor`
 * override wins (the commit is then only sent when also configured, since a
 * mismatched pair looks worse than a missing one); otherwise the version
 * tracked from Cursor's update feed is used.
 */
export function resolveCursorClientIdentity(config: Config): {
  version: string;
  commit: string;
} {
  const cursor = config.cloaking.cursor || {};
  const override = cursor["client-version"]?.trim();
  if (override) return { version: override, commit: cursor["client-commit"]?.trim() || "" };
  const live = getCursorClientVersion();
  return { version: live.version, commit: live.commit };
}

function cursorClientArch(): string {
  if (process.arch === "arm64") return "aarch64";
  if (process.arch === "x64") return "x64";
  return process.arch;
}

export function __buildCursorHeaders(
  account: AvailableAccount,
  config: Config,
): Record<string, string> {
  const cursor = config.cloaking.cursor || {};
  const token = account.token.accessToken;
  const machineId =
    account.token.cursorServiceMachineId || account.accountUuid || account.deviceId;
  const identity = resolveCursorClientIdentity(config);
  const configVersion =
    cursor["config-version"] || account.token.cursorConfigVersion || uuidv4();
  const sessionId = uuidv5(token, UUID_DNS_NAMESPACE);
  const clientKey = sha256Hex(token);

  // Same header set as the Cursor desktop client (cross-checked with 9router
  // and CLIProxyAPI, 2026-11). Compression is negotiated per Connect message
  // (connect-accept-encoding), never at the HTTP level: our HTTP/2 client does
  // not inflate gzip bodies.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/connect+proto",
    "Connect-Accept-Encoding": "gzip",
    "Connect-Protocol-Version": "1",
    "User-Agent": "connect-es/1.6.1",
    "x-amzn-trace-id": `Root=${uuidv4()}`,
    "x-client-key": clientKey,
    "x-cursor-checksum": buildCursorChecksum(token, machineId),
    "x-cursor-client-version": identity.version,
    "x-cursor-client-type": cursor["client-type"] || "ide",
    "x-cursor-client-os":
      process.platform === "darwin"
        ? "macos"
        : process.platform === "win32"
          ? "windows"
          : "linux",
    "x-cursor-client-arch": cursorClientArch(),
    "x-cursor-client-device-type": "desktop",
    "x-cursor-config-version": configVersion,
    "x-cursor-timezone":
      cursor.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    "x-ghost-mode": cursor["ghost-mode"] || "true",
    "x-session-id": sessionId,
    "x-request-id": uuidv4(),
  };
  if (identity.commit) headers["x-cursor-client-commit"] = identity.commit;
  return headers;
}

/** Turn a delta source into the SSE wire format the client asked for. */
function deltasToSse(
  deltas: AsyncGenerator<DeltaItem>,
  model: string,
  format: CursorSseFormat,
): Response {
  // Use a Web ReadableStream rather than `Readable.from(generator)` — the
  // latter pulls into a 16 KB high-water-mark buffer (default for
  // non-object-mode Node streams) which silently coalesces small SSE
  // events and defeats the streaming we just plumbed through HTTP/2.
  // Enqueueing each event individually preserves real-time delivery.
  let generator: AsyncGenerator<string>;
  if (format === "anthropic-messages") {
    generator = anthropicMessagesGenerator(model, deltas);
  } else if (format === "openai-chat-completions") {
    generator = openaiChatCompletionsGenerator(model, deltas);
  } else {
    generator = openaiResponsesGenerator(model, deltas);
  }
  const encoder = new TextEncoder();
  const sseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const event of generator) {
          controller.enqueue(encoder.encode(event));
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      // Best-effort: tell the generator to stop. The underlying upstream
      // body reader is closed inside cursorUpstreamToSse via deltaStream
      // termination.
      try {
        generator.return?.(undefined);
      } catch {
        /* ignore */
      }
    },
  });

  return new Response(sseStream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

interface DeltaTerminator {
  __done: true;
  aggregatedText: string;
  aggregatedReasoning: string;
  toolCalls?: CursorToolCall[];
  error?: string;
  usage?: CursorTurnUsage;
}

/** True when the turn produced nothing a client can use. */
function isFailedTurn(item: DeltaTerminator): boolean {
  return !!item.error && !item.aggregatedText && !item.aggregatedReasoning && !item.toolCalls?.length;
}

const NO_USAGE: CursorTurnUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
};

/** OpenAI Responses usage: input_tokens includes cached tokens. */
function responsesUsage(u: CursorTurnUsage = NO_USAGE) {
  const input = u.input + u.cacheRead + u.cacheWrite;
  return {
    input_tokens: input,
    output_tokens: u.output,
    total_tokens: input + u.output,
    input_tokens_details: { cached_tokens: u.cacheRead },
    output_tokens_details: { reasoning_tokens: u.reasoning },
  };
}

/** OpenAI Chat usage: prompt_tokens includes cached tokens. */
function chatUsage(u: CursorTurnUsage = NO_USAGE) {
  const prompt = u.input + u.cacheRead + u.cacheWrite;
  return {
    prompt_tokens: prompt,
    completion_tokens: u.output,
    total_tokens: prompt + u.output,
    prompt_tokens_details: { cached_tokens: u.cacheRead },
    completion_tokens_details: { reasoning_tokens: u.reasoning },
  };
}

type DeltaItem =
  | {
      textDelta: string;
      reasoningDelta: string;
      toolCall?: CursorToolCall;
      __done?: undefined;
    }
  | DeltaTerminator;

async function* openaiResponsesGenerator(
  model: string,
  src: AsyncGenerator<DeltaItem>,
): AsyncGenerator<string> {
  const id = `resp_${uuidv4().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);
  let outputIndex = 1; // 0 is the message item
  yield `event: response.created\ndata: ${JSON.stringify({
    type: "response.created",
    response: { id, created_at: created, model },
  })}\n\n`;
  for await (const item of src) {
    if (item.__done) {
      if (isFailedTurn(item)) {
        yield `event: response.failed\ndata: ${JSON.stringify({
          type: "response.failed",
          response: { id, error: { message: item.error } },
        })}\n\n`;
        yield "data: [DONE]\n\n";
        return;
      }
      const reasoningOutput = item.aggregatedReasoning.trim()
        ? [
            {
              type: "reasoning",
              summary: [
                { type: "summary_text", text: item.aggregatedReasoning },
              ],
            },
          ]
        : [];
      const completed = {
        id,
        object: "response",
        created_at: created,
        status: "completed",
        model,
        output: [
          ...reasoningOutput,
          ...(item.aggregatedText || !item.toolCalls?.length
            ? [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: item.aggregatedText }],
                },
              ]
            : []),
          ...(item.toolCalls || []).map(responsesFunctionCall),
        ],
        usage: responsesUsage(item.usage),
      };
      yield `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`;
      yield "data: [DONE]\n\n";
      return;
    }
    if (item.reasoningDelta) {
      yield `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({
        type: "response.reasoning_summary_text.delta",
        delta: item.reasoningDelta,
      })}\n\n`;
    }
    if (item.textDelta) {
      yield `event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta",
        delta: item.textDelta,
      })}\n\n`;
    }
    if (item.toolCall) {
      const fc = responsesFunctionCall(item.toolCall);
      const ev = (type: string, data: Record<string, unknown>) =>
        `event: ${type}\ndata: ${JSON.stringify({ type, output_index: outputIndex, ...data })}\n\n`;
      yield ev("response.output_item.added", {
        item: { ...fc, arguments: "", status: "in_progress" },
      });
      yield ev("response.function_call_arguments.delta", {
        item_id: fc.id,
        delta: fc.arguments,
      });
      yield ev("response.function_call_arguments.done", {
        item_id: fc.id,
        arguments: fc.arguments,
      });
      yield ev("response.output_item.done", { item: fc });
      outputIndex++;
    }
  }
}

function responsesFunctionCall(call: CursorToolCall) {
  return {
    type: "function_call",
    id: `fc_${call.id.replace(/[^A-Za-z0-9_-]/g, "")}`,
    call_id: call.id,
    name: call.name,
    arguments: call.arguments,
    status: "completed",
  };
}

/**
 * Stream Cursor's responses out as Anthropic Messages SSE so Claude Code
 * (and any other Anthropic-native client) can hit `/v1/messages` against
 * auth2api with vanilla model names like `claude-sonnet-4-5` and have it
 * Just Work over a Cursor account.
 *
 * Reasoning bytes are routed to a `thinking` content block; final text goes
 * to a `text` content block. The two blocks are emitted in order and never
 * overlap so clients that don't understand `thinking_delta` (Claude Code
 * pre-thinking versions) can still process the text block independently.
 */
async function* anthropicMessagesGenerator(
  model: string,
  src: AsyncGenerator<DeltaItem>,
): AsyncGenerator<string> {
  const messageId = `msg_${uuidv4().replace(/-/g, "")}`;
  const sseEvent = (event: string, data: unknown) =>
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  yield sseEvent("message_start", {
    type: "message_start",
    message: {
      id: messageId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });

  let thinkingOpen = false;
  let textOpen = false;
  let thinkingIndex = -1;
  let textIndex = -1;
  let nextIndex = 0;
  const closeBlock = (idx: number): string =>
    sseEvent("content_block_stop", { type: "content_block_stop", index: idx });

  for await (const item of src) {
    if (item.__done) {
      if (thinkingOpen) {
        yield closeBlock(thinkingIndex);
        thinkingOpen = false;
      }
      if (textOpen) {
        yield closeBlock(textIndex);
        textOpen = false;
      }
      if (isFailedTurn(item)) {
        yield sseEvent("error", {
          type: "error",
          error: { type: "upstream_error", message: item.error },
        });
        return;
      }
      const u = item.usage || NO_USAGE;
      yield sseEvent("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: item.toolCalls?.length ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage: {
          input_tokens: u.input,
          output_tokens: u.output,
          cache_read_input_tokens: u.cacheRead,
          cache_creation_input_tokens: u.cacheWrite,
        },
      });
      yield sseEvent("message_stop", { type: "message_stop" });
      return;
    }

    if (item.reasoningDelta) {
      // Claude Code expects thinking blocks to come before text blocks.
      // Once text starts we stop emitting reasoning even if more arrives.
      if (textOpen) {
        // After text has begun, treat any trailing reasoning as continuation
        // of the text channel — we cannot interleave two open blocks under
        // the Anthropic schema.
      } else {
        if (!thinkingOpen) {
          thinkingIndex = nextIndex++;
          yield sseEvent("content_block_start", {
            type: "content_block_start",
            index: thinkingIndex,
            content_block: { type: "thinking", thinking: "" },
          });
          thinkingOpen = true;
        }
        yield sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: thinkingIndex,
          delta: { type: "thinking_delta", thinking: item.reasoningDelta },
        });
      }
    }
    if (item.textDelta) {
      if (thinkingOpen) {
        yield closeBlock(thinkingIndex);
        thinkingOpen = false;
      }
      if (!textOpen) {
        textIndex = nextIndex++;
        yield sseEvent("content_block_start", {
          type: "content_block_start",
          index: textIndex,
          content_block: { type: "text", text: "" },
        });
        textOpen = true;
      }
      yield sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: textIndex,
        delta: { type: "text_delta", text: item.textDelta },
      });
    }
    if (item.toolCall) {
      if (thinkingOpen) {
        yield closeBlock(thinkingIndex);
        thinkingOpen = false;
      }
      if (textOpen) {
        yield closeBlock(textIndex);
        textOpen = false;
      }
      const idx = nextIndex++;
      yield sseEvent("content_block_start", {
        type: "content_block_start",
        index: idx,
        content_block: {
          type: "tool_use",
          id: item.toolCall.id,
          name: item.toolCall.name,
          input: {},
        },
      });
      yield sseEvent("content_block_delta", {
        type: "content_block_delta",
        index: idx,
        delta: { type: "input_json_delta", partial_json: item.toolCall.arguments },
      });
      yield closeBlock(idx);
    }
  }
}

/**
 * Stream Cursor's responses out as OpenAI Chat Completions SSE so the
 * vanilla OpenAI SDK / langchain / litellm / VS Code Continue and any
 * other Chat-Completions-native client can talk to a Cursor account
 * unchanged. Each chunk is a `chat.completion.chunk` JSON object with
 * `choices[0].delta` carrying either `content` (final text) or
 * `reasoning_content` (thinking — non-standard but widely supported by
 * downstream consumers like Cline, Cherry Studio, etc., mirroring how
 * DeepSeek / OpenRouter expose chain-of-thought).
 *
 * The stream ends with the OpenAI-required `data: [DONE]\n\n` sentinel.
 */
async function* openaiChatCompletionsGenerator(
  model: string,
  src: AsyncGenerator<DeltaItem>,
): AsyncGenerator<string> {
  const id = `chatcmpl-${uuidv4().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  const fingerprint = `fp_${uuidv4().replace(/-/g, "").slice(0, 12)}`;

  const chunk = (
    delta: Record<string, unknown>,
    finishReason: string | null = null,
    usage?: ReturnType<typeof chatUsage>,
  ) => {
    const payload = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      system_fingerprint: fingerprint,
      choices: [
        { index: 0, delta, finish_reason: finishReason, logprobs: null },
      ],
      ...(usage ? { usage } : {}),
    };
    return `data: ${JSON.stringify(payload)}\n\n`;
  };

  let firstChunkSent = false;
  let toolIndex = 0;
  const sendRoleIfFirst = () => {
    if (firstChunkSent) return "";
    firstChunkSent = true;
    return chunk({ role: "assistant", content: "" });
  };

  for await (const item of src) {
    if (item.__done) {
      if (isFailedTurn(item)) {
        // Surface upstream errors via the OpenAI streaming-error convention:
        // emit a final chunk with finish_reason="error" so SDKs that don't
        // know about the error sentinel still terminate cleanly, then a
        // separate JSON error frame for clients that do parse it.
        if (!firstChunkSent) yield sendRoleIfFirst();
        yield `data: ${JSON.stringify({
          error: { message: item.error, type: "upstream_error" },
        })}\n\n`;
        yield "data: [DONE]\n\n";
        return;
      }
      if (!firstChunkSent) yield sendRoleIfFirst();
      yield chunk({}, item.toolCalls?.length ? "tool_calls" : "stop", chatUsage(item.usage));
      yield "data: [DONE]\n\n";
      return;
    }
    if (item.reasoningDelta) {
      yield sendRoleIfFirst();
      yield chunk({ reasoning_content: item.reasoningDelta });
    }
    if (item.textDelta) {
      yield sendRoleIfFirst();
      yield chunk({ content: item.textDelta });
    }
    if (item.toolCall) {
      yield sendRoleIfFirst();
      yield chunk({
        tool_calls: [
          {
            index: toolIndex++,
            id: item.toolCall.id,
            type: "function",
            function: { name: item.toolCall.name, arguments: item.toolCall.arguments },
          },
        ],
      });
    }
  }
}

function errorResponse(message: string): Response {
  const safeError = message.slice(0, 500);
  return new Response(
    JSON.stringify({
      error: {
        message: `cursor upstream rejected the request: ${safeError}`,
        type: "upstream_error",
        provider: "cursor",
      },
    }),
    { status: 502, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * HTTP status for an error Cursor sent before any output.
 *  - plan refusals (`*_CHANGEABLE`: model not included in the account's
 *    plan, or not at these settings) and Cursor's catch-all "update your
 *    client" answer for models it cannot serve -> 400: the request is wrong,
 *    the account is fine, retrying cannot help;
 *  - otherwise the Connect code (unauthenticated -> 401 triggers a refresh).
 */
export function cursorErrorStatus(err?: ConnectError): number {
  const debug = err?.debug || "";
  if (/_CHANGEABLE$/.test(debug) || debug === "ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT") {
    return 400;
  }
  switch (err?.code) {
    case "unauthenticated":
      return 401;
    case "permission_denied":
      return 403;
    case "resource_exhausted":
      return 429;
    case "invalid_argument":
    case "not_found":
    case "failed_precondition":
      return 400;
    case "unavailable":
      return 503;
    default:
      return 502;
  }
}

function cursorAgentErrorResponse(message: string, err?: ConnectError): Response {
  const status = cursorErrorStatus(err);
  return new Response(
    JSON.stringify({
      error: {
        message: `cursor: ${message.slice(0, 500)}`,
        type: status === 400 ? "invalid_request_error" : "upstream_error",
        ...(err?.debug ? { code: err.debug } : {}),
        provider: "cursor",
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

export function normalizeCursorResponsesBody(body: any): any {
  if (!body || typeof body !== "object") return body;
  return { ...body, stream: true };
}

export async function callCursorResponses(
  options: CallCursorResponsesOptions,
): Promise<Response> {
  const { account, config } = options;
  const body = normalizeCursorResponsesBody(options.body ?? options.request?.body);
  const cursor = config.cloaking.cursor || {};
  const totalTimeoutMs = config.timeouts["stream-messages-ms"];
  // Header-arrival timer inside the transport is a *separate* shorter
  // deadline so an unreachable Cursor edge fails fast instead of dragging
  // out the full stream-messages-ms budget. Cap at 60s (or the configured
  // total, whichever is lower) — Cursor normally returns headers in well
  // under a second.
  const headerTimeoutMs = Math.min(totalTimeoutMs, 60_000);
  // Combine the per-request abort signal with a stream-messages-ms timer so
  // the body phase is also bounded — once headers arrive the transport
  // clears its internal header timer, and without this combined signal a
  // Cursor edge that stalls mid-stream would keep the client hanging
  // forever (the express layer only aborts on client disconnect).
  // Mirrors how `anthropic-api.ts` wraps fetch() with withTimeoutSignal.
  const effectiveSignal = withTimeoutSignal(totalTimeoutMs, options.signal);
  const publicModel = String(body.model || "cursor-default");
  const format = options.responseFormat || "openai-responses";

  // Cursor rejects outdated clients: keep the reported version current.
  if (!cursor["client-version"]) await ensureCursorClientVersion();
  const headers = __buildCursorHeaders(account, config);

  const baseUrl = (cursor["agent-service-url"] || DEFAULT_AGENT_SERVICE_URL).replace(/\/$/, "");
  const model = await resolveAgentModel(normaliseModel(publicModel), baseUrl, headers);
  const frame = buildAgentRunFrame(
    agentMessagesFromBody(body),
    model,
    body.reasoning_effort || body.reasoning?.effort,
  );
  const toolDefs = encodeMcpToolDefinitions(clientToolsFromBody(body));
  let session: CursorAgentSession;
  try {
    session = await openCursorAgentRun(baseUrl, headers, frame, headerTimeoutMs, effectiveSignal);
  } catch (err: any) {
    throw new Error(`cursor upstream HTTP/2 request failed: ${err?.message || String(err)}`);
  }
  if (session.status !== 200) {
    return errorResponse(`HTTP ${session.status}: ${await readAgentError(session)}`);
  }
  // Wait for the first item: when Cursor refuses before any output, answer
  // with a real HTTP error so the retry layer can tell a plan refusal or a
  // bad request (no account cooldown) from an account or server failure.
  const deltas = agentSessionDeltas(session, toolDefs);
  const first = await deltas.next();
  if (first.done) return errorResponse("Cursor AgentService closed the stream");
  const head = first.value;
  if (head.__done && isFailedTurn(head)) {
    return cursorAgentErrorResponse(head.error!, head.upstreamError);
  }
  async function* replay(): AsyncGenerator<DeltaItem> {
    yield head;
    yield* deltas;
  }
  return deltasToSse(replay(), publicModel, format);
}

export async function listCursorModels(
  manager: AccountManager,
  config?: Config,
): Promise<Array<{ id: string; owned_by: string }>> {
  const result = manager.getNextAccount();
  if (!result.account) {
    return FALLBACK_MODELS.map((id) => ({ id, owned_by: "cursor" }));
  }
  const cfg =
    config ||
    ({
      cloaking: {},
      timeouts: { "messages-ms": 120000, "stream-messages-ms": 600000 },
    } as Config);
  const account = result.account;
  const url = `${cfg.cloaking.cursor?.["api-base-url"] || DEFAULT_API_BASE_URL}${MODELS_PATH}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        ...__buildCursorHeaders(account, cfg),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const parsed = (await resp.json()) as { models?: Array<Record<string, unknown>> };
    const ids = extractCursorModelIds(parsed);
    if (ids.length) return ids.map((id) => ({ id, owned_by: "cursor" }));
  } catch (err: any) {
    console.error(`[cursor] AvailableModels failed: ${err?.message || String(err)}`);
  }
  return FALLBACK_MODELS.map((id) => ({ id, owned_by: "cursor" }));
}

/**
 * Pull model IDs out of a Cursor `AvailableModels` response.
 *
 * The response is a single object whose top-level `models` array is the
 * source of truth — each entry is `{ name, serverModelName, ... }`. Earlier
 * we ran a regex over the JSON-serialised payload, which incorrectly
 * surfaced field names (e.g. `isRecommendedForBackgroundComposer`,
 * `backgroundComposerModelConfig`) as model IDs. Now we walk the structured
 * payload, pick `serverModelName` (preferring its routing-friendly form)
 * with a `name` fallback, and skip anything that doesn't look like a real
 * model identifier.
 */
export function extractCursorModelIds(parsed: unknown): string[] {
  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as { models?: unknown };
  if (!Array.isArray(root.models)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of root.models) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const candidate =
      typeof e.serverModelName === "string"
        ? e.serverModelName
        : typeof e.name === "string"
        ? e.name
        : "";
    const trimmed = candidate.trim();
    if (!trimmed) continue;
    // Drop placeholder enum values and obviously invalid identifiers.
    if (
      /^DEGRADATION_/i.test(trimmed) ||
      /[A-Z]{3,}_[A-Z]/.test(trimmed) ||
      !/^[a-z0-9._/-]{1,64}$/i.test(trimmed)
    ) {
      continue;
    }
    const id = trimmed.startsWith("cursor-") ? trimmed : `cursor-${trimmed}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
