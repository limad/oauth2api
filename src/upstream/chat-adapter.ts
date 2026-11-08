/**
 * Anthropic Messages <-> OpenAI Chat Completions, for providers whose upstream
 * only speaks Chat Completions (Mistral, Copilot).
 *
 * With it, those providers look Anthropic-native to the handlers: /v1/messages
 * calls them directly, and /v1/responses goes through the existing
 * Responses <-> Anthropic translation, then here. Nothing is added to the
 * prompt: system, messages, tools and tool results are carried over as is.
 * Thinking blocks of earlier turns are dropped (Chat Completions has no field
 * for them); reasoning returned by the model (`reasoning_content`) comes back
 * as a thinking block.
 */

export class ChatAdapterError extends Error {}

function compactId(): string {
  return Math.random().toString(36).slice(2, 14) + Date.now().toString(36);
}

function imageUrl(source: any): string | null {
  if (source?.type === "base64" && source.data) {
    return `data:${source.media_type || "image/png"};base64,${source.data}`;
  }
  if (source?.type === "url" && source.url) return source.url;
  return null;
}

function textOf(blocks: any): string {
  if (typeof blocks === "string") return blocks;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("");
}

/** User-side blocks (text, image) -> Chat content: a plain string when there is only text. */
function userContent(blocks: any[]): any {
  const parts: any[] = [];
  for (const b of blocks) {
    if (b?.type === "text") {
      if (b.text) parts.push({ type: "text", text: b.text });
    } else if (b?.type === "image") {
      const url = imageUrl(b.source);
      if (!url) throw new ChatAdapterError("image block without a usable source");
      parts.push({ type: "image_url", image_url: { url } });
    } else if (b?.type === "document") {
      throw new ChatAdapterError(
        "document blocks are not supported by this provider (Chat Completions only)",
      );
    }
    // thinking / redacted_thinking / server tool blocks: not representable, dropped.
  }
  if (parts.length > 0 && parts.every((p) => p.type === "text")) {
    return parts.map((p) => p.text).join("\n\n");
  }
  return parts;
}

function toolChoice(tc: any): any {
  if (!tc || typeof tc !== "object") return undefined;
  if (tc.type === "auto") return "auto";
  if (tc.type === "any") return "required";
  if (tc.type === "none") return "none";
  if (tc.type === "tool" && tc.name) return { type: "function", function: { name: tc.name } };
  return undefined;
}

/** Anthropic Messages request -> Chat Completions request. */
export function anthropicToChatRequest(body: any): any {
  const messages: any[] = [];
  const system =
    typeof body?.system === "string" ? body.system : textOf(body?.system);
  if (system) messages.push({ role: "system", content: system });

  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (typeof m?.content === "string") {
      messages.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
      continue;
    }
    const blocks: any[] = Array.isArray(m?.content) ? m.content : [];
    if (m?.role === "assistant") {
      const text = textOf(blocks);
      const toolCalls = blocks
        .filter((b) => b?.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        }));
      if (!text && toolCalls.length === 0) continue;
      messages.push({
        role: "assistant",
        content: text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    // User turn: tool results first (they must follow the assistant tool calls),
    // then the rest of the turn as one user message. Images returned by a tool
    // go into that user message (tool messages carry text only).
    const rest: any[] = [];
    for (const b of blocks) {
      if (b?.type !== "tool_result") {
        rest.push(b);
        continue;
      }
      const inner = typeof b.content === "string" ? [{ type: "text", text: b.content }] : Array.isArray(b.content) ? b.content : [];
      let text = textOf(inner);
      if (b.is_error) text = text ? `Error: ${text}` : "Error";
      messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: text });
      rest.push(...inner.filter((c: any) => c?.type === "image" || c?.type === "document"));
    }
    if (rest.length) {
      const content = userContent(rest);
      if (content && (typeof content === "string" || content.length)) {
        messages.push({ role: "user", content });
      }
    }
  }

  const out: any = { model: body?.model, messages };
  const tools = (Array.isArray(body?.tools) ? body.tools : [])
    // Server tools (web_search_20250305...) have no Chat Completions equivalent.
    .filter((t: any) => t?.name && (t.input_schema || !t.type || t.type === "custom"))
    .map((t: any) => ({
      type: "function",
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.input_schema || { type: "object", properties: {} },
      },
    }));
  if (tools.length) {
    out.tools = tools;
    const tc = toolChoice(body?.tool_choice);
    if (tc !== undefined) out.tool_choice = tc;
    if (body?.tool_choice?.disable_parallel_tool_use) out.parallel_tool_calls = false;
  }
  if (body?.max_tokens !== undefined) out.max_tokens = body.max_tokens;
  if (body?.temperature !== undefined) out.temperature = body.temperature;
  if (body?.top_p !== undefined) out.top_p = body.top_p;
  if (Array.isArray(body?.stop_sequences) && body.stop_sequences.length) out.stop = body.stop_sequences;
  if (body?.stream) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

function stopReason(finish: string | null | undefined, hasTools: boolean): string {
  if (finish === "length") return "max_tokens";
  if (finish === "tool_calls" || finish === "function_call" || (hasTools && finish !== "stop")) return "tool_use";
  return "end_turn";
}

/** Chat usage -> Anthropic usage (input without the cached part, like the Anthropic API). */
export function chatUsageToAnthropic(u: any): any {
  const cached = u?.prompt_tokens_details?.cached_tokens || 0;
  return {
    input_tokens: Math.max(0, (u?.prompt_tokens || 0) - cached),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    output_tokens: u?.completion_tokens || 0,
  };
}

function parseArgs(args: unknown): any {
  if (args && typeof args === "object") return args;
  try {
    return JSON.parse(String(args || "{}"));
  } catch {
    return {};
  }
}

/** Chat Completions response -> Anthropic message. */
export function chatToAnthropicMessage(json: any, model: string): any {
  const msg = json?.choices?.[0]?.message || {};
  const content: any[] = [];
  const reasoning = msg.reasoning_content || msg.reasoning;
  if (typeof reasoning === "string" && reasoning) {
    content.push({ type: "thinking", thinking: reasoning, signature: "" });
  }
  const text = typeof msg.content === "string" ? msg.content : textOf(msg.content);
  if (text) content.push({ type: "text", text });
  for (const tc of Array.isArray(msg.tool_calls) ? msg.tool_calls : []) {
    content.push({
      type: "tool_use",
      id: tc.id || `toolu_${compactId()}`,
      name: tc.function?.name,
      input: parseArgs(tc.function?.arguments),
    });
  }
  return {
    id: `msg_${json?.id || compactId()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReason(json?.choices?.[0]?.finish_reason, content.some((b) => b.type === "tool_use")),
    stop_sequence: null,
    usage: chatUsageToAnthropic(json?.usage),
  };
}

function sse(type: string, data: any): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

/** Chat Completions SSE byte stream -> Anthropic Messages SSE byte stream. */
export function chatSseToAnthropicSse(model: string): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let started = false;
  let finished = false;
  let index = -1;
  let open: { kind: "text" | "thinking" | "tool"; key?: number } | null = null;
  const toolIndex = new Map<number, number>();
  let finish: string | null = null;
  let usage: any = null;
  let sawTool = false;

  const start = (out: string[], id?: string) => {
    if (started) return;
    started = true;
    out.push(
      sse("message_start", {
        message: {
          id: `msg_${id || compactId()}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    );
  };
  const close = (out: string[]) => {
    if (open) out.push(sse("content_block_stop", { index }));
    open = null;
  };
  const end = (out: string[]) => {
    if (finished) return;
    finished = true;
    start(out);
    close(out);
    out.push(
      sse("message_delta", {
        delta: { stop_reason: stopReason(finish, sawTool), stop_sequence: null },
        usage: chatUsageToAnthropic(usage),
      }),
    );
    out.push(sse("message_stop", {}));
  };

  const handle = (json: any, out: string[]) => {
    if (json?.error) {
      start(out);
      close(out);
      finished = true;
      out.push(
        sse("error", {
          error: { type: "api_error", message: String(json.error?.message || json.error) },
        }),
      );
      return;
    }
    start(out, json?.id);
    if (json?.usage) usage = json.usage;
    const choice = json?.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};
    const reasoning = delta.reasoning_content || delta.reasoning;
    if (typeof reasoning === "string" && reasoning) {
      if (open?.kind !== "thinking") {
        close(out);
        index++;
        open = { kind: "thinking" };
        out.push(sse("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } }));
      }
      out.push(sse("content_block_delta", { index, delta: { type: "thinking_delta", thinking: reasoning } }));
    }
    const text = typeof delta.content === "string" ? delta.content : textOf(delta.content);
    if (text) {
      if (open?.kind !== "text") {
        close(out);
        index++;
        open = { kind: "text" };
        out.push(sse("content_block_start", { index, content_block: { type: "text", text: "" } }));
      }
      out.push(sse("content_block_delta", { index, delta: { type: "text_delta", text } }));
    }
    for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const key = typeof tc.index === "number" ? tc.index : toolIndex.size;
      if (!toolIndex.has(key)) {
        close(out);
        index++;
        toolIndex.set(key, index);
        open = { kind: "tool", key };
        sawTool = true;
        out.push(
          sse("content_block_start", {
            index,
            content_block: { type: "tool_use", id: tc.id || `toolu_${compactId()}`, name: tc.function?.name || "", input: {} },
          }),
        );
      }
      const args = tc.function?.arguments;
      if (typeof args === "string" && args) {
        out.push(sse("content_block_delta", { index: toolIndex.get(key), delta: { type: "input_json_delta", partial_json: args } }));
      }
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  };

  const lines = (chunk: string, out: string[]) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      if (data === "[DONE]") {
        end(out);
        continue;
      }
      try {
        handle(JSON.parse(data), out);
      } catch {
        /* partial or foreign line: ignored */
      }
    }
  };

  return new TransformStream({
    transform(chunk, controller) {
      const out: string[] = [];
      lines(decoder.decode(chunk, { stream: true }), out);
      if (out.length) controller.enqueue(encoder.encode(out.join("")));
    },
    flush(controller) {
      const out: string[] = [];
      lines(decoder.decode() + "\n", out);
      end(out);
      controller.enqueue(encoder.encode(out.join("")));
    },
  });
}

/**
 * Wraps a Chat Completions call so it takes an Anthropic body and answers in
 * Anthropic format. Non-2xx upstream answers are returned untouched so retry,
 * cooldown and error pass-through keep working as for every provider.
 */
export async function callChatAsAnthropic(
  body: any,
  callChat: (chatBody: any) => Promise<Response>,
): Promise<Response> {
  let chatBody: any;
  try {
    chatBody = anthropicToChatRequest(body);
  } catch (err: any) {
    if (err instanceof ChatAdapterError) {
      return new Response(
        JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: err.message } }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    throw err;
  }
  const upstream = await callChat(chatBody);
  if (!upstream.ok) return upstream;
  const model = String(body?.model || "");
  const headers = new Headers(upstream.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  if (chatBody.stream && upstream.body) {
    headers.set("Content-Type", "text/event-stream");
    return new Response(upstream.body.pipeThrough(chatSseToAnthropicSse(model)), {
      status: upstream.status,
      headers,
    });
  }
  const text = await upstream.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    return new Response(text, { status: 502, headers });
  }
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(chatToAnthropicMessage(json, model)), {
    status: upstream.status,
    headers,
  });
}
