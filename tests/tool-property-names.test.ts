import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeClaudeToolPropertyNames } from "../src/upstream/tool-property-names";

const PREFIX = "The input object must conform to the following JSON Schema.";

test("tools Claude accepts are returned untouched (same object)", () => {
  const body = {
    model: "claude-haiku-5-5",
    tools: [{ name: "read", description: "Read", input_schema: { type: "object", properties: { "file.path": { type: "string" }, "a-b_c": {} } } }],
    messages: [{ role: "user", content: "hi" }],
  };
  assert.equal(normalizeClaudeToolPropertyNames(body), body);
});

test("rejected property name: open schema, original schema in the description, strict removed", () => {
  const schema = { type: "object", properties: { "not[labels]": { type: "string" }, q: { type: "string" } }, required: ["q"] };
  const body = {
    tools: [
      { name: "search", description: "Search issues", strict: true, input_schema: schema },
      { name: "ok", input_schema: { type: "object", properties: { x: {} } } },
    ],
  };
  const out = normalizeClaudeToolPropertyNames(body);
  assert.notEqual(out, body, "copy, the client body is not mutated");
  assert.deepEqual(body.tools[0].input_schema, schema);
  const t = out.tools[0];
  assert.deepEqual(t.input_schema, { type: "object" });
  assert.equal(t.strict, undefined);
  assert.ok(t.description.startsWith("Search issues\n\n" + PREFIX));
  assert.ok(t.description.endsWith(JSON.stringify(schema)));
  assert.equal(out.tools[1], body.tools[1]);
});

test("nested positions are inspected, data keywords are not", () => {
  const nested = (s: any) => normalizeClaudeToolPropertyNames({ tools: [{ name: "t", input_schema: s }] }).tools[0].input_schema;
  assert.deepEqual(nested({ type: "object", properties: { a: { type: "array", items: { type: "object", properties: { "x y": {} } } } } }), { type: "object" });
  assert.deepEqual(nested({ anyOf: [{ properties: { "é": {} } }] }), { type: "object" });
  assert.deepEqual(nested({ $defs: { D: { properties: { ["k".repeat(65)]: {} } } } }), { type: "object" });
  const data = { type: "object", properties: { a: { type: "object", default: { "not[x]": 1 }, enum: [{ "a b": 1 }] } } };
  assert.deepEqual(nested(data), data, "default/enum values are data");
  const named = { type: "object", properties: { properties: { type: "object", properties: { ok: {} } } } };
  assert.deepEqual(nested(named), named, "a property named 'properties' is not a keyword");
});

test("server tools and inline tool_addition definitions", () => {
  const server = { type: "web_search_20250305", name: "web_search", max_uses: 3 };
  const out = normalizeClaudeToolPropertyNames({
    tools: [server],
    messages: [
      { role: "user", content: [{ type: "tool_addition", tool: { type: "tool_definition", definition: { name: "f", input_schema: { type: "object", properties: { "a[b]": {} } } } } }] },
    ],
  });
  assert.equal(out.tools[0], server);
  const def = out.messages[0].content[0].tool.definition;
  assert.deepEqual(def.input_schema, { type: "object" });
  assert.ok(def.description.startsWith(PREFIX));
});

test("messages and count_tokens send the normalized tools upstream", async () => {
  const { callAnthropicMessages, callAnthropicCountTokens } = await import("../src/upstream/anthropic-api");
  const sent: any[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_u: any, init: any) => {
    sent.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const config: any = { cloaking: {}, timeouts: { "messages-ms": 1000, "stream-messages-ms": 1000, "count-tokens-ms": 1000 } };
    const account: any = { token: { accessToken: "at" } };
    const body = { model: "claude-haiku-5-5", tools: [{ name: "s", input_schema: { type: "object", properties: { "not[labels]": {} } } }], messages: [{ role: "user", content: "hi" }] };
    await callAnthropicMessages({ body, request: { headers: { authorization: "Bearer k" } } as any, account, config });
    await callAnthropicCountTokens({ request: { headers: { authorization: "Bearer k" }, body } as any, account, config });
    for (const b of sent) assert.deepEqual(b.tools[0].input_schema, { type: "object" });
    assert.equal(sent.length, 2);
  } finally {
    globalThis.fetch = orig;
  }
});
