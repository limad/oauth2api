/**
 * Gemini API (generateContent) <-> Anthropic Messages, for the /v1beta facade.
 *
 * Gemini-native clients (Google GenAI SDKs, Gemini CLI with a custom base URL)
 * reach every provider this way: the request becomes an Anthropic Messages
 * body sent to our own /v1/messages, and the answer is turned back into the
 * Gemini shape. Nothing is added to the prompt.
 */

export class GeminiNativeError extends Error {}

/** Gemini schemas may use upper-case types ("OBJECT", "STRING"): JSON Schema wants lower case. */
function normalizeSchema(schema: any): any {
  if (Array.isArray(schema)) return schema.map(normalizeSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: any = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === "type" && typeof v === "string") out.type = v.toLowerCase();
    else if (k === "properties" && v && typeof v === "object" && !Array.isArray(v)) {
      out.properties = Object.fromEntries(Object.entries(v).map(([n, s]) => [n, normalizeSchema(s)]));
    } else out[k] = normalizeSchema(v);
  }
  return out;
}

function textOfParts(parts: any): string {
  if (typeof parts === "string") return parts;
  const list = Array.isArray(parts) ? parts : Array.isArray(parts?.parts) ? parts.parts : [];
  return list
    .filter((p: any) => typeof p?.text === "string" && !p.thought)
    .map((p: any) => p.text)
    .join("");
}

function mediaBlock(mime: string, source: any): any {
  if (mime.startsWith("image/")) return { type: "image", source };
  if (mime === "application/pdf") return { type: "document", source };
  throw new GeminiNativeError(`${mime} content is not supported through the Gemini facade`);
}

function toolChoice(cfg: any): any {
  const mode = String(cfg?.mode || "").toUpperCase();
  const names: string[] = Array.isArray(cfg?.allowedFunctionNames) ? cfg.allowedFunctionNames : [];
  if (mode === "NONE") return { type: "none" };
  if (mode === "ANY" || mode === "VALIDATED") {
    return names.length === 1 ? { type: "tool", name: names[0] } : { type: "any" };
  }
  if (mode === "AUTO") return { type: "auto" };
  return undefined;
}

/** Gemini generateContent request -> Anthropic Messages body. */
export function geminiToAnthropicRequest(model: string, body: any, stream: boolean): any {
  const messages: any[] = [];
  // Gemini correlates function responses by name (ids are optional): remember
  // the ids handed out per name so each response finds its call.
  const pending = new Map<string, string[]>();
  let seq = 0;

  for (const c of Array.isArray(body?.contents) ? body.contents : []) {
    const role = c?.role === "model" ? "assistant" : "user";
    const blocks: any[] = [];
    for (const p of Array.isArray(c?.parts) ? c.parts : []) {
      if (typeof p?.text === "string") {
        if (!p.thought && p.text) blocks.push({ type: "text", text: p.text });
      } else if (p?.inlineData) {
        const mime = String(p.inlineData.mimeType || "");
        blocks.push(mediaBlock(mime, { type: "base64", media_type: mime, data: p.inlineData.data }));
      } else if (p?.fileData) {
        const mime = String(p.fileData.mimeType || "");
        const uri = String(p.fileData.fileUri || "");
        if (!/^https?:\/\//.test(uri)) {
          throw new GeminiNativeError("fileData must be an http(s) URL through the Gemini facade");
        }
        blocks.push(mediaBlock(mime || "image/*", { type: "url", url: uri }));
      } else if (p?.functionCall) {
        const name = String(p.functionCall.name || "");
        const id = String(p.functionCall.id || `call_${++seq}_${name}`);
        pending.set(name, [...(pending.get(name) || []), id]);
        blocks.push({ type: "tool_use", id, name, input: p.functionCall.args || {} });
      } else if (p?.functionResponse) {
        const name = String(p.functionResponse.name || "");
        const queue = pending.get(name) || [];
        let id = p.functionResponse.id ? String(p.functionResponse.id) : queue[0];
        const at = id ? queue.indexOf(id) : -1;
        if (at >= 0) queue.splice(at, 1);
        if (!id) id = `call_${++seq}_${name}`;
        const resp = p.functionResponse.response ?? {};
        const content =
          typeof resp?.output === "string" && Object.keys(resp).length === 1
            ? resp.output
            : typeof resp === "string"
              ? resp
              : JSON.stringify(resp);
        blocks.push({
          type: "tool_result",
          tool_use_id: id,
          content,
          ...(resp && typeof resp === "object" && "error" in resp ? { is_error: true } : {}),
        });
      }
      // executableCode / codeExecutionResult / thought signatures: no Anthropic equivalent.
    }
    if (!blocks.length) continue;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  }
  // Anthropic wants the tool results at the start of the user turn.
  for (const m of messages) {
    if (m.role === "user") {
      m.content.sort((a: any, b: any) => Number(b.type === "tool_result") - Number(a.type === "tool_result"));
    }
  }

  const gc = body?.generationConfig || {};
  const out: any = {
    model,
    max_tokens: gc.maxOutputTokens ?? 8192,
    messages,
    ...(stream ? { stream: true } : {}),
  };
  const system = textOfParts(body?.systemInstruction);
  if (system) out.system = system;
  if (gc.temperature !== undefined) out.temperature = gc.temperature;
  if (gc.topP !== undefined) out.top_p = gc.topP;
  if (gc.topK !== undefined) out.top_k = gc.topK;
  if (Array.isArray(gc.stopSequences) && gc.stopSequences.length) out.stop_sequences = gc.stopSequences;

  const tools: any[] = [];
  for (const t of Array.isArray(body?.tools) ? body.tools : []) {
    for (const f of Array.isArray(t?.functionDeclarations) ? t.functionDeclarations : []) {
      tools.push({
        name: f.name,
        ...(f.description ? { description: f.description } : {}),
        input_schema: normalizeSchema(f.parametersJsonSchema || f.parameters || { type: "object", properties: {} }),
      });
    }
    // googleSearch / codeExecution / urlContext: Google-only tools, not carried over.
  }
  if (tools.length) {
    out.tools = tools;
    const tc = toolChoice(body?.toolConfig?.functionCallingConfig);
    if (tc) out.tool_choice = tc;
  }
  return out;
}

function finishReason(stop: string | null | undefined): string {
  if (stop === "max_tokens") return "MAX_TOKENS";
  if (stop === "refusal") return "SAFETY";
  return "STOP";
}

/** Anthropic usage -> Gemini usageMetadata (promptTokenCount includes the cached part, like Gemini). */
export function anthropicUsageToGemini(u: any): any {
  const cached = (u?.cache_read_input_tokens || 0) + (u?.cache_creation_input_tokens || 0);
  const prompt = (u?.input_tokens || 0) + cached;
  const out = u?.output_tokens || 0;
  return {
    promptTokenCount: prompt,
    candidatesTokenCount: out,
    totalTokenCount: prompt + out,
    ...(u?.cache_read_input_tokens ? { cachedContentTokenCount: u.cache_read_input_tokens } : {}),
  };
}

function partOf(block: any): any | null {
  if (block?.type === "text" && block.text) return { text: block.text };
  if (block?.type === "thinking" && block.thinking) return { text: block.thinking, thought: true };
  if (block?.type === "tool_use") {
    return { functionCall: { id: block.id, name: block.name, args: block.input || {} } };
  }
  return null;
}

/** Anthropic message -> Gemini generateContent response. */
export function anthropicToGeminiResponse(msg: any, model: string): any {
  const parts = (Array.isArray(msg?.content) ? msg.content : []).map(partOf).filter(Boolean);
  return {
    candidates: [
      {
        content: { role: "model", parts: parts.length ? parts : [{ text: "" }] },
        finishReason: finishReason(msg?.stop_reason),
        index: 0,
      },
    ],
    usageMetadata: anthropicUsageToGemini(msg?.usage),
    modelVersion: model,
    responseId: msg?.id,
  };
}

/** HTTP status -> Google error status name. */
export function googleStatus(code: number): string {
  if (code === 400) return "INVALID_ARGUMENT";
  if (code === 401) return "UNAUTHENTICATED";
  if (code === 403) return "PERMISSION_DENIED";
  if (code === 404) return "NOT_FOUND";
  if (code === 429) return "RESOURCE_EXHAUSTED";
  if (code === 503 || code === 529) return "UNAVAILABLE";
  if (code === 504) return "DEADLINE_EXCEEDED";
  return "INTERNAL";
}

export function googleError(code: number, message: string): any {
  return { error: { code, message, status: googleStatus(code) } };
}

/**
 * Anthropic SSE events -> Gemini stream chunks. Feed every event to `push`,
 * which returns the chunks to send (text and thoughts as they come, a
 * function call once its arguments are complete, a last chunk with the finish
 * reason and usage).
 */
export function makeGeminiStreamConverter(model: string) {
  let usage: any = {};
  let stop: string | null = null;
  let id: string | undefined;
  let tool: { id: string; name: string; json: string } | null = null;
  let done = false;
  const chunk = (parts: any[], extra: any = {}) => ({
    candidates: [{ content: { role: "model", parts }, index: 0, ...extra }],
    modelVersion: model,
    ...(id ? { responseId: id } : {}),
  });
  const final = () => {
    done = true;
    return {
      ...chunk([{ text: "" }], { finishReason: finishReason(stop) }),
      usageMetadata: anthropicUsageToGemini(usage),
    };
  };
  return {
    push(event: string, data: any): any[] {
      if (done) return [];
      const type = data?.type || event;
      if (type === "message_start") {
        id = data?.message?.id;
        usage = { ...usage, ...(data?.message?.usage || {}) };
      } else if (type === "content_block_start" && data?.content_block?.type === "tool_use") {
        tool = { id: data.content_block.id, name: data.content_block.name, json: "" };
      } else if (type === "content_block_delta") {
        const d = data?.delta || {};
        if (d.type === "text_delta" && d.text) return [chunk([{ text: d.text }])];
        if (d.type === "thinking_delta" && d.thinking) return [chunk([{ text: d.thinking, thought: true }])];
        if (d.type === "input_json_delta" && tool) tool.json += d.partial_json || "";
      } else if (type === "content_block_stop" && tool) {
        let args: any = {};
        try {
          args = tool.json ? JSON.parse(tool.json) : {};
        } catch {
          /* keep {} */
        }
        const out = chunk([{ functionCall: { id: tool.id, name: tool.name, args } }]);
        tool = null;
        return [out];
      } else if (type === "message_delta") {
        if (data?.delta?.stop_reason) stop = data.delta.stop_reason;
        usage = { ...usage, ...(data?.usage || {}) };
      } else if (type === "message_stop") {
        return [final()];
      } else if (type === "error") {
        done = true;
        return [googleError(500, String(data?.error?.message || "upstream error"))];
      }
      return [];
    },
    /** Last chunk if the stream ended without message_stop. */
    end(): any[] {
      return done ? [] : [final()];
    },
  };
}
