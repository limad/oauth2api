import express, { Request, Response } from "express";
import { extractApiKey } from "../utils/common";
import { readSseEvents } from "../upstream/streaming";
import {
  GeminiNativeError,
  anthropicToGeminiResponse,
  geminiToAnthropicRequest,
  googleError,
  makeGeminiStreamConverter,
} from "../upstream/gemini-native";
import { INTERNAL_HEADER, INTERNAL_SECRET } from "./ollama";

// Gemini API facade (/v1beta/models/<model>:generateContent ...), translated
// onto our own /v1/messages over the socket the client connected on (same
// approach as the Ollama facade), so every provider keeps working unchanged.

function baseUrl(req: Request): string {
  const addr = req.socket.localAddress || "127.0.0.1";
  const host = addr.includes(":") ? `[${addr}]` : addr;
  return `http://${host}:${req.socket.localPort}`;
}

function internalHeaders(req: Request): Record<string, string> {
  return {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    authorization: `Bearer ${extractApiKey(req.headers)}`,
    [INTERNAL_HEADER]: INTERNAL_SECRET,
    ...(typeof req.headers["user-agent"] === "string" ? { "user-agent": req.headers["user-agent"] } : {}),
  };
}

/** Gemini clients send their key as `x-goog-api-key` or `?key=`: expose it where requireApiKey looks. */
export const geminiApiKeyHeader: express.RequestHandler = (req, _res, next) => {
  if (!req.headers.authorization && !req.headers["x-api-key"]) {
    const goog = req.headers["x-goog-api-key"];
    const key = typeof goog === "string" ? goog : typeof req.query.key === "string" ? req.query.key : "";
    if (key) req.headers["x-api-key"] = key;
  }
  next();
};

function sendError(res: Response, code: number, message: string): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(code).json(googleError(code, message));
}

async function upstreamMessage(r: globalThis.Response): Promise<string> {
  try {
    const j: any = await r.json();
    return j?.error?.message || (typeof j?.error === "string" ? j.error : "") || `upstream error ${r.status}`;
  } catch {
    return `upstream error ${r.status}`;
  }
}

const ACTION_RE = /^\/models\/(.+):(generateContent|streamGenerateContent|countTokens)$/;

async function generate(req: Request, res: Response, model: string, stream: boolean): Promise<void> {
  let body: any;
  try {
    body = geminiToAnthropicRequest(model, req.body || {}, stream);
  } catch (err: any) {
    if (err instanceof GeminiNativeError) return sendError(res, 400, err.message);
    throw err;
  }
  if (!body.messages.length) return sendError(res, 400, "contents is required");

  const ac = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  let upstream: globalThis.Response;
  try {
    upstream = await fetch(`${baseUrl(req)}/v1/messages`, {
      method: "POST",
      headers: internalHeaders(req),
      body: JSON.stringify(body),
      signal: ac.signal,
    });
  } catch (err: any) {
    return sendError(res, 502, `upstream unreachable: ${err.message}`);
  }
  if (!upstream.ok) return sendError(res, upstream.status, await upstreamMessage(upstream));

  if (!stream) {
    res.json(anthropicToGeminiResponse(await upstream.json(), model));
    return;
  }

  // ?alt=sse: Server-Sent Events (what the SDKs ask for); otherwise a JSON array streamed in pieces.
  const sse = req.query.alt === "sse";
  res.setHeader("Content-Type", sse ? "text/event-stream" : "application/json");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders?.();
  const conv = makeGeminiStreamConverter(model);
  let first = true;
  const write = (chunks: any[]) => {
    for (const c of chunks) {
      if (sse) res.write(`data: ${JSON.stringify(c)}\r\n\r\n`);
      else {
        res.write((first ? "[" : ",\r\n") + JSON.stringify(c));
        first = false;
      }
    }
  };
  try {
    for await (const ev of readSseEvents(upstream)) write(conv.push(ev.event, ev.data));
  } catch {
    /* client gone or upstream cut: close what was sent */
  }
  write(conv.end());
  if (!sse) res.write(first ? "[]" : "]");
  res.end();
}

export function createGeminiNativeRouter(): express.Router {
  const router = express.Router();

  router.get("/models", async (req, res) => {
    try {
      const r = await fetch(`${baseUrl(req)}/v1/models`, { headers: internalHeaders(req) });
      if (!r.ok) return sendError(res, r.status, await upstreamMessage(r));
      const j: any = await r.json();
      res.json({
        models: (j.data || []).map((m: any) => ({
          name: `models/${m.id}`,
          baseModelId: m.id,
          displayName: m.display_name || m.id,
          ...(m.context_length ? { inputTokenLimit: m.context_length } : {}),
          ...(m.max_completion_tokens ? { outputTokenLimit: m.max_completion_tokens } : {}),
          supportedGenerationMethods: ["generateContent", "streamGenerateContent", "countTokens"],
        })),
      });
    } catch (err: any) {
      sendError(res, 502, err.message);
    }
  });

  router.post("*", async (req, res) => {
    const m = ACTION_RE.exec(req.path);
    if (!m) return sendError(res, 404, `unknown Gemini route ${req.path}`);
    const model = decodeURIComponent(m[1]).replace(/^models\//, "");
    try {
      if (m[2] === "countTokens") {
        // No upstream counter for most providers: local estimate (~4 chars/token), like /v1/messages/count_tokens.
        const src = req.body?.generateContentRequest || req.body || {};
        const chars = JSON.stringify([src.systemInstruction ?? "", src.contents ?? [], src.tools ?? []]).length;
        res.json({ totalTokens: Math.max(1, Math.ceil(chars / 4)) });
        return;
      }
      await generate(req, res, model, m[2] === "streamGenerateContent");
    } catch (err: any) {
      sendError(res, 500, err?.message || String(err));
    }
  });

  return router;
}
