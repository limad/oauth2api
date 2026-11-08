/**
 * Client tools over Cursor AgentService.
 *
 * The client's function tools are declared to Cursor as MCP tools
 * (AgentRunRequest.mcp_tools). When the model wants one, Cursor sends an
 * MCP exec request; we end the turn there and hand the call back to the
 * client in its own format. The proxy is stateless, so the next request
 * carries the call and its result in the history: they are replayed to
 * Cursor as text (assistant `[tool_call ...]` lines, user `<tool_result>`
 * blocks), which is what 9router does to keep Cursor from looping on
 * half-matching protobuf tool results.
 *
 * Request bodies arrive in three shapes (Chat Completions, Anthropic
 * Messages, Responses); everything here accepts all three.
 */
import {
  concatBytes,
  encodeBytesField,
  encodeVarintField,
  encodeVarint,
  parseFields,
  ProtoFieldRaw,
} from "./cursor-proto";

export interface AgentMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ClientTool {
  name: string;
  description: string;
  schema: unknown;
}

export interface CursorToolCall {
  id: string;
  name: string;
  /** JSON-encoded arguments. */
  arguments: string;
}

// ------------------------------------------------------------ messages

function partText(part: any): string {
  if (typeof part === "string") return part;
  if (!part || typeof part !== "object") return "";
  if (
    ["text", "input_text", "output_text"].includes(part.type) ||
    part.type === undefined
  ) {
    return typeof part.text === "string" ? part.text : "";
  }
  return "";
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map(partText).filter(Boolean).join("\n");
  if (content && typeof content === "object") return partText(content);
  return "";
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toolResultBlock(name: string, id: string, result: string): string {
  const clean = result.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g,
    "",
  );
  return [
    "<tool_result>",
    `<tool_name>${escapeXml(name || "tool")}</tool_name>`,
    `<tool_call_id>${escapeXml(id)}</tool_call_id>`,
    `<result>${escapeXml(clean)}</result>`,
    "</tool_result>",
  ].join("\n");
}

function toolCallLine(id: string, name: string, args: string): string {
  return `[tool_call id=${id} name=${name} args=${args || "{}"}]`;
}

function argsString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

/**
 * Flatten any of the three request shapes into system/user/assistant text,
 * tool calls and results included. Consecutive messages of the same role
 * are merged (parallel tool results become one user turn).
 */
export function agentMessagesFromBody(body: any): AgentMessage[] {
  const out: AgentMessage[] = [];
  const toolNames = new Map<string, string>();
  const push = (role: AgentMessage["role"], text: string) => {
    if (!text || !text.trim()) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += `\n\n${text}`;
    else out.push({ role, content: text });
  };
  const roleOf = (r: unknown): AgentMessage["role"] =>
    r === "assistant"
      ? "assistant"
      : r === "system" || r === "developer"
        ? "system"
        : "user";

  // Remember tool names by call id first: results only carry the id.
  const scan = (items: any[]) => {
    for (const m of items) {
      for (const tc of m?.tool_calls || []) {
        if (tc?.id) toolNames.set(tc.id, tc.function?.name || "tool");
      }
      if (Array.isArray(m?.content)) {
        for (const b of m.content)
          if (b?.type === "tool_use" && b.id)
            toolNames.set(b.id, b.name || "tool");
      }
      if (m?.type === "function_call" && m.call_id)
        toolNames.set(m.call_id, m.name || "tool");
    }
  };
  if (Array.isArray(body?.messages)) scan(body.messages);
  if (Array.isArray(body?.input)) scan(body.input);

  if (body?.system) push("system", contentText(body.system));
  if (typeof body?.instructions === "string") push("system", body.instructions);

  const pushMessage = (m: any) => {
    const role = roleOf(m?.role);
    if (m?.role === "tool") {
      const id = String(m.tool_call_id || "");
      push(
        "user",
        toolResultBlock(
          m.name || toolNames.get(id) || "tool",
          id,
          contentText(m.content),
        ),
      );
      return;
    }
    if (!Array.isArray(m?.content)) {
      const lines = [contentText(m?.content)];
      for (const tc of m?.tool_calls || []) {
        lines.push(
          toolCallLine(
            tc?.id || "",
            tc?.function?.name || "tool",
            argsString(tc?.function?.arguments),
          ),
        );
      }
      push(role, lines.filter(Boolean).join("\n"));
      return;
    }
    const lines: string[] = [];
    for (const b of m.content) {
      if (b?.type === "tool_use") {
        lines.push(
          toolCallLine(b.id || "", b.name || "tool", argsString(b.input)),
        );
      } else if (b?.type === "tool_result") {
        const id = String(b.tool_use_id || "");
        lines.push(
          toolResultBlock(
            toolNames.get(id) || "tool",
            id,
            contentText(b.content),
          ),
        );
      } else {
        const t = partText(b);
        if (t) lines.push(t);
      }
    }
    for (const tc of m?.tool_calls || []) {
      lines.push(
        toolCallLine(
          tc?.id || "",
          tc?.function?.name || "tool",
          argsString(tc?.function?.arguments),
        ),
      );
    }
    push(role, lines.join("\n"));
  };

  if (typeof body?.input === "string") push("user", body.input);
  else if (Array.isArray(body?.input)) {
    for (const item of body.input) {
      if (typeof item === "string") push("user", item);
      else if (item?.type === "function_call") {
        push(
          "assistant",
          toolCallLine(
            item.call_id || "",
            item.name || "tool",
            argsString(item.arguments),
          ),
        );
      } else if (item?.type === "function_call_output") {
        const id = String(item.call_id || "");
        const output =
          typeof item.output === "string"
            ? item.output
            : contentText(item.output);
        push("user", toolResultBlock(toolNames.get(id) || "tool", id, output));
      } else if (item?.type === "reasoning") {
        continue;
      } else pushMessage(item);
    }
  }
  if (Array.isArray(body?.messages))
    for (const m of body.messages) pushMessage(m);
  return out;
}

// --------------------------------------------------------------- tools

/** Function tools from any of the three request shapes; other tool kinds are dropped. */
export function clientToolsFromBody(body: any): ClientTool[] {
  if (!Array.isArray(body?.tools)) return [];
  const out: ClientTool[] = [];
  for (const t of body.tools) {
    const fn = t?.type === "function" && t.function ? t.function : t;
    const name = typeof fn?.name === "string" ? fn.name : "";
    const schema = fn?.parameters ?? fn?.input_schema;
    const isFunction =
      t?.type === "function" ||
      (t?.type === undefined && schema) ||
      (t?.type === "custom" && schema);
    if (!name || !isFunction) continue;
    out.push({
      name,
      description: typeof fn.description === "string" ? fn.description : "",
      schema: schema ?? { type: "object", properties: {} },
    });
  }
  return out;
}

/** google.protobuf.Value */
export function encodeProtoValue(value: unknown): Uint8Array {
  if (value === null || value === undefined) return encodeVarintField(1, 0);
  if (typeof value === "boolean") return encodeVarintField(4, value ? 1 : 0);
  if (typeof value === "number") {
    const d = new Uint8Array(8);
    new DataView(d.buffer).setFloat64(0, value, true);
    return concatBytes([encodeVarint((2 << 3) | 1), d]);
  }
  if (typeof value === "string") return encodeBytesField(3, value);
  if (Array.isArray(value)) {
    return encodeBytesField(
      6,
      concatBytes(value.map((v) => encodeBytesField(1, encodeProtoValue(v)))),
    );
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).map(
      ([k, v]) =>
        encodeBytesField(
          1,
          concatBytes([
            encodeBytesField(1, k),
            encodeBytesField(2, encodeProtoValue(v)),
          ]),
        ),
    );
    return encodeBytesField(5, concatBytes(entries));
  }
  return encodeBytesField(3, String(value));
}

const first = (f: ProtoFieldRaw[], n: number) => f.find((x) => x.field === n);
const str = (f: ProtoFieldRaw[], n: number) => {
  const b = f.find((x) => x.field === n && x.wireType === 2)?.bytes;
  return b ? Buffer.from(b).toString("utf8") : "";
};

export function decodeProtoValue(bytes: Uint8Array): unknown {
  const f = parseFields(bytes);
  if (first(f, 1)) return null;
  const n = first(f, 2);
  if (n?.bytes && n.bytes.length === 8) {
    return new DataView(n.bytes.buffer, n.bytes.byteOffset, 8).getFloat64(
      0,
      true,
    );
  }
  if (first(f, 3)) return str(f, 3);
  const b = first(f, 4);
  if (b) return (b.varint || 0) !== 0;
  const st = first(f, 5);
  if (st?.bytes) {
    const obj: Record<string, unknown> = {};
    for (const e of parseFields(st.bytes)) {
      if (e.field !== 1 || !e.bytes) continue;
      const pair = parseFields(e.bytes);
      const key = str(pair, 1);
      const val = pair.find((x) => x.field === 2 && x.wireType === 2)?.bytes;
      if (key) obj[key] = val ? decodeProtoValue(val) : null;
    }
    return obj;
  }
  const list = first(f, 6);
  if (list?.bytes) {
    return parseFields(list.bytes)
      .filter((e) => e.field === 1 && e.bytes)
      .map((e) => decodeProtoValue(e.bytes!));
  }
  return null;
}

/** AgentRunRequest.mcp_tools: McpTools { repeated McpToolDefinition = 1 }. */
export function encodeMcpTools(tools: ClientTool[]): Uint8Array {
  return concatBytes(
    tools.map((t) =>
      encodeBytesField(
        1,
        concatBytes([
          encodeBytesField(1, t.name),
          encodeBytesField(2, t.description),
          encodeBytesField(3, encodeProtoValue(t.schema)),
          encodeBytesField(4, "oauth2api"),
          encodeBytesField(5, t.name),
        ]),
      ),
    ),
  );
}

/** McpArgs { name = 1; map<string, Value bytes> args = 2; tool_call_id = 3; tool_name = 5 }. */
export function decodeMcpCall(bytes: Uint8Array): CursorToolCall | null {
  const f = parseFields(bytes);
  const name = str(f, 5) || str(f, 1);
  if (!name) return null;
  const args: Record<string, unknown> = {};
  for (const e of f) {
    if (e.field !== 2 || !e.bytes) continue;
    const pair = parseFields(e.bytes);
    const key = str(pair, 1);
    const val = pair.find((x) => x.field === 2 && x.wireType === 2)?.bytes;
    if (key) args[key] = val ? decodeProtoValue(val) : null;
  }
  return { id: str(f, 3), name, arguments: JSON.stringify(args) };
}
