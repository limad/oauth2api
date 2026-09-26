/**
 * Anthropic Messages ↔ Gemini Code Assist (`cloudcode-pa.googleapis.com`
 * `v1internal`) translation.
 *
 * This is NOT the public `generativelanguage.googleapis.com` wire format —
 * request/response shapes here were taken from google-gemini/gemini-cli's
 * `packages/core/src/code_assist/converter.ts`, which wraps the ordinary
 * Gemini `contents`/`parts` payload inside a `{model, project, request}`
 * envelope (see gemini-api.ts). The inner `request.contents[].parts[]`
 * shape matches the public Gemini API, so the content-block translation
 * below (text/image/functionCall/functionResponse) is the same either way.
 */
import { v4 as uuidv4 } from "uuid";

function compactUuid(): string {
  return uuidv4().replace(/-/g, "");
}

// The Code Assist v1internal backend does NOT accept the public Gemini API
// model names (e.g. "gemini-3.1-pro") — it 404s ("Requested entity was not
// found") because its real model ids embed the thinking tier directly
// (e.g. "gemini-3.1-pro-high"/"-low"). Verified against
// Draculabo/AntigravityManager's ModelMapping.ts (CLAUDE_TO_GEMINI +
// GEMINI_MODEL_ALIASES), which Antigravity's own model picker corroborates
// (its "Gemini 3.1 Pro / Low" entry is displayed for the real id
// "gemini-3.1-pro-low"). Real backend ids not listed here (already-correct
// ids, or ones Google adds later) pass through unchanged.
const GEMINI_MODEL_ALIASES: Record<string, string> = {
  "gemini-3.1-pro": "gemini-3.1-pro-high",
  "gemini-3.1-pro-preview": "gemini-3.1-pro-high",
  "gemini-3.0-pro": "gemini-3.1-pro-high",
  "gemini-3-pro": "gemini-3-pro-preview",
  "gemini-3-pro-high": "gemini-pro-agent",
  "gemini-2.5-pro": "gemini-3.1-pro-high",
  "gemini-2.5-flash": "gemini-3-flash",
  "gemini-2.5-flash-lite": "gemini-3-flash",
  "gemini-2.0-flash": "gemini-3-flash",
  "gemini-2.0-flash-online": "gemini-3-flash",
  "gemini-3-flash-preview": "gemini-3-flash",
  "gemini-3-pro-image-preview": "gemini-3-pro-image",
  "gemini-3-flash-image": "gemini-3.1-flash-image",
  "gemini-3.1-flash-image-preview": "gemini-3.1-flash-image",
};

export function resolveGeminiModel(model: string): string {
  return GEMINI_MODEL_ALIASES[model] ?? model;
}

// Gemini 3.x rejects a functionCall part with no thought_signature when
// thinking is enabled (HTTP 400: "Function call is missing a
// thought_signature..."). The real signature Gemini issued alongside the
// original functionCall is captured and threaded back on tool_use blocks
// (see `signature` field below) for the common case where the client
// round-trips it verbatim. When it's missing — client stripped the unknown
// field, or the tool_use never came from Gemini — this sentinel from
// Draculabo/AntigravityManager (2k+ stars, dedicated
// thought-signature-compatibility test suite) satisfies the validator
// without one: ClaudeRequestMapper.ts, PLACEHOLDER_SIGNATURE.
const PLACEHOLDER_THOUGHT_SIGNATURE = "skip_thought_signature_validator";

// ── Shared: reasoning effort (Anthropic thinking) → Gemini thinkingConfig ──

function applyThinkingConfig(generationConfig: any, thinking: any): void {
  if (!thinking) return;
  if (thinking.type === "disabled") {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
    return;
  }
  if (thinking.type === "enabled") {
    generationConfig.thinkingConfig = {
      thinkingBudget: thinking.budget_tokens || 8192,
      includeThoughts: true,
    };
  }
}

// ── Anthropic tool_choice → Gemini toolConfig ──

function convertToolConfig(toolChoice: any): any {
  if (!toolChoice) return undefined;
  if (toolChoice.type === "auto") {
    return { functionCallingConfig: { mode: "AUTO" } };
  }
  if (toolChoice.type === "any") {
    return { functionCallingConfig: { mode: "ANY" } };
  }
  if (toolChoice.type === "none") {
    return { functionCallingConfig: { mode: "NONE" } };
  }
  if (toolChoice.type === "tool" && toolChoice.name) {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [toolChoice.name],
      },
    };
  }
  return undefined;
}

// ── Anthropic tools[] → Gemini tools[] ──

function convertTools(tools: any[]): any[] {
  return [
    {
      functionDeclarations: tools.map((t: any) => ({
        name: t.name,
        description: t.description || "",
        parameters: sanitizeSchema(
          t.input_schema || { type: "object", properties: {} },
        ),
      })),
    },
  ];
}

// Gemini's function-declaration schema is a strict subset of JSON Schema —
// it rejects unknown keywords like `additionalProperties`/`$schema` that
// Anthropic tool schemas (and most JSON Schema generators) routinely
// include. Strip them recursively rather than let the upstream 400.
const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "additionalProperties",
  "$schema",
  "unevaluatedProperties",
  "const",
]);

function sanitizeSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: any = {};
  for (const [key, value] of Object.entries(schema)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    out[key] = sanitizeSchema(value);
  }
  return out;
}

// ── Anthropic content block → Gemini part ──

function convertImageBlock(block: any): any | null {
  if (block.source?.type === "base64" && block.source.data) {
    return {
      inlineData: {
        mimeType: block.source.media_type || "image/png",
        data: block.source.data,
      },
    };
  }
  return null; // Gemini Code Assist has no url-fetch image part; drop silently.
}

function anthropicContentToParts(
  content: any,
  role: string,
  toolIdToName: Map<string, string>,
): any[] {
  if (typeof content === "string") return [{ text: content }];
  if (!Array.isArray(content)) return [];
  const parts: any[] = [];
  for (const block of content) {
    if (block?.type === "text") {
      parts.push({ text: block.text || "" });
    } else if (block?.type === "image") {
      const part = convertImageBlock(block);
      if (part) parts.push(part);
    } else if (block?.type === "tool_use" && role === "assistant") {
      const signature = block.signature || PLACEHOLDER_THOUGHT_SIGNATURE;
      parts.push({
        functionCall: { name: block.name, args: block.input || {} },
        thoughtSignature: signature,
        thought_signature: signature,
      });
    } else if (block?.type === "tool_result") {
      const raw = block.content;
      let response: any;
      if (typeof raw === "string") {
        response = { output: raw };
      } else if (Array.isArray(raw)) {
        response = {
          output: raw
            .map((c: any) => (c?.type === "text" ? c.text : JSON.stringify(c)))
            .join(""),
        };
      } else {
        response = { output: JSON.stringify(raw ?? "") };
      }
      if (block.is_error) response.error = true;
      // Gemini's functionResponse.name must be the ORIGINAL FUNCTION NAME
      // (e.g. "todo_write"), not the tool_use call id — Google correlates
      // by name, not id. Verified against Draculabo/AntigravityManager's
      // ClaudeRequestMapper.ts (`toolIdToName.get(block.tool_use_id)`).
      const name = toolIdToName.get(block.tool_use_id) || block.tool_use_id;
      parts.push({ functionResponse: { name, response } });
    }
    // "thinking" blocks from prior assistant turns are intentionally
    // dropped — Gemini regenerates its own thought parts and does not
    // accept replayed thoughts as input.
  }
  return parts;
}

// ── Anthropic Messages request → Gemini `request` (inner envelope) ──

export function anthropicToGeminiContents(body: any): {
  contents: any[];
  systemInstruction?: any;
  tools?: any[];
  toolConfig?: any;
  generationConfig: any;
} {
  const messages: any[] = body.messages || [];

  // tool_result blocks only carry the call id — build the id→name map from
  // every tool_use block up front so a tool_result can be translated
  // regardless of which earlier message its matching tool_use lives in.
  const toolIdToName = new Map<string, string>();
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === "tool_use" && block.id && block.name) {
        toolIdToName.set(block.id, block.name);
      }
    }
  }

  const contents: any[] = [];
  for (const msg of messages) {
    const role = msg.role === "assistant" ? "model" : "user";
    const parts = anthropicContentToParts(msg.content, msg.role, toolIdToName);
    if (parts.length) contents.push({ role, parts });
  }

  let systemInstruction: any;
  if (body.system) {
    const text =
      typeof body.system === "string"
        ? body.system
        : Array.isArray(body.system)
          ? body.system
              .map((p: any) => (typeof p === "string" ? p : p?.text || ""))
              .join("\n\n")
          : "";
    if (text) systemInstruction = { role: "user", parts: [{ text }] };
  }

  const generationConfig: any = {};
  if (body.max_tokens !== undefined)
    generationConfig.maxOutputTokens = body.max_tokens;
  if (body.temperature !== undefined)
    generationConfig.temperature = body.temperature;
  if (body.top_p !== undefined) generationConfig.topP = body.top_p;
  if (body.top_k !== undefined) generationConfig.topK = body.top_k;
  if (body.stop_sequences?.length)
    generationConfig.stopSequences = body.stop_sequences;
  applyThinkingConfig(generationConfig, body.thinking);

  const tools =
    Array.isArray(body.tools) && body.tools.length
      ? convertTools(body.tools)
      : undefined;
  const toolConfig = convertToolConfig(body.tool_choice);

  return { contents, systemInstruction, tools, toolConfig, generationConfig };
}

// ── Gemini finishReason → Anthropic stop_reason ──

function mapFinishReason(reason: string | undefined, sawToolUse: boolean): string {
  if (sawToolUse) return "tool_use";
  if (reason === "MAX_TOKENS") return "max_tokens";
  if (reason === "STOP" || !reason) return "end_turn";
  // SAFETY / RECITATION / OTHER / PROHIBITED_CONTENT / …
  return "end_turn";
}

function usageFromMetadata(usage: any): {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
} {
  return {
    input_tokens: usage?.promptTokenCount || 0,
    output_tokens: usage?.candidatesTokenCount || 0,
    cache_read_input_tokens: usage?.cachedContentTokenCount || 0,
  };
}

// ── Non-streaming: Gemini CaGenerateContentResponse → Anthropic message ──

export function geminiResponseToAnthropic(caResp: any, model: string): any {
  const response = caResp?.response ?? caResp;
  const candidate = response?.candidates?.[0];
  const content: any[] = [];
  let sawToolUse = false;

  for (const part of candidate?.content?.parts || []) {
    if (part.thought) {
      if (part.text) content.push({ type: "thinking", thinking: part.text });
    } else if (typeof part.text === "string") {
      content.push({ type: "text", text: part.text });
    } else if (part.functionCall) {
      sawToolUse = true;
      const signature = part.thoughtSignature ?? part.thought_signature;
      const block: any = {
        type: "tool_use",
        id: `call_${compactUuid()}`,
        name: part.functionCall.name,
        input: part.functionCall.args || {},
      };
      // Extra field, not native Anthropic schema — round-trips only if the
      // client preserves unknown JSON keys on replay. anthropicContentToParts
      // falls back to a placeholder sentinel when it's absent, so this is a
      // best-effort optimization, not a correctness requirement.
      if (signature) block.signature = signature;
      content.push(block);
    }
  }

  return {
    id: `msg_${compactUuid()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: mapFinishReason(candidate?.finishReason, sawToolUse),
    stop_sequence: null,
    usage: usageFromMetadata(response?.usageMetadata),
  };
}

// ── Streaming: Gemini chunk stream → Anthropic Messages SSE ──

export interface GeminiStreamState {
  messageId: string;
  model: string;
  messageStartSent: boolean;
  textOpen: boolean;
  textIndex: number;
  thinkingOpen: boolean;
  thinkingIndex: number;
  nextBlockIndex: number;
  sawToolUse: boolean;
  finishReason?: string;
  usage: any;
}

export function makeGeminiStreamState(model: string): GeminiStreamState {
  return {
    messageId: `msg_${compactUuid()}`,
    model,
    messageStartSent: false,
    textOpen: false,
    textIndex: -1,
    thinkingOpen: false,
    thinkingIndex: -1,
    nextBlockIndex: 0,
    sawToolUse: false,
    usage: null,
  };
}

function sseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function ensureMessageStart(state: GeminiStreamState): string[] {
  if (state.messageStartSent) return [];
  state.messageStartSent = true;
  return [
    sseEvent("message_start", {
      type: "message_start",
      message: {
        id: state.messageId,
        type: "message",
        role: "assistant",
        content: [],
        model: state.model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }),
  ];
}

function closeThinking(state: GeminiStreamState): string[] {
  if (!state.thinkingOpen) return [];
  state.thinkingOpen = false;
  return [
    sseEvent("content_block_stop", {
      type: "content_block_stop",
      index: state.thinkingIndex,
    }),
  ];
}

function closeText(state: GeminiStreamState): string[] {
  if (!state.textOpen) return [];
  state.textOpen = false;
  return [
    sseEvent("content_block_stop", {
      type: "content_block_stop",
      index: state.textIndex,
    }),
  ];
}

/**
 * Feed one decoded Gemini streamGenerateContent chunk (the parsed
 * `CaGenerateContentResponse` — same shape as the non-streaming response)
 * and get back zero or more Anthropic Messages SSE lines.
 *
 * Each chunk's `candidates[0].content.parts` carries the INCREMENTAL text
 * produced since the previous chunk (standard Gemini streaming behaviour),
 * except `functionCall` parts which always arrive whole in a single chunk.
 */
export function geminiChunkToAnthropicSSE(
  chunk: any,
  state: GeminiStreamState,
): string[] {
  const response = chunk?.response ?? chunk;
  const candidate = response?.candidates?.[0];
  const out: string[] = [];

  if (response?.usageMetadata) {
    state.usage = usageFromMetadata(response.usageMetadata);
  }
  if (candidate?.finishReason) {
    state.finishReason = candidate.finishReason;
  }

  for (const part of candidate?.content?.parts || []) {
    if (part.thought) {
      if (!part.text) continue;
      out.push(...ensureMessageStart(state));
      out.push(...closeText(state));
      if (!state.thinkingOpen) {
        state.thinkingIndex = state.nextBlockIndex++;
        state.thinkingOpen = true;
        out.push(
          sseEvent("content_block_start", {
            type: "content_block_start",
            index: state.thinkingIndex,
            content_block: { type: "thinking", thinking: "" },
          }),
        );
      }
      out.push(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: state.thinkingIndex,
          delta: { type: "thinking_delta", thinking: part.text },
        }),
      );
      continue;
    }

    if (typeof part.text === "string") {
      out.push(...ensureMessageStart(state));
      out.push(...closeThinking(state));
      if (!state.textOpen) {
        state.textIndex = state.nextBlockIndex++;
        state.textOpen = true;
        out.push(
          sseEvent("content_block_start", {
            type: "content_block_start",
            index: state.textIndex,
            content_block: { type: "text", text: "" },
          }),
        );
      }
      out.push(
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: state.textIndex,
          delta: { type: "text_delta", text: part.text },
        }),
      );
      continue;
    }

    if (part.functionCall) {
      state.sawToolUse = true;
      out.push(...ensureMessageStart(state));
      out.push(...closeThinking(state));
      out.push(...closeText(state));
      const idx = state.nextBlockIndex++;
      const id = `call_${compactUuid()}`;
      const args = JSON.stringify(part.functionCall.args || {});
      const signature = part.thoughtSignature ?? part.thought_signature;
      out.push(
        sseEvent("content_block_start", {
          type: "content_block_start",
          index: idx,
          content_block: {
            type: "tool_use",
            id,
            name: part.functionCall.name,
            input: {},
            // Best-effort round-trip — see geminiResponseToAnthropic's
            // comment; anthropicContentToParts falls back to a placeholder
            // sentinel when the client doesn't preserve this field.
            ...(signature ? { signature } : {}),
          },
        }),
        sseEvent("content_block_delta", {
          type: "content_block_delta",
          index: idx,
          delta: { type: "input_json_delta", partial_json: args },
        }),
        sseEvent("content_block_stop", { type: "content_block_stop", index: idx }),
      );
    }
  }

  return out;
}

/**
 * Call once after the upstream stream ends to emit the closing events.
 *
 * NOTE: the full usage object (input/output/cache tokens) is attached to
 * `message_delta` here rather than split across `message_start`/`message_delta`
 * the way the real Anthropic API does — `streaming.ts`'s `extractUsageFromSSE`
 * (shared by every provider in this codebase) only reads usage off the
 * `message_delta` event, so this matches what downstream consumers expect.
 */
export function finishGeminiStream(state: GeminiStreamState): string[] {
  const out = ensureMessageStart(state);
  out.push(...closeThinking(state));
  out.push(...closeText(state));
  out.push(
    sseEvent("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: mapFinishReason(state.finishReason, state.sawToolUse),
        stop_sequence: null,
      },
      usage: {
        input_tokens: state.usage?.input_tokens || 0,
        output_tokens: state.usage?.output_tokens || 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: state.usage?.cache_read_input_tokens || 0,
      },
    }),
    sseEvent("message_stop", { type: "message_stop" }),
  );
  return out;
}
