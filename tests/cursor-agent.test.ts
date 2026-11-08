import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import {
  __setCursorAgentTransports,
  agentSessionDeltas,
  answerExecRequest,
  answerKvRequest,
  buildAgentRunFrame,
  CursorAgentSession,
  parseAgentModelPicker,
  pickAutoModel,
} from "../src/upstream/cursor-agent";
import {
  __buildCursorHeaders,
  callCursorResponses,
} from "../src/upstream/cursor-api";
import {
  __resetCursorClientVersion,
  ensureCursorClientVersion,
  FALLBACK_CURSOR_CLIENT_VERSION,
  getCursorClientVersion,
  parseCursorUpdateFeed,
} from "../src/upstream/cursor-version";
import {
  concatBytes,
  connectFrame,
  encodeBytesField as f,
  encodeVarintField as v,
  parseFields,
  ProtoFieldRaw,
} from "../src/upstream/cursor-proto";
import { Config } from "../src/config";

// ------------------------------------------------------------------ helpers

function makeConfig(
  cursor: NonNullable<Config["cloaking"]["cursor"]> = {},
): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    "auth-dir": "/tmp/auth2api-test",
    "api-keys": new Set(["test-key"]),
    "body-limit": "200mb",
    cloaking: { "cli-version": "2.1.88", entrypoint: "cli", cursor },
    timeouts: {
      "messages-ms": 120000,
      "stream-messages-ms": 600000,
      "count-tokens-ms": 30000,
    },
    debug: "off",
  };
}

const account = {
  token: {
    accessToken: "access",
    refreshToken: "refresh",
    email: "x@cursor.com",
    accountUuid: "machine",
    provider: "cursor" as const,
    cursorServiceMachineId: "machine",
  },
} as any;

const LIVE = {
  version: "3.29.9",
  commit: "306d153d51d714882ab7b1bc49649cab624e8a31",
  source: "feed" as const,
};

const bytes = (fields: ProtoFieldRaw[], n: number) =>
  fields.find((x) => x.field === n && x.wireType === 2)?.bytes;
const str = (fields: ProtoFieldRaw[], n: number) => {
  const b = bytes(fields, n);
  return b ? Buffer.from(b).toString("utf8") : undefined;
};
const path = (data: Uint8Array, ...fields: number[]) => {
  let cur: Uint8Array | undefined = data;
  for (const n of fields) cur = cur ? bytes(parseFields(cur), n) : undefined;
  return cur;
};
const unframe = (frame: Uint8Array) => frame.slice(5);

// Server -> client frames.
const textUpdate = (t: string) => connectFrame(f(1, f(1, f(1, t))));
const thinkingUpdate = (t: string) => connectFrame(f(1, f(4, f(1, t))));
const turnEnded = () => connectFrame(f(1, f(14, new Uint8Array(0))));
// TurnEndedUpdate with input 120 (incl. 100 cache read, 5 cache write), output 7, reasoning 3.
const turnEndedWithUsage = () =>
  connectFrame(
    f(1, f(14, concatBytes([v(1, 120), v(2, 7), v(3, 100), v(4, 5), v(5, 3)]))),
  );
const cursorError = (code: string, debug: string) =>
  endStream({
    error: {
      code,
      message: "Error",
      details: [{ debug: { error: debug, details: { detail: "why" } } }],
    },
  });
const execRequest = (id: number, execId: string, variant: number) =>
  connectFrame(
    f(2, concatBytes([v(1, id), f(15, execId), f(variant, new Uint8Array(0))])),
  );
const kvGet = (id: number, meta: string) =>
  connectFrame(
    f(4, concatBytes([v(1, id), f(2, f(1, "blob-key")), f(4, meta)])),
  );
const endStream = (json: unknown) => {
  const payload = Buffer.from(JSON.stringify(json));
  const frame = new Uint8Array(5 + payload.length);
  frame[0] = 2;
  new DataView(frame.buffer).setUint32(1, payload.length, false);
  frame.set(payload, 5);
  return frame;
};

function fakeSession(chunks: Uint8Array[], status = 200) {
  const written: Uint8Array[] = [];
  let closed = false;
  const session: CursorAgentSession = {
    status,
    headers: {},
    chunks: (async function* () {
      for (const c of chunks) yield c;
    })(),
    write: (frame) => written.push(frame),
    close: () => {
      closed = true;
    },
  };
  return { session, written, isClosed: () => closed };
}

async function readAll(resp: Response): Promise<string> {
  return await resp.text();
}

// ------------------------------------------------------------ run request

test("agent run frame carries model, folded system prompt, history and effort", () => {
  const frame = buildAgentRunFrame(
    [
      { role: "system", content: "Be brief." },
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ],
    "gpt-5.5-medium",
    "high",
  );
  assert.equal(frame[0], 0);
  const run = path(unframe(frame), 1)!; // AgentClientMessage.run_request
  const runFields = parseFields(run);
  assert.equal(bytes(runFields, 1)!.length, 0, "empty conversation state");
  const userAction = path(run, 2, 1)!;
  const userMessage = path(userAction, 1)!;
  assert.equal(str(parseFields(userMessage), 1), "Be brief.\n\nsecond");
  assert.ok(
    parseFields(userMessage).some((x) => x.field === 4 && x.varint === 1),
    "agent mode",
  );
  const history = parseFields(path(userAction, 7)!).filter(
    (x) => x.field === 1,
  );
  assert.equal(history.length, 2);
  assert.equal(str(parseFields(path(history[0].bytes!, 1, 1, 1)!), 1), "first");
  assert.equal(
    str(parseFields(path(history[1].bytes!, 2, 1, 1)!), 1),
    "answer",
  );
  const details = parseFields(path(run, 3)!);
  assert.deepEqual(
    [str(details, 1), str(details, 3), str(details, 4)],
    ["gpt-5.5-medium", "gpt-5.5-medium", "gpt-5.5-medium"],
  );
  const requested = path(run, 9)!;
  assert.equal(str(parseFields(requested), 1), "gpt-5.5-medium");
  const param = parseFields(path(requested, 3)!);
  assert.deepEqual([str(param, 1), str(param, 2)], ["reasoning", "high"]);
});

// ------------------------------------------------------ server requests

test("request_context is acked with an empty success, IDE tools are refused", () => {
  const ctx = answerExecRequest(
    path(unframe(execRequest(7, "exec-1", 10)), 2)!,
  );
  assert.equal(ctx.kind, "reply");
  const reply = path(unframe((ctx as any).frame), 2)!;
  const fields = parseFields(reply);
  assert.equal(fields.find((x) => x.field === 1)?.varint, 7);
  assert.equal(str(fields, 15), "exec-1");
  assert.deepEqual([...bytes(fields, 10)!], [0x0a, 0x02, 0x0a, 0x00]);

  const shell = answerExecRequest(
    path(unframe(execRequest(8, "exec-2", 2)), 2)!,
  );
  assert.equal(shell.kind, "reply");
  const refused = path(unframe((shell as any).frame), 2, 2, 2, 2)!;
  assert.match(Buffer.from(refused).toString("utf8"), /not available/);

  assert.equal(
    answerExecRequest(path(unframe(execRequest(9, "exec-3", 11)), 2)!).kind,
    "fail",
  );
  assert.equal(
    answerExecRequest(path(unframe(execRequest(9, "exec-4", 99)), 2)!).kind,
    "fail",
  );
});

test("kv blob requests are acked with their metadata echoed", () => {
  const reply = answerKvRequest(path(unframe(kvGet(5, "meta")), 4)!)!;
  const kv = parseFields(path(unframe(reply), 3)!);
  assert.equal(kv.find((x) => x.field === 1)?.varint, 5);
  assert.deepEqual([...bytes(kv, 2)!], [0x0a, 0x00]);
  assert.equal(str(kv, 4), "meta");
});

// ---------------------------------------------------------- stream decode

test("agent stream answers server requests and yields text after </think>", async () => {
  const gz = gzipSync(Buffer.from(unframe(textUpdate(" there"))));
  const gzFrame = new Uint8Array(5 + gz.length);
  gzFrame[0] = 1;
  new DataView(gzFrame.buffer).setUint32(1, gz.length, false);
  gzFrame.set(gz, 5);
  const all = concatBytes([
    kvGet(1, "m"),
    execRequest(2, "e", 10),
    thinkingUpdate("plan it"),
    thinkingUpdate("</think>Hi"),
    gzFrame,
    turnEnded(),
    textUpdate("ignored after turn end"),
  ]);
  // Split mid-frame to exercise buffering.
  const { session, written, isClosed } = fakeSession([
    all.slice(0, 13),
    all.slice(13),
  ]);
  const items = [];
  for await (const d of agentSessionDeltas(session)) items.push(d);
  const done = items.pop() as any;
  assert.equal(done.__done, true);
  assert.equal(done.aggregatedText, "Hi there");
  assert.equal(done.aggregatedReasoning, "plan it");
  assert.equal(done.error, undefined);
  assert.equal(written.length, 2, "kv + request_context acks");
  assert.ok(isClosed());
});

test("agent stream: thinking-only turn becomes the answer, empty turn is an error", async () => {
  const one = fakeSession([
    concatBytes([thinkingUpdate("just thoughts"), turnEnded()]),
  ]);
  const items = [];
  for await (const d of agentSessionDeltas(one.session)) items.push(d);
  assert.equal((items.pop() as any).aggregatedText, "just thoughts");

  const empty = fakeSession([turnEnded()]);
  const out = [];
  for await (const d of agentSessionDeltas(empty.session)) out.push(d);
  assert.match((out.pop() as any).error, /empty turn/);
});

// ------------------------------------------------------------ Auto model

test("Auto resolves to the picker's default agent model", () => {
  const entry = (id: string, defaultOn: number, agent: number, hidden = 0) =>
    f(2, concatBytes([f(1, id), v(2, defaultOn), v(5, agent), v(35, hidden)]));
  const payload = concatBytes([
    entry("chat-only", 1, 0),
    entry("hidden-one", 1, 1, 1),
    entry("composer-2", 0, 1),
    entry("claude-4.6-sonnet-medium", 1, 1),
  ]);
  const models = parseAgentModelPicker(payload);
  assert.equal(models.length, 4);
  assert.equal(pickAutoModel(models), "claude-4.6-sonnet-medium");
  assert.equal(pickAutoModel([]), null);
});

// ------------------------------------------------------- client version

test("update feed gives version and commit; failures keep the fallback", async () => {
  assert.deepEqual(
    parseCursorUpdateFeed({
      version: "3.29.9",
      url: "https://downloads.cursor.com/production/306d153d51d714882ab7b1bc49649cab624e8a31/linux/x64/Cursor-3.29.9-x86_64.AppImage.zsync",
      productVersion: "3.29.9",
    }),
    LIVE,
  );
  assert.equal(parseCursorUpdateFeed({ version: "garbage" }), null);

  __resetCursorClientVersion();
  const failing = (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch;
  const kept = await ensureCursorClientVersion(failing);
  assert.equal(kept.version, FALLBACK_CURSOR_CLIENT_VERSION);

  __resetCursorClientVersion();
  const ok = (async () =>
    new Response(
      JSON.stringify({ productVersion: "4.0.1", url: "x" }),
    )) as unknown as typeof fetch;
  assert.equal((await ensureCursorClientVersion(ok)).version, "4.0.1");
  assert.equal(getCursorClientVersion().commit, "");
  __resetCursorClientVersion();
});

test("headers report the live version + commit unless a version is pinned", () => {
  __resetCursorClientVersion(LIVE);
  const live = __buildCursorHeaders(account, makeConfig());
  assert.equal(live["x-cursor-client-version"], "3.29.9");
  assert.equal(live["x-cursor-client-commit"], LIVE.commit);
  assert.match(live["x-amzn-trace-id"], /^Root=[0-9a-f-]{36}$/);
  assert.equal(live["Connect-Accept-Encoding"], "gzip");
  assert.equal(live["Accept-Encoding"], undefined);

  const pinned = __buildCursorHeaders(
    account,
    makeConfig({ "client-version": "2.3.41" }),
  );
  assert.equal(pinned["x-cursor-client-version"], "2.3.41");
  assert.equal(pinned["x-cursor-client-commit"], undefined);
  __resetCursorClientVersion();
});

// ------------------------------------------------------------ end to end

test("callCursorResponses drives AgentService Run and resolves Auto", async (t) => {
  __resetCursorClientVersion(LIVE);
  const calls: {
    url: string;
    headers: Record<string, string>;
    frame?: Uint8Array;
  }[] = [];
  __setCursorAgentTransports({
    unary: async (url, headers) => {
      calls.push({ url, headers });
      return {
        status: 200,
        body: f(2, concatBytes([f(1, "composer-2"), v(2, 1), v(5, 1)])),
      };
    },
    run: async (url, headers, frame) => {
      calls.push({ url, headers, frame });
      return fakeSession([concatBytes([textUpdate("hello"), turnEnded()])])
        .session;
    },
  });
  t.after(() => {
    __setCursorAgentTransports(null);
    __resetCursorClientVersion();
  });

  const resp = await callCursorResponses({
    body: { model: "cursor-default", input: "hi" },
    account,
    config: makeConfig(),
  } as any);
  const sse = await readAll(resp);
  assert.match(sse, /response\.output_text\.delta[\s\S]*"delta":"hello"/);
  assert.match(sse, /response\.completed/);

  assert.equal(
    calls[0].url,
    "https://agent.api5.cursor.sh/agent.v1.AgentService/GetUsableModels",
  );
  assert.equal(calls[0].headers["Content-Type"], "application/proto");
  assert.equal(calls[0].headers["Connect-Protocol-Version"], undefined);
  assert.equal(
    calls[1].url,
    "https://agent.api5.cursor.sh/agent.v1.AgentService/Run",
  );
  assert.equal(calls[1].headers["x-cursor-client-version"], "3.29.9");
  const run = path(unframe(calls[1].frame!), 1)!;
  assert.equal(str(parseFields(path(run, 9)!), 1), "composer-2");
});

test("AgentService errors surface as failures, not as answers", async (t) => {
  __resetCursorClientVersion(LIVE);
  let status = 200;
  __setCursorAgentTransports({
    run: async () =>
      fakeSession(
        [
          endStream({
            error: {
              code: "resource_exhausted",
              message: "Error",
              details: [
                { debug: { error: "ERROR_X", details: { detail: "nope" } } },
              ],
            },
          }),
        ],
        status,
      ).session,
  });
  t.after(() => {
    __setCursorAgentTransports(null);
    __resetCursorClientVersion();
  });

  // An error before any output becomes an HTTP error, not a 200 stream.
  const early = await callCursorResponses({
    body: { model: "cursor-gpt-5.5", input: "hi" },
    account,
    config: makeConfig(),
  } as any);
  assert.equal(early.status, 429);
  const body = JSON.parse(await early.text());
  assert.match(
    body.error.message,
    /resource_exhausted — ERROR_X — Error — nope/,
  );
  assert.equal(body.error.code, "ERROR_X");

  status = 401;
  const resp = await callCursorResponses({
    body: { model: "cursor-gpt-5.5", input: "hi" },
    account,
    config: makeConfig(),
  } as any);
  assert.equal(resp.status, 502);
  assert.match(await resp.text(), /HTTP 401: resource_exhausted/);
});

test("anthropic format over AgentService emits a text block", async (t) => {
  __resetCursorClientVersion(LIVE);
  __setCursorAgentTransports({
    run: async () =>
      fakeSession([concatBytes([textUpdate("ok"), turnEnded()])]).session,
  });
  t.after(() => {
    __setCursorAgentTransports(null);
    __resetCursorClientVersion();
  });
  const sse = await readAll(
    await callCursorResponses({
      body: {
        model: "cursor-claude-4.5-haiku",
        messages: [{ role: "user", content: "hi" }],
      },
      account,
      config: makeConfig(),
      responseFormat: "anthropic-messages",
    } as any),
  );
  assert.match(sse, /content_block_delta[\s\S]*"text":"ok"/);
  assert.match(sse, /message_stop/);
});

test("TurnEndedUpdate token counts reach every output format", async (t) => {
  __resetCursorClientVersion(LIVE);
  __setCursorAgentTransports({
    run: async () =>
      fakeSession([concatBytes([textUpdate("ok"), turnEndedWithUsage()])])
        .session,
  });
  t.after(() => {
    __setCursorAgentTransports(null);
    __resetCursorClientVersion();
  });
  const call = (responseFormat: string) =>
    callCursorResponses({
      body: {
        model: "cursor-gpt-5.5",
        messages: [{ role: "user", content: "hi" }],
      },
      account,
      config: makeConfig(),
      responseFormat,
    } as any).then(readAll);

  const responses = await call("openai-responses");
  const completed = JSON.parse(
    responses
      .split("\n")
      .find((l) => l.includes('"response.completed"'))!
      .slice(6),
  );
  assert.deepEqual(completed.response.usage, {
    input_tokens: 120,
    output_tokens: 7,
    total_tokens: 127,
    input_tokens_details: { cached_tokens: 100 },
    output_tokens_details: { reasoning_tokens: 3 },
  });

  const anthropic = await call("anthropic-messages");
  const delta = JSON.parse(
    anthropic
      .split("\n")
      .find((l) => l.includes('"message_delta"'))!
      .slice(6),
  );
  assert.deepEqual(delta.usage, {
    input_tokens: 15,
    output_tokens: 7,
    cache_read_input_tokens: 100,
    cache_creation_input_tokens: 5,
  });

  const chat = await call("openai-chat-completions");
  const stop = JSON.parse(
    chat
      .split("\n")
      .find((l) => l.includes('"finish_reason":"stop"'))!
      .slice(6),
  );
  assert.equal(stop.usage.prompt_tokens, 120);
  assert.equal(stop.usage.completion_tokens, 7);
  assert.equal(stop.usage.prompt_tokens_details.cached_tokens, 100);
});

test("Cursor errors before output map to HTTP statuses; plan refusals are 400", async (t) => {
  __resetCursorClientVersion(LIVE);
  let frames: Uint8Array[] = [];
  __setCursorAgentTransports({ run: async () => fakeSession(frames).session });
  t.after(() => {
    __setCursorAgentTransports(null);
    __resetCursorClientVersion();
  });
  const statusFor = async (f: Uint8Array[]) => {
    frames = f;
    const r = await callCursorResponses({
      body: { model: "cursor-gpt-5.5", input: "hi" },
      account,
      config: makeConfig(),
    } as any);
    return { status: r.status, body: await r.text() };
  };

  const plan = await statusFor([
    cursorError("resource_exhausted", "ERROR_RATE_LIMITED_CHANGEABLE"),
  ]);
  assert.equal(plan.status, 400);
  assert.match(plan.body, /ERROR_RATE_LIMITED_CHANGEABLE/);
  assert.equal(
    (
      await statusFor([
        cursorError(
          "resource_exhausted",
          "ERROR_GPT_4_VISION_PREVIEW_RATE_LIMIT",
        ),
      ])
    ).status,
    400,
  );
  assert.equal(
    (await statusFor([cursorError("unauthenticated", "ERROR_NOT_LOGGED_IN")]))
      .status,
    401,
  );
  assert.equal(
    (await statusFor([cursorError("unavailable", "ERROR_X")])).status,
    503,
  );
  assert.equal((await statusFor([turnEnded()])).status, 502, "empty turn");

  // An error after some output still ends the stream (headers already sent).
  const late = await statusFor([
    concatBytes([textUpdate("partial"), cursorError("internal", "ERROR_X")]),
  ]);
  assert.equal(late.status, 200);
  assert.match(late.body, /partial/);
});
