import { StringDecoder } from "node:string_decoder";
import type { NextFunction, Request, Response } from "express";

/**
 * `model-aliases` (alias -> real id): the request body is rewritten to the real id so every handler
 * works unchanged, and the response is rewritten back so the client sees the model name it asked
 * for. Needed by clients that only accept some ids (e.g. Claude Desktop accepts `claude-*` only).
 */

/** Sets the model name of an OpenAI/Anthropic/Responses payload (top level, `message`, `response`). */
export function rewriteModelFields<T>(payload: T, alias: string): T {
  if (payload && typeof payload === "object") {
    const p = payload as any;
    for (const node of [p, p.message, p.response]) {
      if (node && typeof node === "object" && typeof node.model === "string") {
        node.model = alias;
      }
    }
  }
  return payload;
}

/** Rewrites the `model` of one SSE line (`data: {...}`); any other line is returned untouched. */
export function rewriteSseLine(line: string, alias: string): string {
  const cr = line.endsWith("\r") ? "\r" : "";
  const bare = cr ? line.slice(0, -1) : line;
  if (!bare.startsWith("data:")) return line;
  const payload = bare.slice(5).trim();
  if (!payload.startsWith("{")) return line;
  try {
    return `data: ${JSON.stringify(rewriteModelFields(JSON.parse(payload), alias))}${cr}`;
  } catch {
    return line;
  }
}

/** Makes the response of `res` carry `alias` as its model name (JSON bodies and SSE streams). */
export function echoRequestedModel(res: Response, alias: string): void {
  const r = res as any;
  const originalJson = r.json.bind(res);
  r.json = (body: unknown) => originalJson(rewriteModelFields(body, alias));

  const originalWrite = r.write.bind(res);
  const originalEnd = r.end.bind(res);
  const decoder = new StringDecoder("utf8");
  let tail = "";
  const isSse = () =>
    String(res.getHeader("content-type") ?? "").includes("text/event-stream");

  // Upstream chunks may split an event anywhere: only complete lines are rewritten and forwarded.
  r.write = (chunk: any, ...args: any[]): boolean => {
    if (!isSse() || !(typeof chunk === "string" || chunk instanceof Uint8Array)) {
      return originalWrite(chunk, ...args);
    }
    const text = tail + (typeof chunk === "string" ? chunk : decoder.write(Buffer.from(chunk)));
    const lines = text.split("\n");
    tail = lines.pop() ?? "";
    if (lines.length === 0) return true;
    return originalWrite(lines.map((l) => rewriteSseLine(l, alias)).join("\n") + "\n", ...args);
  };
  r.end = (chunk?: any, ...args: any[]) => {
    if (typeof chunk === "string" || chunk instanceof Uint8Array) r.write(chunk);
    if (tail) {
      originalWrite(rewriteSseLine(tail, alias));
      tail = "";
    }
    return typeof chunk === "function" ? originalEnd(chunk) : originalEnd(...args);
  };
}

/** Express middleware: swaps an aliased request `model` for its target and echoes the alias back. */
export function modelAliasMiddleware(aliases: Record<string, string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const m = req.body && typeof req.body === "object" ? req.body.model : undefined;
    if (typeof m === "string" && Object.prototype.hasOwnProperty.call(aliases, m)) {
      req.body.model = aliases[m];
      echoRequestedModel(res, m);
    }
    next();
  };
}
