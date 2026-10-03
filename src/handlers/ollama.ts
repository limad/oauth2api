import express, { Request, Response } from "express";
import { randomBytes } from "crypto";
import { extractApiKey } from "../utils/common";

// Ollama-native API facade (/api/*) translated onto the local OpenAI-compatible
// /v1 endpoints. The translation is done by calling our own /v1 over the very
// socket the client connected on, so every provider keeps working unchanged.

export const INTERNAL_SECRET = randomBytes(16).toString("hex");
export const INTERNAL_HEADER = "x-auth2api-internal";

const OLLAMA_VERSION = "0.6.0";

function nowIso(): string {
  return new Date().toISOString();
}

function modelDetails(id: string) {
  return {
    parent_model: "",
    format: "",
    family: id.split("-")[0] || "",
    families: null,
    parameter_size: "",
    quantization_level: "",
  };
}

function baseUrl(req: Request): string {
  const addr = req.socket.localAddress || "127.0.0.1";
  const host = addr.includes(":") ? `[${addr}]` : addr;
  return `http://${host}:${req.socket.localPort}`;
}

function internalHeaders(req: Request): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${extractApiKey(req.headers)}`,
    [INTERNAL_HEADER]: INTERNAL_SECRET,
  };
}

function ollamaError(res: Response, status: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(status).json({ error: message });
}

async function upstreamErrorMessage(r: globalThis.Response): Promise<string> {
  try {
    const j: any = await r.json();
    return j?.error?.message || j?.error || `upstream error ${r.status}`;
  } catch {
    return `upstream error ${r.status}`;
  }
}

// ---- request translation -------------------------------------------------

function toOpenAIMessages(messages: any[]): any[] {
  const out: any[] = [];
  const pendingIds: string[] = [];
  let seq = 0;
  for (const m of messages) {
    const role = m.role;
    if (role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: pendingIds.shift() || `call_${seq++}`,
        content:
          typeof m.content === "string"
            ? m.content
            : JSON.stringify(m.content ?? ""),
      });
      continue;
    }
    const msg: any = { role };
    const images: string[] = Array.isArray(m.images) ? m.images : [];
    if (images.length > 0) {
      msg.content = [
        { type: "text", text: m.content || "" },
        ...images.map((b64) => ({
          type: "image_url",
          image_url: {
            url: b64.startsWith("data:")
              ? b64
              : `data:image/jpeg;base64,${b64}`,
          },
        })),
      ];
    } else {
      msg.content = m.content ?? "";
    }
    if (role === "assistant" && Array.isArray(m.tool_calls)) {
      msg.tool_calls = m.tool_calls.map((tc: any) => {
        const id = tc.id || `call_${seq++}`;
        pendingIds.push(id);
        const args = tc.function?.arguments;
        return {
          id,
          type: "function",
          function: {
            name: tc.function?.name,
            arguments:
              typeof args === "string" ? args : JSON.stringify(args ?? {}),
          },
        };
      });
    }
    out.push(msg);
  }
  return out;
}

function toOpenAIBody(
  model: string,
  messages: any[],
  stream: boolean,
  b: any,
): any {
  const body: any = { model, messages: toOpenAIMessages(messages), stream };
  const o = b.options || {};
  if (typeof o.temperature === "number") body.temperature = o.temperature;
  if (typeof o.top_p === "number") body.top_p = o.top_p;
  if (typeof o.num_predict === "number" && o.num_predict > 0) {
    body.max_tokens = o.num_predict;
  }
  if (o.stop) body.stop = o.stop;
  if (Array.isArray(b.tools) && b.tools.length > 0) body.tools = b.tools;
  if (b.format === "json") {
    body.response_format = { type: "json_object" };
  } else if (b.format && typeof b.format === "object") {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: "output", schema: b.format },
    };
  }
  if (stream) body.stream_options = { include_usage: true };
  return body;
}

function fromOpenAIToolCalls(calls: any[]): any[] {
  return calls.map((tc, i) => {
    let args: any = {};
    try {
      args = JSON.parse(tc.function?.arguments || "{}");
    } catch {
      args = {};
    }
    return { function: { index: i, name: tc.function?.name, arguments: args } };
  });
}

// ---- shared chat/generate engine ----------------------------------------

interface Shape {
  chunk(text: string): any;
  final(
    text: string,
    toolCalls: any[],
    reason: string,
    usage: any,
    ms: number,
  ): any;
}

async function run(
  req: Request,
  res: Response,
  model: string,
  messages: any[],
  stream: boolean,
  b: any,
  shape: Shape,
): Promise<void> {
  const startedAt = Date.now();
  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });

  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${baseUrl(req)}/v1/chat/completions`, {
      method: "POST",
      headers: internalHeaders(req),
      body: JSON.stringify(toOpenAIBody(model, messages, stream, b)),
      signal: ac.signal,
    });
  } catch (err: any) {
    ollamaError(res, 502, `upstream unreachable: ${err.message}`);
    return;
  }
  if (!upstream.ok) {
    ollamaError(res, upstream.status, await upstreamErrorMessage(upstream));
    return;
  }

  if (!stream) {
    const data: any = await upstream.json();
    const choice = data.choices?.[0] || {};
    const toolCalls = fromOpenAIToolCalls(choice.message?.tool_calls || []);
    res.json(
      shape.final(
        choice.message?.content || "",
        toolCalls,
        choice.finish_reason === "length" ? "length" : "stop",
        data.usage,
        Date.now() - startedAt,
      ),
    );
    return;
  }

  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders?.();

  const decoder = new TextDecoder();
  let buf = "";
  let reason = "stop";
  let usage: any = null;
  const tcAcc = new Map<number, { name: string; args: string }>();

  const handleLine = (line: string) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    let j: any;
    try {
      j = JSON.parse(payload);
    } catch {
      return;
    }
    if (j.usage) usage = j.usage;
    const c = j.choices?.[0];
    if (!c) return;
    const delta = c.delta || {};
    if (typeof delta.content === "string" && delta.content !== "") {
      res.write(JSON.stringify(shape.chunk(delta.content)) + "\n");
    }
    for (const tc of delta.tool_calls || []) {
      const cur = tcAcc.get(tc.index ?? 0) || { name: "", args: "" };
      if (tc.function?.name) cur.name = tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      tcAcc.set(tc.index ?? 0, cur);
    }
    if (c.finish_reason) {
      reason = c.finish_reason === "length" ? "length" : "stop";
    }
  };

  try {
    const reader = upstream.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        handleLine(buf.slice(0, nl).trimEnd());
        buf = buf.slice(nl + 1);
      }
    }
    if (buf.trim()) handleLine(buf.trim());
  } catch {
    res.end();
    return;
  }

  const toolCalls = fromOpenAIToolCalls(
    [...tcAcc.entries()]
      .sort((x, y) => x[0] - y[0])
      .map(([, v]) => ({ function: { name: v.name, arguments: v.args } })),
  );
  res.write(
    JSON.stringify(
      shape.final("", toolCalls, reason, usage, Date.now() - startedAt),
    ) + "\n",
  );
  res.end();
}

function stats(usage: any, ms: number) {
  return {
    total_duration: ms * 1e6,
    load_duration: 0,
    prompt_eval_count: usage?.prompt_tokens ?? 0,
    eval_count: usage?.completion_tokens ?? 0,
    eval_duration: ms * 1e6,
  };
}

// ---- router -------------------------------------------------------------

export function createOllamaRouter(): express.Router {
  const router = express.Router();

  router.get("/version", (_req, res) => {
    res.json({ version: OLLAMA_VERSION });
  });

  router.get("/tags", async (req, res) => {
    try {
      const r = await fetch(`${baseUrl(req)}/v1/models`, {
        headers: internalHeaders(req),
      });
      if (!r.ok) {
        return ollamaError(res, r.status, await upstreamErrorMessage(r));
      }
      const j: any = await r.json();
      const models = (j.data || []).map((m: any) => ({
        name: m.id,
        model: m.id,
        modified_at: new Date((m.created || 0) * 1000).toISOString(),
        size: 0,
        digest: "",
        details: modelDetails(m.id),
      }));
      res.json({ models });
    } catch (err: any) {
      ollamaError(res, 502, err.message);
    }
  });

  router.post("/show", (req, res) => {
    const id = req.body?.model || req.body?.name;
    if (!id) return ollamaError(res, 400, "model is required");
    res.json({
      modelfile: "",
      parameters: "",
      template: "",
      details: modelDetails(id),
      model_info: {},
      capabilities: ["completion", "tools", "vision"],
    });
  });

  router.post("/chat", async (req, res) => {
    const b = req.body || {};
    if (!b.model) return ollamaError(res, 400, "model is required");
    if (!Array.isArray(b.messages) || b.messages.length === 0) {
      return ollamaError(res, 400, "messages is required");
    }
    const model = b.model;
    const msg = (content: string, toolCalls?: any[]) => ({
      role: "assistant",
      content,
      ...(toolCalls && toolCalls.length ? { tool_calls: toolCalls } : {}),
    });
    await run(req, res, model, b.messages, b.stream !== false, b, {
      chunk: (t) => ({
        model,
        created_at: nowIso(),
        message: msg(t),
        done: false,
      }),
      final: (t, tc, reason, usage, ms) => ({
        model,
        created_at: nowIso(),
        message: msg(t, tc),
        done: true,
        done_reason: reason,
        ...stats(usage, ms),
      }),
    });
  });

  router.post("/generate", async (req, res) => {
    const b = req.body || {};
    if (!b.model) return ollamaError(res, 400, "model is required");
    if (typeof b.prompt !== "string") {
      return ollamaError(res, 400, "prompt is required");
    }
    const model = b.model;
    const messages: any[] = [];
    if (b.system) messages.push({ role: "system", content: b.system });
    messages.push({ role: "user", content: b.prompt, images: b.images });
    await run(req, res, model, messages, b.stream !== false, b, {
      chunk: (t) => ({ model, created_at: nowIso(), response: t, done: false }),
      final: (t, _tc, reason, usage, ms) => ({
        model,
        created_at: nowIso(),
        response: t,
        done: true,
        done_reason: reason,
        ...stats(usage, ms),
      }),
    });
  });

  router.use((_req, res) => {
    ollamaError(res, 501, "endpoint not supported by auth2api");
  });

  return router;
}
