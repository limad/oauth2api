import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import { handleStreamingResponse } from "../src/upstream/streaming";
import {
  responsesSSEToChat,
  responsesSSEToAnthropic,
  makeResponsesToChatState,
  makeResponsesToAnthropicState,
  drainCodexResponsesSse,
  unsentToolArgs,
} from "../src/upstream/responses-translator";

// ───────────────── helpers ─────────────────

/**
 * Upstream that sends `chunks` and then stays open (like Codex after
 * `response.completed`) unless `close` is true. `cancelled` tells whether
 * the proxy cancelled the read.
 */
function makeUpstream(chunks: string[], close = false) {
  const enc = new TextEncoder();
  const flags = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (close) controller.close();
    },
    cancel() {
      flags.cancelled = true;
    },
  });
  return { upstream: new Response(body, { status: 200 }), flags };
}

/**
 * Express-like response. `hangUpOn` mimics opencode: once a written chunk
 * matches it, the client closes the connection on the next tick (unless the
 * response already ended). `usageAtEnd` is what the stats slot held when
 * `end()` was called (what the stats "finish" handler will read).
 */
function makeClient(hangUpOn?: RegExp): any {
  const resp = new EventEmitter() as any;
  resp.chunks = [] as string[];
  resp.locals = { stats: { usage: null } };
  resp.ended = false;
  resp.setHeader = () => resp;
  resp.flushHeaders = () => {};
  resp.write = (chunk: Uint8Array | string) => {
    const text =
      typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    resp.chunks.push(text);
    if (hangUpOn && hangUpOn.test(text)) {
      setImmediate(() => {
        if (!resp.ended) resp.emit("close");
      });
    }
    return true;
  };
  resp.end = () => {
    resp.ended = true;
    resp.usageAtEnd = resp.locals.stats.usage;
    setImmediate(() => resp.emit("close"));
    return resp;
  };
  return resp;
}

/** Fails instead of hanging when the stream is never released. */
function withTimeout<T>(p: Promise<T>, ms = 2000): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("stream never ended")), ms),
    ),
  ]);
}

const sse = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const codexCompleted = sse("response.completed", {
  response: {
    status: "completed",
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      input_tokens_details: { cached_tokens: 100 },
      output_tokens_details: { reasoning_tokens: 5 },
    },
  },
});

function chatToolCalls(
  chunks: string[],
): Map<number, { id?: string; args: string }> {
  const calls = new Map<number, { id?: string; args: string }>();
  for (const c of chunks) {
    for (const line of c.split("\n")) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      const j = JSON.parse(line.slice(6));
      for (const tc of j.choices?.[0]?.delta?.tool_calls ?? []) {
        const cur = calls.get(tc.index) ?? { args: "" };
        if (tc.id) cur.id = tc.id;
        cur.args += tc.function?.arguments ?? "";
        calls.set(tc.index, cur);
      }
    }
  }
  return calls;
}

function anthropicToolInputs(chunks: string[]): Map<number, string> {
  const inputs = new Map<number, string>();
  for (const c of chunks) {
    for (const line of c.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const j = JSON.parse(line.slice(6));
      if (
        j.type === "content_block_start" &&
        j.content_block?.type === "tool_use"
      ) {
        inputs.set(j.index, "");
      }
      if (
        j.type === "content_block_delta" &&
        j.delta?.type === "input_json_delta"
      ) {
        inputs.set(j.index, (inputs.get(j.index) ?? "") + j.delta.partial_json);
      }
    }
  }
  return inputs;
}

// ───────────────── 1. terminal event ends the response ─────────────────

test("Codex Chat en flux : le client coupe après [DONE], l'usage est gardé", async () => {
  const { upstream, flags } = makeUpstream([
    sse("response.output_text.delta", { delta: "bonjour" }),
    codexCompleted,
  ]);
  const resp = makeClient(/\[DONE\]/);
  const state = makeResponsesToChatState("gpt-6-luna");
  const result = await withTimeout(
    handleStreamingResponse(upstream, resp, {
      onEvent: (event, data) => responsesSSEToChat(event, data, state),
    }),
  );
  assert.equal(result.completed, true);
  assert.equal(result.clientDisconnected, false);
  assert.equal(resp.ended, true, "resp.end() sans attendre l'amont");
  assert.equal(flags.cancelled, true, "lecture amont annulée");
  assert.match(resp.chunks.join(""), /data: \[DONE\]/);
  assert.equal(result.usage.inputTokens, 120);
  assert.equal(result.usage.cacheReadInputTokens, 100);
  assert.equal(result.usage.outputTokens, 30);
  assert.equal(result.usage.reasoningOutputTokens, 5);
  // The stats slot must be filled before end() (the finish handler reads it).
  assert.equal(resp.usageAtEnd?.inputTokens, 120);
});

test("Codex Messages en flux : message_stop termine la réponse", async () => {
  const { upstream, flags } = makeUpstream([
    sse("response.created", {}),
    sse("response.output_text.delta", { delta: "ok" }),
    codexCompleted,
  ]);
  const resp = makeClient(/message_stop/);
  const state = makeResponsesToAnthropicState("gpt-6-luna");
  const result = await withTimeout(
    handleStreamingResponse(upstream, resp, {
      onEvent: (event, data) => responsesSSEToAnthropic(event, data, state),
    }),
  );
  assert.equal(result.completed, true);
  assert.equal(resp.ended, true);
  assert.equal(flags.cancelled, true);
  assert.match(resp.chunks.join(""), /event: message_stop/);
  assert.equal(resp.usageAtEnd?.inputTokens, 120);
});

test("response.incomplete est aussi une fin normale (Chat et Messages)", async () => {
  const incomplete = sse("response.incomplete", {
    response: {
      status: "incomplete",
      usage: { input_tokens: 9, output_tokens: 4 },
    },
  });
  const chat = makeResponsesToChatState("m");
  const out = responsesSSEToChat(
    "response.incomplete",
    JSON.parse(incomplete.split("data: ")[1]),
    chat,
  ).join("");
  assert.match(out, /"finish_reason":"length"/);
  assert.match(out, /\[DONE\]/);

  const { upstream } = makeUpstream([incomplete]);
  const resp = makeClient(/message_stop/);
  const st = makeResponsesToAnthropicState("m");
  const result = await withTimeout(
    handleStreamingResponse(upstream, resp, {
      onEvent: (event, data) => responsesSSEToAnthropic(event, data, st),
    }),
  );
  assert.equal(result.completed, true);
  assert.match(resp.chunks.join(""), /"stop_reason":"max_tokens"/);
  assert.equal(result.usage.inputTokens, 9);
  assert.equal(result.usage.outputTokens, 4);
});

test("Passage direct Chat (Mistral, Copilot) : [DONE] termine la réponse", async () => {
  const usageChunk = {
    object: "chat.completion.chunk",
    choices: [],
    usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57 },
  };
  const { upstream, flags } = makeUpstream([
    `data: ${JSON.stringify({ object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "x" } }] })}\n\n`,
    `data: ${JSON.stringify(usageChunk)}\n\n`,
    "data: [DONE]\n\n",
  ]);
  const resp = makeClient(/\[DONE\]/);
  const result = await withTimeout(handleStreamingResponse(upstream, resp));
  assert.equal(result.completed, true);
  assert.equal(resp.ended, true);
  assert.equal(flags.cancelled, true);
  assert.equal(result.usage.inputTokens, 50);
  assert.equal(result.usage.outputTokens, 7);
  assert.equal(resp.usageAtEnd?.outputTokens, 7);
});

test("Passage direct Anthropic : message_stop termine la réponse", async () => {
  const { upstream, flags } = makeUpstream([
    sse("message_start", {
      type: "message_start",
      message: { usage: { input_tokens: 3 } },
    }),
    sse("message_delta", {
      type: "message_delta",
      usage: { input_tokens: 11, output_tokens: 2 },
    }),
    sse("message_stop", { type: "message_stop" }),
  ]);
  const resp = makeClient(/message_stop/);
  const result = await withTimeout(handleStreamingResponse(upstream, resp));
  assert.equal(result.completed, true);
  assert.equal(flags.cancelled, true);
  assert.equal(result.usage.inputTokens, 11);
  assert.equal(result.usage.outputTokens, 2);
  // Pass-through: bytes reach the client untouched.
  assert.match(resp.chunks.join(""), /event: message_stop/);
});

test("Le client qui coupe avant la fin reste un abandon sans usage", async () => {
  const { upstream } = makeUpstream([
    sse("response.output_text.delta", { delta: "début" }),
  ]);
  const resp = makeClient(/début/);
  const state = makeResponsesToChatState("m");
  const result = await withTimeout(
    handleStreamingResponse(upstream, resp, {
      onEvent: (event, data) => responsesSSEToChat(event, data, state),
    }),
  );
  assert.equal(result.completed, false);
  assert.equal(result.clientDisconnected, true);
  assert.equal(resp.ended, false);
  assert.equal(resp.locals.stats.usage, null);
});

test("Un amont qui ferme sans événement terminal se termine comme avant", async () => {
  const { upstream } = makeUpstream(
    [sse("response.output_text.delta", { delta: "x" })],
    true,
  );
  const resp = makeClient();
  const result = await withTimeout(handleStreamingResponse(upstream, resp));
  assert.equal(result.completed, true);
  assert.equal(resp.ended, true);
});

// ───────────────── 2. tool arguments only in `.done` ─────────────────

test("unsentToolArgs : ne renvoie que la partie pas encore envoyée", () => {
  assert.equal(unsentToolArgs("", '{"path":"a"}'), '{"path":"a"}');
  assert.equal(unsentToolArgs('{"pa', '{"path":"a"}'), 'th":"a"}');
  assert.equal(unsentToolArgs('{"path":"a"}', '{"path":"a"}'), "");
  assert.equal(unsentToolArgs('{"x', '{"path":"a"}'), "", "divergence : rien");
  assert.equal(unsentToolArgs("", undefined), "");
});

test("Chat : arguments arrivés seulement dans function_call_arguments.done", () => {
  const st = makeResponsesToChatState("m");
  const out: string[] = [];
  out.push(
    ...responsesSSEToChat(
      "response.output_item.added",
      {
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "read",
          arguments: "",
        },
      },
      st,
    ),
  );
  out.push(
    ...responsesSSEToChat(
      "response.function_call_arguments.done",
      {
        item_id: "fc_1",
        output_index: 0,
        arguments: '{"path":"README.md"}',
      },
      st,
    ),
  );
  // output_item.done repeats the same arguments: nothing more is sent.
  out.push(
    ...responsesSSEToChat(
      "response.output_item.done",
      {
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "read",
          arguments: '{"path":"README.md"}',
        },
      },
      st,
    ),
  );
  const calls = chatToolCalls(out);
  assert.equal(calls.get(0)?.args, '{"path":"README.md"}');
  assert.equal(calls.get(0)?.id, "call_1");
});

test("Chat : arguments seulement dans output_item.done, sans added ni delta", () => {
  const st = makeResponsesToChatState("m");
  const out = responsesSSEToChat(
    "response.output_item.done",
    {
      output_index: 2,
      item: {
        type: "function_call",
        id: "fc_9",
        call_id: "call_9",
        name: "read",
        arguments: '{"path":"b"}',
      },
    },
    st,
  );
  const calls = chatToolCalls(out);
  assert.equal(calls.get(0)?.id, "call_9");
  assert.equal(calls.get(0)?.args, '{"path":"b"}');
});

test("Chat : appels parallèles, deltas partiels ou absents, sans doublon", () => {
  const st = makeResponsesToChatState("m");
  const ev: Array<[string, any]> = [
    [
      "response.output_item.added",
      {
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_a",
          call_id: "call_a",
          name: "read",
          arguments: "",
        },
      },
    ],
    [
      "response.output_item.added",
      {
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc_b",
          call_id: "call_b",
          name: "read",
          arguments: "",
        },
      },
    ],
    [
      "response.output_item.added",
      {
        output_index: 2,
        item: {
          type: "function_call",
          id: "fc_c",
          call_id: "call_c",
          name: "read",
          arguments: "",
        },
      },
    ],
    // a: complete deltas; b: half the deltas; c: none at all.
    [
      "response.function_call_arguments.delta",
      { item_id: "fc_a", output_index: 0, delta: '{"path":' },
    ],
    [
      "response.function_call_arguments.delta",
      { item_id: "fc_b", output_index: 1, delta: '{"pa' },
    ],
    [
      "response.function_call_arguments.delta",
      { item_id: "fc_a", output_index: 0, delta: '"a"}' },
    ],
    // A delta that only carries output_index still lands on b.
    [
      "response.function_call_arguments.delta",
      { output_index: 1, delta: 'th":' },
    ],
    [
      "response.function_call_arguments.done",
      { item_id: "fc_a", output_index: 0, arguments: '{"path":"a"}' },
    ],
    [
      "response.function_call_arguments.done",
      { item_id: "fc_b", output_index: 1, arguments: '{"path":"b"}' },
    ],
    [
      "response.output_item.done",
      {
        output_index: 2,
        item: {
          type: "function_call",
          id: "fc_c",
          call_id: "call_c",
          name: "read",
          arguments: '{"path":"c"}',
        },
      },
    ],
    [
      "response.output_item.done",
      {
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_a",
          call_id: "call_a",
          name: "read",
          arguments: '{"path":"a"}',
        },
      },
    ],
    [
      "response.output_item.done",
      {
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc_b",
          call_id: "call_b",
          name: "read",
          arguments: '{"path":"b"}',
        },
      },
    ],
  ];
  const out = ev.flatMap(([e, d]) => responsesSSEToChat(e, d, st));
  const calls = chatToolCalls(out);
  assert.deepEqual(
    [0, 1, 2].map((i) => [calls.get(i)?.id, calls.get(i)?.args]),
    [
      ["call_a", '{"path":"a"}'],
      ["call_b", '{"path":"b"}'],
      ["call_c", '{"path":"c"}'],
    ],
  );
  for (const i of [0, 1, 2]) JSON.parse(calls.get(i)!.args);
});

test("Messages : arguments seulement dans .done, appels parallèles", () => {
  const st = makeResponsesToAnthropicState("m");
  const ev: Array<[string, any]> = [
    [
      "response.output_item.added",
      {
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_a",
          call_id: "call_a",
          name: "read",
          arguments: "",
        },
      },
    ],
    [
      "response.output_item.added",
      {
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc_b",
          call_id: "call_b",
          name: "read",
          arguments: "",
        },
      },
    ],
    [
      "response.function_call_arguments.delta",
      { item_id: "fc_a", delta: '{"path":"a"}' },
    ],
    [
      "response.function_call_arguments.done",
      { item_id: "fc_b", arguments: '{"path":"b"}' },
    ],
    [
      "response.output_item.done",
      {
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_a",
          call_id: "call_a",
          name: "read",
          arguments: '{"path":"a"}',
        },
      },
    ],
    [
      "response.output_item.done",
      {
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc_b",
          call_id: "call_b",
          name: "read",
          arguments: '{"path":"b"}',
        },
      },
    ],
    [
      "response.output_item.done",
      {
        output_index: 2,
        item: {
          type: "function_call",
          id: "fc_c",
          call_id: "call_c",
          name: "read",
          arguments: '{"path":"c"}',
        },
      },
    ],
    ["response.completed", { response: { status: "completed" } }],
  ];
  const out = ev.flatMap(([e, d]) => responsesSSEToAnthropic(e, d, st));
  const inputs = anthropicToolInputs(out);
  assert.deepEqual(
    [...inputs.values()],
    ['{"path":"a"}', '{"path":"b"}', '{"path":"c"}'],
  );
  assert.match(out.join(""), /"stop_reason":"tool_use"/);
});

test("Non-flux (drain) : arguments repris de .done quand les deltas manquent", async () => {
  const { upstream } = makeUpstream(
    [
      sse("response.output_item.added", {
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_a",
          call_id: "call_a",
          name: "read",
          arguments: "",
        },
      }),
      sse("response.output_item.added", {
        output_index: 1,
        item: {
          type: "function_call",
          id: "fc_b",
          call_id: "call_b",
          name: "read",
          arguments: "",
        },
      }),
      sse("response.function_call_arguments.delta", {
        item_id: "fc_a",
        delta: '{"path":"a"}',
      }),
      sse("response.function_call_arguments.done", {
        item_id: "fc_b",
        arguments: '{"path":"b"}',
      }),
      sse("response.output_item.done", {
        output_index: 0,
        item: {
          type: "function_call",
          id: "fc_a",
          call_id: "call_a",
          name: "read",
          arguments: '{"path":"a"}',
        },
      }),
      sse("response.output_item.done", {
        output_index: 2,
        item: {
          type: "function_call",
          id: "fc_c",
          call_id: "call_c",
          name: "read",
          arguments: '{"path":"c"}',
        },
      }),
      codexCompleted,
    ],
    true,
  );
  const drained = await drainCodexResponsesSse(upstream);
  assert.deepEqual(
    [...drained.toolCalls.values()].map((t) => [t.id, t.args]),
    [
      ["call_a", '{"path":"a"}'],
      ["call_b", '{"path":"b"}'],
      ["call_c", '{"path":"c"}'],
    ],
  );
});
