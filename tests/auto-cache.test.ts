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

const ttls = (out: any): string[] => {
  const all: any[] = [];
  (out.system ?? []).forEach((b: any) => b.cache_control && all.push(b.cache_control));
  (out.messages ?? []).forEach((m: any) =>
    Array.isArray(m.content) && m.content.forEach((b: any) => b.cache_control && all.push(b.cache_control)),
  );
  return all.map((c) => c.ttl ?? "5m");
};
const cfgTtl = (ttl: string): any => ({ cloaking: {}, "prompt-cache": { auto: true, ttl } });
const t0 = 1_800_000_000_000;

test("auto-cache ttl auto: agent loop = 1h on prefix and system, 5m on the history", () => {
  const body = agentTurn();
  const first = applyCloaking({ request: req(), account: acct, config: cfg(), body });
  assert.deepEqual(ttls(first), ["1h"]);
  const out = applyCloaking({ request: req(), account: acct, config: cfg(), body });
  // order: prefix, client system, previous user turn, last message
  assert.deepEqual(ttls(out), ["1h", "1h", "5m", "5m"]);
});

test("auto-cache ttl auto: a turn after a pause of more than 2 min caches the history 1h", async () => {
  const { applyAutoCache } = await import("../src/upstream/auto-cache");
  const mk = () => { const b = agentTurn(); return { b, sys: b.system }; };
  const a = mk();
  applyAutoCache(a.b, { clientSystem: a.sys, apiKeyHash: "h", used: 0, now: t0 });
  const b = mk();
  applyAutoCache(b.b, { clientSystem: b.sys, apiKeyHash: "h", used: 0, now: t0 + 3 * 60_000 });
  assert.deepEqual(ttls(b.b), ["1h", "1h", "1h"]);
  // seen 40 min ago still counts (1 h window), beyond 1 h it does not
  const c = mk();
  assert.equal(applyAutoCache(c.b, { clientSystem: c.sys, apiKeyHash: "h", used: 0, now: t0 + 43 * 60_000 }), 3);
  const d = mk();
  assert.equal(applyAutoCache(d.b, { clientSystem: d.sys, apiKeyHash: "h", used: 0, now: t0 + 110 * 60_000 }), 0);
});

test("auto-cache ttl 5m / 1h: one lifetime everywhere", () => {
  applyCloaking({ request: req(), account: acct, config: cfgTtl("5m"), body: agentTurn() });
  assert.deepEqual(ttls(applyCloaking({ request: req(), account: acct, config: cfgTtl("5m"), body: agentTurn() })), ["5m", "5m", "5m", "5m"]);
  __resetAutoCache();
  applyCloaking({ request: req(), account: acct, config: cfgTtl("1h"), body: agentTurn() });
  assert.deepEqual(ttls(applyCloaking({ request: req(), account: acct, config: cfgTtl("1h"), body: agentTurn() })), ["1h", "1h", "1h", "1h"]);
});

test("1h cache: beta header added for clients without betas, never for Claude Code's own", async () => {
  const { callAnthropicMessages } = await import("../src/upstream/anthropic-api");
  const seenHeaders: any[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (_u: any, init: any) => {
    seenHeaders.push(init.headers);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const config: any = { cloaking: {}, timeouts: { "messages-ms": 1000, "stream-messages-ms": 1000 } };
    const account: any = { token: { accessToken: "at" } };
    const body = { model: "claude-opus-5-5", system: [{ type: "text", text: "s", cache_control: { type: "ephemeral", ttl: "1h" } }], messages: [{ role: "user", content: "hi" }] };
    await callAnthropicMessages({ body, request: { headers: { authorization: "Bearer k" } } as any, account, config });
    await callAnthropicMessages({ body, request: { headers: { authorization: "Bearer k", "user-agent": "claude-cli/2.1.280 (external, cli)", "anthropic-beta": "oauth-2025-04-20,claude-code-20250219" } } as any, account, config });
    await callAnthropicMessages({ body: { ...body, system: "s" }, request: { headers: { authorization: "Bearer k" } } as any, account, config });
    assert.ok(seenHeaders[0]["anthropic-beta"].includes("extended-cache-ttl-2025-04-11"));
    assert.ok(!seenHeaders[1]["anthropic-beta"].includes("extended-cache-ttl"));
    assert.ok(!seenHeaders[2]["anthropic-beta"].includes("extended-cache-ttl"));
  } finally {
    globalThis.fetch = orig;
  }
});
