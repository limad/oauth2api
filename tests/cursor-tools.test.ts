import test from "node:test";
import assert from "node:assert/strict";

import {
  agentMessagesFromBody,
  clientToolsFromBody,
  decodeMcpCall,
  decodeProtoValue,
  encodeMcpToolDefinitions,
  encodeProtoValue,
} from "../src/upstream/cursor-tools";
import {
  __setCursorAgentTransports,
  agentSessionDeltas,
  answerExecRequest,
  buildAgentRunFrame,
  CursorAgentSession,
} from "../src/upstream/cursor-agent";
import { callCursorResponses } from "../src/upstream/cursor-api";
import { __resetCursorClientVersion } from "../src/upstream/cursor-version";
import {
  concatBytes,
  connectFrame,
  encodeBytesField as f,
  encodeVarintField as v,
  parseFields,
} from "../src/upstream/cursor-proto";
import { Config } from "../src/config";

const config = {
  host: "127.0.0.1",
  port: 0,
  "auth-dir": "/tmp/auth2api-test",
  "api-keys": new Set(["k"]),
  "body-limit": "1mb",
  cloaking: { cursor: { "client-version": "cli-test" } },
  timeouts: {
    "messages-ms": 1000,
    "stream-messages-ms": 60000,
    "count-tokens-ms": 1000,
  },
  debug: "off",
} as unknown as Config;

const account = {
  token: {
    accessToken: "a",
    refreshToken: "r",
    email: "x@cursor.com",
    provider: "cursor",
    cursorServiceMachineId: "m",
  },
} as any;

const WEATHER_SCHEMA = {
  type: "object",
  properties: { city: { type: "string" }, days: { type: "number" } },
  required: ["city"],
};

/** Cursor asking for a client (MCP) tool: ExecServerMessage.mcp_args (11). */
function mcpCallFrame(
  id: string,
  name: string,
  args: Record<string, unknown>,
): Uint8Array {
  const entries = Object.entries(args).map(([k, val]) =>
    f(2, concatBytes([f(1, k), f(2, encodeProtoValue(val))])),
  );
  const mcpArgs = concatBytes([f(1, name), ...entries, f(3, id), f(5, name)]);
  return connectFrame(
    f(2, concatBytes([v(1, 4), f(15, "exec-9"), f(11, mcpArgs)])),
  );
}
const textFrame = (t: string) => connectFrame(f(1, f(1, f(1, t))));

function session(chunks: Uint8Array[]) {
  const written: Uint8Array[] = [];
  const s: CursorAgentSession = {
    status: 200,
    headers: {},
    chunks: (async function* () {
      for (const c of chunks) yield c;
    })(),
    write: (frame) => written.push(frame),
    close: () => {},
  };
  return { s, written };
}

// ---------------------------------------------------------------- inputs

test("chat history: tool calls become text, tool results become user blocks", () => {
  const msgs = agentMessagesFromBody({
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: "Weather in Paris and Lyon?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function",
            function: { name: "weather", arguments: '{"city":"Paris"}' },
          },
          {
            id: "c2",
            type: "function",
            function: { name: "weather", arguments: '{"city":"Lyon"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "12°C" },
      { role: "tool", tool_call_id: "c2", content: "14°C & <sun>" },
    ],
  });
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["system", "user", "assistant", "user"],
    "parallel tool results merge into one user turn",
  );
  assert.match(
    msgs[2].content,
    /\[tool_call id=c1 name=weather args=\{"city":"Paris"\}\]/,
  );
  assert.match(
    msgs[3].content,
    /<tool_name>weather<\/tool_name>\n<tool_call_id>c1<\/tool_call_id>\n<result>12°C<\/result>/,
  );
  assert.match(msgs[3].content, /14°C &amp; &lt;sun&gt;/);
});

test("anthropic and responses histories map the same way", () => {
  const anthropic = agentMessagesFromBody({
    system: [{ type: "text", text: "sys" }],
    messages: [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "Checking." },
          {
            type: "tool_use",
            id: "tu1",
            name: "weather",
            input: { city: "Nice" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu1",
            content: [{ type: "text", text: "20°C" }],
          },
        ],
      },
    ],
  });
  assert.deepEqual(
    anthropic.map((m) => m.role),
    ["system", "user", "assistant", "user"],
  );
  assert.equal(
    anthropic[2].content,
    'Checking.\n[tool_call id=tu1 name=weather args={"city":"Nice"}]',
  );
  assert.match(
    anthropic[3].content,
    /<tool_name>weather<\/tool_name>[\s\S]*<result>20°C<\/result>/,
  );

  const responses = agentMessagesFromBody({
    instructions: "sys",
    input: [
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "reasoning", summary: [] },
      {
        type: "function_call",
        call_id: "fc1",
        name: "weather",
        arguments: '{"city":"Nice"}',
      },
      { type: "function_call_output", call_id: "fc1", output: "20°C" },
    ],
  });
  assert.deepEqual(
    responses.map((m) => m.role),
    ["system", "user", "assistant", "user"],
  );
  assert.match(responses[3].content, /<tool_name>weather<\/tool_name>/);
});

test("function tools are read from all three shapes, other tool kinds dropped", () => {
  const chat = clientToolsFromBody({
    tools: [
      {
        type: "function",
        function: {
          name: "weather",
          description: "d",
          parameters: WEATHER_SCHEMA,
        },
      },
    ],
  });
  const anthropic = clientToolsFromBody({
    tools: [
      { name: "weather", description: "d", input_schema: WEATHER_SCHEMA },
      { type: "web_search_20250305", name: "web_search" },
    ],
  });
  const responses = clientToolsFromBody({
    tools: [
      {
        type: "function",
        name: "weather",
        description: "d",
        parameters: WEATHER_SCHEMA,
      },
      { type: "web_search" },
    ],
  });
  for (const tools of [chat, anthropic, responses]) {
    assert.deepEqual(tools, [
      { name: "weather", description: "d", schema: WEATHER_SCHEMA },
    ]);
  }
});

// ------------------------------------------------------------- protobuf

test("google.protobuf.Value round-trips schemas and arguments", () => {
  const value = {
    a: "x",
    n: 2.5,
    b: true,
    z: null,
    list: [1, "two", { deep: false }],
  };
  assert.deepEqual(decodeProtoValue(encodeProtoValue(value)), value);
});

test("tools are served in request_context and MCP state answers, not on the run frame", () => {
  const defs = encodeMcpToolDefinitions([
    { name: "weather", description: "d", schema: WEATHER_SCHEMA },
  ]);
  const frame = buildAgentRunFrame(
    [{ role: "user", content: "hi" }],
    "gpt-5.5-medium",
    null,
  );
  const run = parseFields(parseFields(frame.slice(5))[0].bytes!);
  assert.deepEqual(
    run.map((x) => x.field),
    [1, 2, 3, 9],
  );

  const execPayload = (variant: number, inner = new Uint8Array(0)) =>
    concatBytes([v(1, 3), f(15, "e1"), f(variant, inner)]);
  const replyResult = (frame: Uint8Array, field: number) => {
    const exec = parseFields(parseFields(frame.slice(5))[0].bytes!);
    return exec.find((x) => x.field === field)!.bytes!;
  };
  const defFields = (bytes: Uint8Array) => {
    const d = parseFields(bytes);
    const s = (n: number) =>
      Buffer.from(d.find((x) => x.field === n)!.bytes!).toString("utf8");
    return {
      name: s(1),
      description: s(2),
      provider: s(4),
      toolName: s(5),
      schema: decodeProtoValue(d.find((x) => x.field === 3)!.bytes!),
    };
  };
  const expected = {
    name: "weather",
    description: "d",
    provider: "oauth2api",
    toolName: "weather",
    schema: WEATHER_SCHEMA,
  };

  // request_context: RequestContextResult.success.request_context.tools (7)
  const ctx = answerExecRequest(execPayload(10), defs) as any;
  assert.equal(ctx.kind, "reply");
  const context = parseFields(
    parseFields(parseFields(replyResult(ctx.frame, 10))[0].bytes!)[0].bytes!,
  );
  assert.deepEqual(
    defFields(context.find((x) => x.field === 7)!.bytes!),
    expected,
  );

  // mcp_state (36): success.servers[0] { name, identifier, tools (5), status }
  const state = answerExecRequest(execPayload(36), defs) as any;
  const server = parseFields(
    parseFields(parseFields(replyResult(state.frame, 36))[0].bytes!)[0].bytes!,
  );
  const str = (n: number) =>
    Buffer.from(server.find((x) => x.field === n)!.bytes!).toString("utf8");
  assert.equal(str(1), "oauth2api");
  assert.equal(str(7), "connected");
  assert.deepEqual(
    defFields(server.find((x) => x.field === 5)!.bytes!),
    expected,
  );
  // A request for other servers only gets an empty list.
  const other = answerExecRequest(execPayload(36, f(1, "github")), defs) as any;
  assert.equal(parseFields(replyResult(other.frame, 36))[0].bytes!.length, 0);

  // MCP allowlist precheck (42): empty result ("not allowlisted").
  const pre = answerExecRequest(execPayload(42), defs) as any;
  assert.equal(pre.kind, "reply");
  assert.equal(replyResult(pre.frame, 42).length, 0);
});

test("decodeMcpCall reads name, id and typed args", () => {
  const frame = mcpCallFrame("call-1", "weather", { city: "Paris", days: 3 });
  const exec = parseFields(parseFields(frame.slice(5))[0].bytes!);
  const call = decodeMcpCall(exec.find((x) => x.field === 11)!.bytes!);
  assert.deepEqual(call, {
    id: "call-1",
    name: "weather",
    arguments: '{"city":"Paris","days":3}',
  });
});

// ----------------------------------------------------------------- turns

test("an MCP call ends the turn and is handed back, parallel calls kept", async () => {
  const { s, written } = session([
    concatBytes([
      textFrame("Let me check."),
      mcpCallFrame("c1", "weather", { city: "Paris" }),
      mcpCallFrame("c2", "weather", { city: "Lyon" }),
    ]),
    textFrame("never read"),
  ]);
  const items = [];
  for await (const d of agentSessionDeltas(s)) items.push(d);
  const done = items.pop() as any;
  assert.deepEqual(
    items.filter((d: any) => d.toolCall).map((d: any) => d.toolCall.id),
    ["c1", "c2"],
  );
  assert.equal(done.aggregatedText, "Let me check.");
  assert.equal(done.toolCalls.length, 2);
  assert.equal(done.error, undefined);
  assert.equal(
    written.length,
    0,
    "client tools are not answered on the stream",
  );
});

async function toolTurn(format: string, body: any): Promise<string> {
  __setCursorAgentTransports({
    run: async () =>
      session([mcpCallFrame("c1", "weather", { city: "Paris" })]).s,
  });
  try {
    const resp = await callCursorResponses({
      body: { model: "cursor-gpt-5.5", ...body },
      account,
      config,
      responseFormat: format,
    } as any);
    assert.equal(resp.status, 200);
    return await resp.text();
  } finally {
    __setCursorAgentTransports(null);
  }
}

test("tool calls come out in Chat, Anthropic and Responses formats", async (t) => {
  __resetCursorClientVersion();
  t.after(() => __resetCursorClientVersion());
  const tools = [
    {
      type: "function",
      function: { name: "weather", parameters: WEATHER_SCHEMA },
    },
  ];
  const messages = [{ role: "user", content: "Weather in Paris?" }];

  const chat = await toolTurn("openai-chat-completions", { messages, tools });
  assert.match(
    chat,
    /"tool_calls":\[\{"index":0,"id":"c1","type":"function","function":\{"name":"weather","arguments":"\{\\"city\\":\\"Paris\\"\}"\}\}\]/,
  );
  assert.match(chat, /"finish_reason":"tool_calls"/);

  const anthropic = await toolTurn("anthropic-messages", { messages, tools });
  assert.match(
    anthropic,
    /"content_block":\{"type":"tool_use","id":"c1","name":"weather","input":\{\}\}/,
  );
  assert.match(
    anthropic,
    /"type":"input_json_delta","partial_json":"\{\\"city\\":\\"Paris\\"\}"/,
  );
  assert.match(anthropic, /"stop_reason":"tool_use"/);

  const responses = await toolTurn("openai-responses", {
    input: "Weather in Paris?",
    tools,
  });
  assert.match(
    responses,
    /event: response\.output_item\.done\ndata: .*"type":"function_call".*"call_id":"c1".*"name":"weather"/,
  );
  const completed = JSON.parse(
    responses
      .split("\n")
      .find((l) => l.includes('"response.completed"'))!
      .slice(6),
  );
  assert.deepEqual(
    completed.response.output.map((o: any) => o.type),
    ["function_call"],
  );
});

test("an unanswerable request is an error, not the held thinking", async () => {
  const unknownExec = connectFrame(
    f(2, concatBytes([v(1, 5), f(15, "e"), f(99, new Uint8Array(0))])),
  );
  const thinking = connectFrame(
    f(1, f(4, f(1, "I need GetDynamicTools first."))),
  );
  const { s } = session([concatBytes([thinking, unknownExec])]);
  const items = [];
  for await (const d of agentSessionDeltas(s)) items.push(d);
  const done = items.pop() as any;
  assert.equal(done.aggregatedText, "");
  assert.match(done.error, /unsupported IDE tool \(exec 99\)/);
});
