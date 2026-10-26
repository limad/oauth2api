import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  modelAliasMiddleware,
  rewriteModelFields,
  rewriteSseLine,
} from "../src/utils/model-echo";

test("rewriteModelFields sets top-level, message and response model names", () => {
  assert.equal(rewriteModelFields({ model: "real" }, "alias").model, "alias");
  assert.equal(
    rewriteModelFields({ type: "message_start", message: { model: "real" } }, "alias").message.model,
    "alias",
  );
  assert.equal(
    rewriteModelFields({ type: "response.created", response: { model: "real" } }, "alias").response.model,
    "alias",
  );
  assert.deepEqual(rewriteModelFields({ error: { message: "x" } }, "alias"), { error: { message: "x" } });
  assert.equal(rewriteModelFields(null, "alias"), null);
});

test("rewriteSseLine only touches data lines carrying JSON", () => {
  assert.equal(rewriteSseLine('data: {"model":"real","n":1}', "alias"), 'data: {"model":"alias","n":1}');
  assert.equal(rewriteSseLine('data: {"model":"real"}\r', "alias"), 'data: {"model":"alias"}\r');
  assert.equal(rewriteSseLine("data: [DONE]", "alias"), "data: [DONE]");
  assert.equal(rewriteSseLine("event: message_start", "alias"), "event: message_start");
  assert.equal(rewriteSseLine("data: {broken", "alias"), "data: {broken");
});

async function withServer(
  handler: express.RequestHandler,
  run: (url: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.post("/v1/x", modelAliasMiddleware({ "claude-fake": "gemini-real" }), handler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/x`);
  } finally {
    server.close();
  }
}

const post = (url: string, model: string) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });

test("alias: handler sees the real id, JSON response carries the alias", async () => {
  await withServer(
    (req, res) => {
      res.json({ seen: req.body.model, model: req.body.model });
    },
    async (url) => {
      const body: any = await (await post(url, "claude-fake")).json();
      assert.equal(body.seen, "gemini-real");
      assert.equal(body.model, "claude-fake");
    },
  );
});

test("alias: SSE events split across chunks are rewritten, other text untouched", async () => {
  await withServer(
    async (_req, res) => {
      res.setHeader("Content-Type", "text/event-stream");
      res.flushHeaders();
      const pieces = [
        'event: message_start\ndata: {"type":"message_start","message":{"model":"gem',
        'ini-real","id":"1"}}\n\ndata: {"model":"gemini-real","choices":[{"delta":{"content":"model gemini-real"}}]}\n\ndata: [DO',
        "NE]\n\n",
      ];
      for (const p of pieces) {
        res.write(p);
        await new Promise((r) => setTimeout(r, 10));
      }
      res.end();
    },
    async (url) => {
      const text = await (await post(url, "claude-fake")).text();
      assert.match(text, /"message":\{"model":"claude-fake","id":"1"\}/);
      assert.match(text, /"model":"claude-fake","choices"/);
      assert.match(text, /"content":"model gemini-real"/); // text content is not a model field
      assert.match(text, /data: \[DONE\]/);
      assert.doesNotMatch(text, /"model":"gemini-real"/);
    },
  );
});

test("non-aliased model keeps its real name", async () => {
  await withServer(
    (req, res) => {
      res.json({ model: req.body.model });
    },
    async (url) => {
      const body: any = await (await post(url, "gemini-real")).json();
      assert.equal(body.model, "gemini-real");
    },
  );
});
