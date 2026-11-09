import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractUsage } from "../src/accounts/manager";
import { handleStreamingResponse } from "../src/upstream/streaming";
import { replayStatsEvents } from "../src/stats/storage";

// Anthropic splits cache writes by lifetime in usage.cache_creation: the
// 5 min and 1 h writes are billed differently, so the stats keep both.

const sse = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function makeUpstream(chunks: string[]) {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function makeClient(): any {
  const resp = new EventEmitter() as any;
  resp.chunks = [] as string[];
  resp.locals = { stats: { usage: null } };
  resp.setHeader = () => resp;
  resp.flushHeaders = () => {};
  resp.write = (chunk: Uint8Array | string) => {
    resp.chunks.push(
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
    );
    return true;
  };
  resp.end = () => {
    setImmediate(() => resp.emit("close"));
    return resp;
  };
  return resp;
}

test("JSON Anthropic : cache 5 min et 1 h lus à part, total inchangé", () => {
  const usage = extractUsage({
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: 1500,
      cache_read_input_tokens: 200,
      cache_creation: {
        ephemeral_5m_input_tokens: 1000,
        ephemeral_1h_input_tokens: 500,
      },
    },
  });
  assert.equal(usage.cacheCreationInputTokens, 1500);
  assert.equal(usage.cacheCreation5mInputTokens, 1000);
  assert.equal(usage.cacheCreation1hInputTokens, 500);
  assert.equal(usage.cacheReadInputTokens, 200);
});

test("JSON sans cache_creation : pas de répartition (inconnue)", () => {
  const usage = extractUsage({
    usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 70 },
  });
  assert.equal(usage.cacheCreationInputTokens, 70);
  assert.equal("cacheCreation5mInputTokens" in usage, false);
  assert.equal("cacheCreation1hInputTokens" in usage, false);
  // Chat Completions and Responses shapes never carry it either.
  const chat = extractUsage({ usage: { prompt_tokens: 5, completion_tokens: 1 } });
  assert.equal("cacheCreation5mInputTokens" in chat, false);
});

test("Répartition partielle : la valeur absente vaut 0", () => {
  const usage = extractUsage({
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 300,
      cache_creation: { ephemeral_1h_input_tokens: 300 },
    },
  });
  assert.equal(usage.cacheCreation5mInputTokens, 0);
  assert.equal(usage.cacheCreation1hInputTokens, 300);
});

test("Flux Anthropic : répartition prise dans message_start", async () => {
  const upstream = makeUpstream([
    sse("message_start", {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 3,
          cache_creation_input_tokens: 800,
          cache_creation: {
            ephemeral_5m_input_tokens: 800,
            ephemeral_1h_input_tokens: 0,
          },
        },
      },
    }),
    sse("message_delta", {
      type: "message_delta",
      usage: { input_tokens: 3, output_tokens: 9, cache_creation_input_tokens: 800 },
    }),
    sse("message_stop", { type: "message_stop" }),
  ]);
  const resp = makeClient();
  const result = await handleStreamingResponse(upstream, resp);
  assert.equal(result.usage.cacheCreationInputTokens, 800);
  assert.equal(result.usage.cacheCreation5mInputTokens, 800);
  assert.equal(result.usage.cacheCreation1hInputTokens, 0);
  assert.equal(result.usage.outputTokens, 9);
  // What reaches stats.jsonl.
  const line = JSON.parse(JSON.stringify(result.usage));
  assert.equal(line.cacheCreation5mInputTokens, 800);
});

test("Flux Anthropic : message_delta qui répète la répartition l'emporte", async () => {
  const upstream = makeUpstream([
    sse("message_start", {
      type: "message_start",
      message: {
        usage: {
          input_tokens: 3,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 0,
          },
        },
      },
    }),
    sse("message_delta", {
      type: "message_delta",
      usage: {
        input_tokens: 3,
        output_tokens: 2,
        cache_creation_input_tokens: 600,
        cache_creation: {
          ephemeral_5m_input_tokens: 100,
          ephemeral_1h_input_tokens: 500,
        },
      },
    }),
    sse("message_stop", { type: "message_stop" }),
  ]);
  const result = await handleStreamingResponse(upstream, makeClient());
  assert.equal(result.usage.cacheCreation5mInputTokens, 100);
  assert.equal(result.usage.cacheCreation1hInputTokens, 500);
});

test("Flux sans répartition : champs absents, octets relayés tels quels", async () => {
  const chunks = [
    sse("message_start", { type: "message_start", message: { usage: { input_tokens: 3 } } }),
    sse("message_delta", {
      type: "message_delta",
      usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 40 },
    }),
    sse("message_stop", { type: "message_stop" }),
  ];
  const resp = makeClient();
  const result = await handleStreamingResponse(makeUpstream(chunks), resp);
  assert.equal(result.usage.cacheCreationInputTokens, 40);
  assert.equal("cacheCreation5mInputTokens" in result.usage, false);
  assert.equal(resp.chunks.join(""), chunks.join(""));
});

test("stats.jsonl : lignes anciennes et nouvelles relues, valeur invalide rejetée", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-split-"));
  const file = path.join(dir, "stats.jsonl");
  const base = {
    v: 1,
    ts: "2026-11-09T00:00:00.000Z",
    apiKeyHash: "h",
    ip: "127.0.0.1",
    ua: "t",
    endpoint: "/v1/messages",
    model: "claude-x",
    provider: "anthropic",
    accountEmail: "a@b",
    status: "success",
    failureKind: null,
    statusCode: 200,
    latencyMs: 1,
  };
  const usage = {
    inputTokens: 1,
    outputTokens: 1,
    cacheCreationInputTokens: 30,
    cacheReadInputTokens: 0,
    reasoningOutputTokens: 0,
  };
  fs.writeFileSync(
    file,
    [
      { ...base, usage },
      { ...base, usage: { ...usage, cacheCreation5mInputTokens: 10, cacheCreation1hInputTokens: 20 } },
      { ...base, usage: { ...usage, cacheCreation5mInputTokens: "x" } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  const seen: any[] = [];
  const res = replayStatsEvents(file, (e) => seen.push(e));
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(seen.length, 2);
  assert.equal(res.skipped, 1);
  assert.equal(seen[1].usage.cacheCreation1hInputTokens, 20);
});
