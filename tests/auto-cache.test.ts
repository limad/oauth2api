import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { applyCloaking } from "../src/upstream/cloaking";
import { __resetAutoCache } from "../src/upstream/auto-cache";

const acct: any = { deviceId: "d", accountUuid: "a" };
const cfg = (auto?: boolean): any => ({
  cloaking: {},
  ...(auto === undefined ? {} : { "prompt-cache": { auto } }),
});
const req = (key = "k"): any => ({ headers: { authorization: `Bearer ${key}` }, body: {} });

/** Body as the chat/completions -> Anthropic translator produces it. */
function agentTurn(extra: any[] = []): any {
  return {
    model: "claude-opus-5-5",
    tools: [{ name: "read", input_schema: { type: "object" } }],
    system: [{ type: "text", text: "You are a code auditor." }],
    messages: [
      { role: "user", content: "Audit the plugin." },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "file 1" }] },
      ...extra,
    ],
  };
}

const marks = (out: any): string[] => {
  const paths: string[] = [];
  (out.system ?? []).forEach((b: any, i: number) => b.cache_control && paths.push(`system[${i}]`));
  (out.messages ?? []).forEach((m: any, i: number) =>
    Array.isArray(m.content) &&
    m.content.forEach((b: any, j: number) => b.cache_control && paths.push(`messages[${i}][${j}]`)),
  );
  return paths;
};

beforeEach(() => __resetAutoCache());

test("auto-cache: first sight of a prompt adds nothing beyond the injected prefix", () => {
  const out = applyCloaking({ request: req(), account: acct, config: cfg(), body: agentTurn() });
  assert.deepEqual(marks(out), ["system[1]"]);
});

test("auto-cache: a repeated prompt gets last message, previous user turn and client system", () => {
  applyCloaking({ request: req(), account: acct, config: cfg(), body: agentTurn() });
  const out = applyCloaking({
    request: req(), account: acct, config: cfg(),
    body: agentTurn([
      { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "file 2" }] },
    ]),
  });
  // system[1] = injected prefix, system[2] = client system, messages[4] = last, messages[2] = previous user turn
  assert.deepEqual(marks(out), ["system[1]", "system[2]", "messages[2][0]", "messages[4][0]"]);
  // string content is turned into one text block carrying the breakpoint
  const two = applyCloaking({ request: req(), account: acct, config: cfg(), body: agentTurn([
    { role: "assistant", content: "ok" },
    { role: "user", content: "next" },
  ]) });
  assert.deepEqual(two.messages[4].content, [{ type: "text", text: "next", cache_control: { type: "ephemeral" } }]);
});

test("auto-cache: never more than 4 breakpoints", () => {
  applyCloaking({ request: req(), account: acct, config: cfg(), body: agentTurn() });
  const out = applyCloaking({ request: req(), account: acct, config: cfg(), body: agentTurn() });
  assert.ok(marks(out).length <= 4);
});

test("auto-cache: a client that sets its own cache_control is left alone", () => {
  const body = agentTurn();
  body.system[0].cache_control = { type: "ephemeral" };
  applyCloaking({ request: req(), account: acct, config: cfg(), body });
  const out = applyCloaking({ request: req(), account: acct, config: cfg(), body });
  assert.deepEqual(marks(out), ["system[1]", "system[2]"]);
});

test("auto-cache: a system prompt that changes every time is never marked", () => {
  for (let i = 0; i < 3; i++) {
    const body = agentTurn();
    body.system[0].text = `You are a code auditor. Now: ${i}`;
    const out = applyCloaking({ request: req(), account: acct, config: cfg(), body });
    assert.deepEqual(marks(out), ["system[1]"]);
  }
});

test("auto-cache: prompts of another client key or model are not shared", () => {
  applyCloaking({ request: req("a"), account: acct, config: cfg(), body: agentTurn() });
  const other = applyCloaking({ request: req("b"), account: acct, config: cfg(), body: agentTurn() });
  assert.deepEqual(marks(other), ["system[1]"]);
  const sonnet = { ...agentTurn(), model: "claude-sonnet-5-5" };
  assert.deepEqual(marks(applyCloaking({ request: req("a"), account: acct, config: cfg(), body: sonnet })), ["system[1]"]);
});

test("auto-cache: disabled by prompt-cache.auto false", () => {
  applyCloaking({ request: req(), account: acct, config: cfg(false), body: agentTurn() });
  const out = applyCloaking({ request: req(), account: acct, config: cfg(false), body: agentTurn() });
  assert.deepEqual(marks(out), ["system[1]"]);
});

test("auto-cache: thinking and empty text blocks never carry the breakpoint", () => {
  const body = agentTurn([
    { role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "s" }, { type: "text", text: "" }] },
  ]);
  applyCloaking({ request: req(), account: acct, config: cfg(), body });
  const out = applyCloaking({ request: req(), account: acct, config: cfg(), body });
  const last = out.messages[out.messages.length - 1].content;
  assert.equal(last[0].cache_control, undefined);
  assert.equal(last[1].cache_control, undefined);
  // the previous user turn (tool_result) is still marked
  assert.ok(out.messages[2].content[0].cache_control);
});
