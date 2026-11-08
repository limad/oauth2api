/**
 * Cursor AgentService upstream (`agent.v1.AgentService/Run`).
 *
 * Cursor moved chat off `aiserver.v1.ChatService/StreamUnifiedChatWithTools`:
 * that endpoint now answers Auto, composer and most current models with
 * `ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT` / "Your version of Cursor is no
 * longer supported", whatever client version is sent. The desktop client and
 * cursor-agent talk to AgentService instead: a bidirectional Connect stream
 * over HTTP/2 on agent.api5.cursor.sh, where the server asks for IDE context,
 * key/value blobs and tool runs, and the client must answer each request or
 * the stream stalls.
 *
 * Wire format ported from 9router (open-sse/executors/cursor.js, 2026-10).
 * We send no tools: the proxy only relays text, so every IDE tool request is
 * answered with "not available" and the model falls back to a text answer.
 */
import http2 from "node:http2";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import {
  concatBytes,
  connectFrame,
  encodeBytesField,
  encodeVarintField,
  ConnectError,
  extractJsonError,
  parseConnectError,
  parseFields,
  ProtoFieldRaw,
} from "./cursor-proto";
import { AgentMessage, CursorToolCall, decodeMcpCall } from "./cursor-tools";

export const DEFAULT_AGENT_SERVICE_URL = "https://agent.api5.cursor.sh";
export const AGENT_RUN_PATH = "/agent.v1.AgentService/Run";
export const AGENT_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";

export type { AgentMessage } from "./cursor-tools";

// ---------------------------------------------------------------- encoding

const EMPTY = new Uint8Array(0);
const msg = (field: number, value: Uint8Array | string) =>
  encodeBytesField(field, value);

function encodeHistoryMessage(message: AgentMessage): Uint8Array | null {
  if (!message.content) return null;
  // ConversationHistoryMessage.user (1) / .assistant (2) -> content -> text.
  const text = msg(1, message.content);
  return msg(message.role === "assistant" ? 2 : 1, msg(1, msg(1, text)));
}

/**
 * Build the first client frame: AgentClientMessage.run_request. System text
 * is folded into the current user message because RunRequest's
 * custom_system_prompt makes AgentService return an empty turn.
 */
export function buildAgentRunFrame(
  messages: AgentMessage[],
  model: string,
  reasoningEffort?: string | null,
  /** Encoded McpTools (client function tools), or empty. */
  mcpTools: Uint8Array = EMPTY,
): Uint8Array {
  const system = messages
    .filter((m) => m.role === "system" && m.content)
    .map((m) => m.content)
    .join("\n\n");
  const chat = messages.filter((m) => m.role !== "system");
  let currentIndex = -1;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i].role === "user") {
      currentIndex = i;
      break;
    }
  }
  const current =
    currentIndex >= 0 ? chat[currentIndex] : chat[chat.length - 1];
  const history = chat
    .slice(0, currentIndex >= 0 ? currentIndex : Math.max(0, chat.length - 1))
    .map(encodeHistoryMessage)
    .filter((h): h is Uint8Array => !!h);
  const rawUser = current?.content || "Continue.";
  const userText = system ? `${system}\n\n${rawUser}` : rawUser;

  // UserMessage: text, message id, empty selected_context, mode=1 (agent).
  // Without selected_context + mode the RPC is accepted but the turn is empty.
  const userMessage = concatBytes([
    msg(1, userText),
    msg(2, uuidv4()),
    msg(3, EMPTY),
    encodeVarintField(4, 1),
  ]);
  const userAction = concatBytes([
    msg(1, userMessage),
    ...(history.length
      ? [msg(7, concatBytes(history.map((h) => msg(1, h))))]
      : []),
  ]);

  const effort = String(reasoningEffort || "").toLowerCase();
  const effortValue =
    effort === "ultra" ? "max" : effort === "minimal" ? "low" : effort;
  const parameter =
    effortValue && effortValue !== "none"
      ? msg(
          3,
          concatBytes([
            msg(1, /gpt-/i.test(model) ? "reasoning" : "effort"),
            msg(2, effortValue),
          ]),
        )
      : null;
  const requestedModel = concatBytes([
    msg(1, model),
    encodeVarintField(7, 1),
    ...(parameter ? [parameter] : []),
  ]);
  // ModelDetails: thinking variants return an empty turn with RequestedModel alone.
  const modelDetails = concatBytes([
    msg(1, model),
    msg(3, model),
    msg(4, model),
  ]);

  const runRequest = concatBytes([
    msg(1, EMPTY), // empty ConversationState = fresh session
    msg(2, msg(1, userAction)), // ConversationAction.user_message_action
    msg(3, modelDetails),
    ...(mcpTools.length ? [msg(4, mcpTools)] : []),
    msg(9, requestedModel),
  ]);
  return connectFrame(msg(1, runRequest));
}

function varintOf(fields: ProtoFieldRaw[], field: number): number {
  return fields.find((f) => f.field === field && f.wireType === 0)?.varint || 0;
}

function bytesOf(
  fields: ProtoFieldRaw[],
  field: number,
): Uint8Array | undefined {
  return fields.find((f) => f.field === field && f.wireType === 2)?.bytes;
}

function has(fields: ProtoFieldRaw[], field: number): boolean {
  return fields.some((f) => f.field === field);
}

function stringOf(fields: ProtoFieldRaw[], field: number): string {
  const b = bytesOf(fields, field);
  return b ? Buffer.from(b).toString("utf8") : "";
}

/** AgentClientMessage.exec_client_message (2) answering one exec request. */
function execReply(
  exec: ProtoFieldRaw[],
  resultField: number,
  result: Uint8Array,
): Uint8Array {
  const id = varintOf(exec, 1);
  return connectFrame(
    msg(
      2,
      concatBytes([
        ...(id ? [encodeVarintField(1, id)] : []),
        msg(15, stringOf(exec, 15)),
        msg(resultField, result),
      ]),
    ),
  );
}

// ExecServerMessage variant -> ExecClientMessage result field (same numbers).
const EXEC_RESULT_FIELDS = new Set([2, 3, 4, 5, 7, 8, 9, 16, 20, 23]);
const REQUEST_CONTEXT_FIELD = 10;
const MCP_TOOL_CALL_FIELD = 11;
const TOOL_UNAVAILABLE =
  "Tool not available in this environment. Answer with text instead.";

export type ExecAction =
  | { kind: "reply"; frame: Uint8Array; what: string }
  | { kind: "tool"; call: CursorToolCall }
  | { kind: "fail"; what: string };

/** Decide how to answer an ExecServerMessage. Exported for tests. */
export function answerExecRequest(payload: Uint8Array): ExecAction {
  const exec = parseFields(payload);
  if (has(exec, REQUEST_CONTEXT_FIELD)) {
    // RequestContextResult.success with an empty context.
    return {
      kind: "reply",
      frame: execReply(exec, REQUEST_CONTEXT_FIELD, msg(1, msg(1, EMPTY))),
      what: "request_context",
    };
  }
  const variant = exec.find((f) => f.field !== 1 && f.field !== 15)?.field;
  if (variant === MCP_TOOL_CALL_FIELD) {
    // A client tool: hand it back to the client instead of answering.
    const args = bytesOf(exec, MCP_TOOL_CALL_FIELD);
    const call = args ? decodeMcpCall(args) : null;
    if (!call) return { kind: "fail", what: "mcp tool call without a name" };
    if (!call.id) call.id = `call_${uuidv4().replace(/-/g, "")}`;
    return { kind: "tool", call };
  }
  if (variant !== undefined && EXEC_RESULT_FIELDS.has(variant)) {
    // Diagnostics (9) has no "rejected" form: an empty success unblocks it.
    const result = variant === 9 ? EMPTY : msg(2, msg(2, TOOL_UNAVAILABLE));
    return {
      kind: "reply",
      frame: execReply(exec, variant, result),
      what: `exec ${variant}`,
    };
  }
  return { kind: "fail", what: `exec ${variant ?? "?"}` };
}

/** Answer a KvServerMessage (blob get/set), echoing its metadata. Exported for tests. */
export function answerKvRequest(payload: Uint8Array): Uint8Array | null {
  const kv = parseFields(payload);
  const id = varintOf(kv, 1);
  const metadata = bytesOf(kv, 4);
  let result: Uint8Array;
  if (has(kv, 2))
    result = msg(2, msg(1, EMPTY)); // get_blob -> empty blob
  else if (has(kv, 3))
    result = msg(3, EMPTY); // set_blob -> ack
  else return null;
  return connectFrame(
    msg(
      3,
      concatBytes([
        ...(id ? [encodeVarintField(1, id)] : []),
        result,
        ...(metadata && metadata.length ? [msg(4, metadata)] : []),
      ]),
    ),
  );
}

// --------------------------------------------------------------- transport

export interface CursorAgentSession {
  status: number;
  headers: Record<string, string>;
  /** Raw response bytes as they arrive. Throws when the request is aborted. */
  chunks: AsyncIterable<Uint8Array>;
  write(frame: Uint8Array): void;
  /** End our side and release the connection. Idempotent. */
  close(): void;
}

export type CursorAgentTransport = (
  url: string,
  headers: Record<string, string>,
  firstFrame: Uint8Array,
  headerTimeoutMs: number,
  signal?: AbortSignal,
) => Promise<CursorAgentSession>;

export type CursorUnaryTransport = (
  url: string,
  headers: Record<string, string>,
  body: Uint8Array,
  timeoutMs: number,
) => Promise<{ status: number; body: Uint8Array }>;

/** Bidirectional HTTP/2 stream: the request body stays open for our acks. */
const http2Duplex: CursorAgentTransport = (
  url,
  headers,
  firstFrame,
  headerTimeoutMs,
  signal,
) =>
  new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = http2.connect(parsed.origin);
    const queue: Uint8Array[] = [];
    let wake: (() => void) | null = null;
    let ended = false;
    let failure: Error | null = null;
    let settled = false;

    const notify = () => {
      const w = wake;
      wake = null;
      w?.();
    };
    const close = () => {
      try {
        if (!req.destroyed) req.close(http2.constants.NGHTTP2_CANCEL);
      } catch {
        /* ignore */
      }
      try {
        client.close();
      } catch {
        /* ignore */
      }
    };
    const fail = (err: Error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        close();
        reject(err);
        return;
      }
      if (!failure) failure = err;
      ended = true;
      notify();
      close();
    };
    const onAbort = () => fail(new Error("request aborted"));

    const timer = setTimeout(
      () => fail(new Error("cursor AgentService HTTP/2 request timed out")),
      headerTimeoutMs,
    );
    const h2Headers: http2.OutgoingHttpHeaders = {
      ":method": "POST",
      ":path": `${parsed.pathname}${parsed.search}`,
    };
    for (const [k, v] of Object.entries(headers))
      h2Headers[k.toLowerCase()] = v;
    const req = client.request(h2Headers);
    client.on("error", fail);
    req.on("error", fail);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("data", (chunk: Buffer) => {
      queue.push(new Uint8Array(chunk));
      notify();
    });
    req.on("end", () => {
      ended = true;
      notify();
      close();
    });
    req.on("response", (rsp) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(rsp)) {
        if (!k.startsWith(":") && v !== undefined)
          out[k] = Array.isArray(v) ? v.join(",") : String(v);
      }
      async function* chunks(): AsyncGenerator<Uint8Array> {
        try {
          while (true) {
            if (queue.length) {
              yield queue.shift()!;
              continue;
            }
            if (failure) throw failure;
            if (ended) return;
            await new Promise<void>((r) => (wake = r));
          }
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      }
      resolve({
        status: Number(rsp[":status"] || 0),
        headers: out,
        chunks: chunks(),
        write(frame) {
          if (!req.destroyed && !req.writableEnded)
            req.write(Buffer.from(frame));
        },
        close() {
          try {
            if (!req.writableEnded) req.end();
          } catch {
            /* ignore */
          }
          close();
        },
      });
    });
    req.write(Buffer.from(firstFrame));
  });

const http2Unary: CursorUnaryTransport = (url, headers, body, timeoutMs) =>
  new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = http2.connect(parsed.origin);
    const parts: Buffer[] = [];
    let status = 0;
    const done = (err?: Error) => {
      clearTimeout(timer);
      try {
        client.close();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve({ status, body: new Uint8Array(Buffer.concat(parts)) });
    };
    const timer = setTimeout(() => {
      try {
        req.close(http2.constants.NGHTTP2_CANCEL);
      } catch {
        /* ignore */
      }
      done(new Error("cursor GetUsableModels timed out"));
    }, timeoutMs);
    const h2Headers: http2.OutgoingHttpHeaders = {
      ":method": "POST",
      ":path": `${parsed.pathname}${parsed.search}`,
    };
    for (const [k, v] of Object.entries(headers))
      h2Headers[k.toLowerCase()] = v;
    const req = client.request(h2Headers);
    client.on("error", done);
    req.on("error", done);
    req.on("response", (h) => (status = Number(h[":status"] || 0)));
    req.on("data", (c: Buffer) => parts.push(c));
    req.on("end", () => done());
    req.end(Buffer.from(body));
  });

let agentTransport: CursorAgentTransport = http2Duplex;
let unaryTransport: CursorUnaryTransport = http2Unary;

/** Test-only: replace the HTTP/2 transports. */
export function __setCursorAgentTransports(
  t: {
    run?: CursorAgentTransport | null;
    unary?: CursorUnaryTransport | null;
  } | null,
): void {
  agentTransport = t?.run || http2Duplex;
  unaryTransport = t?.unary || http2Unary;
  modelCache.clear();
}

// ------------------------------------------------------------ Auto / models

interface AgentModelInfo {
  id: string;
  defaultOn: boolean;
  supportsAgent: boolean;
  isChatOnly: boolean;
  isHidden: boolean;
}

/** Decode GetUsableModelsResponse field 2 (model picker entries + flags). */
export function parseAgentModelPicker(payload: Uint8Array): AgentModelInfo[] {
  const out: AgentModelInfo[] = [];
  const seen = new Set<string>();
  for (const f of parseFields(payload)) {
    if (f.field !== 2 || !f.bytes) continue;
    const e = parseFields(f.bytes);
    const id = stringOf(e, 1).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      defaultOn: varintOf(e, 2) === 1,
      isChatOnly: varintOf(e, 4) === 1,
      supportsAgent: varintOf(e, 5) === 1,
      isHidden: varintOf(e, 35) === 1,
    });
  }
  return out;
}

/** The model the desktop picker would use for "Auto". */
export function pickAutoModel(models: AgentModelInfo[]): string | null {
  const usable = models.filter(
    (m) => m.supportsAgent && !m.isChatOnly && !m.isHidden,
  );
  return (usable.find((m) => m.defaultOn) || usable[0])?.id || null;
}

const MODEL_CACHE_MS = 5 * 60 * 1000;
const modelCache = new Map<string, { at: number; auto: string | null }>();

/**
 * "default"/"auto" is a picker alias, not an AgentService model id: sent
 * verbatim it yields an empty turn. Resolve it from the account's catalog;
 * on any failure keep the alias and let the server decide.
 */
export async function resolveAgentModel(
  model: string,
  baseUrl: string,
  headers: Record<string, string>,
): Promise<string> {
  if (model !== "default" && model !== "auto") return model;
  const key = createHash("sha256")
    .update(headers.Authorization || "")
    .digest("hex");
  const cached = modelCache.get(key);
  if (cached && Date.now() - cached.at < MODEL_CACHE_MS)
    return cached.auto || model;
  let auto: string | null = null;
  try {
    const unaryHeaders: Record<string, string> = { ...headers };
    for (const k of Object.keys(unaryHeaders)) {
      if (/^connect-|^content-type$|^accept$/i.test(k)) delete unaryHeaders[k];
    }
    unaryHeaders["Content-Type"] = "application/proto";
    unaryHeaders.Accept = "application/proto";
    const rsp = await unaryTransport(
      `${baseUrl}${AGENT_MODELS_PATH}`,
      unaryHeaders,
      EMPTY,
      10_000,
    );
    if (rsp.status !== 200) throw new Error(`status ${rsp.status}`);
    auto = pickAutoModel(parseAgentModelPicker(rsp.body));
  } catch (err: any) {
    console.error(
      `[cursor] GetUsableModels failed: ${err?.message || String(err)}`,
    );
  }
  modelCache.set(key, { at: Date.now(), auto });
  return auto || model;
}

// --------------------------------------------------------------- decoding

/** Token counts from TurnEndedUpdate. `input` is fresh input (cache excluded). */
export interface CursorTurnUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export type AgentDelta =
  | {
      textDelta: string;
      reasoningDelta: string;
      toolCall?: CursorToolCall;
      __done?: undefined;
    }
  | {
      __done: true;
      aggregatedText: string;
      aggregatedReasoning: string;
      toolCalls?: CursorToolCall[];
      error?: string;
      /** Set when the error came from Cursor itself (end-stream frame). */
      upstreamError?: ConnectError;
      usage?: CursorTurnUsage;
    };

/**
 * TurnEndedUpdate: input_tokens (1, whole prompt incl. cache), output (2),
 * cache_read (3), cache_write (4), reasoning (5). Same reading as oh-my-pi.
 */
export function parseTurnEndedUsage(
  payload: Uint8Array,
): CursorTurnUsage | undefined {
  const f = parseFields(payload);
  const input = varintOf(f, 1);
  const output = varintOf(f, 2);
  const cacheRead = varintOf(f, 3);
  const cacheWrite = varintOf(f, 4);
  const reasoning = varintOf(f, 5);
  if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0)
    return undefined;
  return {
    input: Math.max(input - cacheRead - cacheWrite, 0),
    output,
    cacheRead,
    cacheWrite,
    reasoning,
  };
}

const THINK_CLOSE_RE = /<\/think>\s*/i;

/**
 * Thinking deltas are held back until we know what they are: composer/Grok
 * put the visible answer after `</think>` in the thinking channel and never
 * send text. Once `</think>` shows up the rest is text; once real text
 * arrives the held thinking is reasoning; if the turn ends with no text the
 * thinking becomes the answer.
 */
class ThinkSplitter {
  private pending = "";
  private mode: "undecided" | "split" | "reasoning" = "undecided";

  thinking(delta: string): { textDelta: string; reasoningDelta: string } {
    if (this.mode === "split") return { textDelta: delta, reasoningDelta: "" };
    if (this.mode === "reasoning")
      return { textDelta: "", reasoningDelta: delta };
    this.pending += delta;
    const m = this.pending.match(THINK_CLOSE_RE);
    if (!m || m.index === undefined)
      return { textDelta: "", reasoningDelta: "" };
    const out = {
      reasoningDelta: this.pending.slice(0, m.index),
      textDelta: this.pending.slice(m.index + m[0].length),
    };
    this.pending = "";
    this.mode = "split";
    return out;
  }

  text(delta: string): { textDelta: string; reasoningDelta: string } {
    if (this.mode !== "undecided")
      return { textDelta: delta, reasoningDelta: "" };
    const out = { textDelta: delta, reasoningDelta: this.pending };
    this.pending = "";
    this.mode = "reasoning";
    return out;
  }

  /** Held thinking at end of turn, to be used as the answer. */
  drain(): string {
    const out = this.pending.trim();
    this.pending = "";
    return out;
  }
}

/**
 * Read AgentServerMessages, answer the server's requests on the same stream
 * and yield text/reasoning deltas, then one terminator item.
 */
export async function* agentSessionDeltas(
  session: CursorAgentSession,
): AsyncGenerator<AgentDelta> {
  let buffer: Uint8Array = new Uint8Array(0);
  const splitter = new ThinkSplitter();
  let text = "";
  let reasoning = "";
  let error: string | undefined;
  let upstreamError: ConnectError | undefined;
  let usage: CursorTurnUsage | undefined;
  let finished = false;

  const toolCalls: CursorToolCall[] = [];
  const emit = (d: { textDelta: string; reasoningDelta: string }) => {
    text += d.textDelta;
    reasoning += d.reasoningDelta;
    return d.textDelta || d.reasoningDelta ? d : null;
  };

  try {
    for await (const chunk of session.chunks) {
      buffer = concatBytes([buffer, chunk]);
      const out: {
        textDelta: string;
        reasoningDelta: string;
        toolCall?: CursorToolCall;
      }[] = [];
      let pos = 0;
      while (!finished && pos + 5 <= buffer.length) {
        const flags = buffer[pos];
        const length = new DataView(
          buffer.buffer,
          buffer.byteOffset + pos + 1,
          4,
        ).getUint32(0, false);
        if (pos + 5 + length > buffer.length) break;
        let payload = buffer.slice(pos + 5, pos + 5 + length);
        pos += 5 + length;
        if (flags & 1) {
          try {
            payload = new Uint8Array(gunzipSync(payload));
          } catch {
            /* leave as-is */
          }
        }
        if (flags & 2) {
          // End-of-stream frame: carries the error, if any.
          const err = parseConnectError(payload);
          if (err) {
            error = err.text;
            upstreamError = err;
          }
          finished = true;
          break;
        }
        const server = parseFields(payload);
        const update = bytesOf(server, 1);
        if (update) {
          const u = parseFields(update);
          const textMsg = bytesOf(u, 1);
          if (textMsg) {
            const d = emit(splitter.text(stringOf(parseFields(textMsg), 1)));
            if (d) out.push(d);
          }
          const thinkMsg = bytesOf(u, 4);
          if (thinkMsg) {
            const d = emit(
              splitter.thinking(stringOf(parseFields(thinkMsg), 1)),
            );
            if (d) out.push(d);
          }
          if (has(u, 14)) {
            // turn_ended, with the turn's token counts.
            const turnEnded = bytesOf(u, 14);
            if (turnEnded) usage = parseTurnEndedUsage(turnEnded);
            finished = true;
          }
        }
        const execReq = bytesOf(server, 2);
        if (execReq) {
          const action = answerExecRequest(execReq);
          if (action.kind === "reply") session.write(action.frame);
          else if (action.kind === "tool") {
            // End the turn after this chunk: parallel calls usually arrive
            // together; the client runs them and sends the results back.
            toolCalls.push(action.call);
            out.push({
              textDelta: "",
              reasoningDelta: "",
              toolCall: action.call,
            });
          } else {
            error = `Cursor AgentService requested an unsupported IDE tool (${action.what})`;
            finished = true;
          }
        }
        const kvReq = bytesOf(server, 4);
        if (kvReq) {
          const frame = answerKvRequest(kvReq);
          if (frame) session.write(frame);
        }
      }
      buffer = buffer.slice(pos);
      for (const d of out) yield d;
      if (toolCalls.length) finished = true;
      if (finished) break;
    }
  } finally {
    session.close();
  }

  const held = splitter.drain();
  if (held && !text && !toolCalls.length) {
    text = held;
    yield { textDelta: held, reasoningDelta: "" };
  }
  if (!text && !reasoning && !error && !toolCalls.length)
    error = "Cursor AgentService returned an empty turn";
  yield {
    __done: true,
    aggregatedText: text,
    aggregatedReasoning: reasoning,
    ...(toolCalls.length ? { toolCalls } : {}),
    error,
    upstreamError,
    usage,
  };
}

/** Open a Run stream and send the request frame. */
export function openCursorAgentRun(
  baseUrl: string,
  headers: Record<string, string>,
  frame: Uint8Array,
  headerTimeoutMs: number,
  signal?: AbortSignal,
): Promise<CursorAgentSession> {
  return agentTransport(
    `${baseUrl}${AGENT_RUN_PATH}`,
    headers,
    frame,
    headerTimeoutMs,
    signal,
  );
}

/** Collect a non-200 Run answer into a readable error string. */
export async function readAgentError(
  session: CursorAgentSession,
): Promise<string> {
  const parts: Uint8Array[] = [];
  try {
    for await (const c of session.chunks) parts.push(c);
  } catch {
    /* ignore */
  } finally {
    session.close();
  }
  const bytes = concatBytes(parts);
  // Plain JSON for HTTP-level errors, or a single end-stream frame.
  return (
    extractJsonError(bytes) ||
    (bytes.length > 5 ? extractJsonError(bytes.slice(5)) : undefined) ||
    Buffer.from(bytes).toString("utf8").slice(0, 500)
  );
}
