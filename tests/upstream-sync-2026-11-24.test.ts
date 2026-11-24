// Fixes ported from upstream (CLIProxyAPI / 9router) on 2026-11-24.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  openaiToAnthropic,
  createStreamState,
  anthropicSSEToChat,
  makeResponsesState,
  anthropicSSEToResponses,
} from "../src/upstream/translator";
import { applyCloaking } from "../src/upstream/cloaking";
import { __resetAutoCache } from "../src/upstream/auto-cache";

// ── 1. Claude parameterless tool call streamed to OpenAI clients (CPA dd866f6c / 28a00389) ──

const parse = (chunk: string): any => JSON.parse(chunk.replace(/^data: /, "").trim());
const event = (chunk: string): any => JSON.parse(chunk.split("\n").find((l) => l.startsWith("data: "))!.slice(6));

test("chat stream: empty input_json_delta ends with arguments {}", () => {
  const state = createStreamState("sonnet", false);
  anthropicSSEToChat("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "now", input: {} } }, state);
  anthropicSSEToChat("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "" } }, state);
  const out = anthropicSSEToChat("content_block_stop", { index: 0 }, state);
  assert.equal(out.length, 1);
  assert.deepEqual(parse(out[0]).choices[0].delta.tool_calls, [{ index: 0, function: { arguments: "{}" } }]);
});

test("chat stream: tool call with arguments and text blocks are left alone at stop", () => {
  const state = createStreamState("sonnet", false);
  anthropicSSEToChat("content_block_start", { index: 0, content_block: { type: "text", text: "" } }, state);
  assert.deepEqual(anthropicSSEToChat("content_block_stop", { index: 0 }, state), []);
  anthropicSSEToChat("content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_2", name: "f", input: {} } }, state);
  anthropicSSEToChat("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"a":1}' } }, state);
  assert.deepEqual(anthropicSSEToChat("content_block_stop", { index: 1 }, state), []);
});

test("responses stream: parameterless call gets a {} delta and {} in the done events", () => {
  const state = makeResponsesState();
  const usage: any = { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
  anthropicSSEToResponses("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "now", input: {} } }, state, "sonnet", usage);
  anthropicSSEToResponses("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: "" } }, state, "sonnet", usage);
  const out = anthropicSSEToResponses("content_block_stop", { index: 0 }, state, "sonnet", usage).map(event);
  assert.deepEqual(out.map((e) => e.type), [
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.output_item.done",
  ]);
  assert.equal(out[0].delta, "{}");
  assert.equal(out[1].arguments, "{}");
  assert.equal(out[2].item.arguments, "{}");
});

// ── 2. Claude thinking budget never below 1024 (CPA 75d03aea) ──

const chat = (model: string, extra: any = {}) =>
  openaiToAnthropic({ model, messages: [{ role: "user", content: "hi" }], ...extra });

test("thinking budget: minimal is raised to 1024 on Claude budget models only", () => {
  assert.equal(chat("claude-sonnet-4-6", { reasoning_effort: "minimal" }).thinking.budget_tokens, 1024);
  assert.equal(chat("ag/claude-opus-5-5-low", { reasoning_effort: "minimal" }).thinking.budget_tokens, 1024);
  assert.equal(chat("gemini-3.8-flash-medium", { reasoning_effort: "minimal" }).thinking.budget_tokens, 512);
  assert.equal(chat("claude-sonnet-4-6", { reasoning_effort: "medium" }).thinking.budget_tokens, 8192);
  assert.deepEqual(chat("claude-sonnet-4-6", { reasoning_effort: "none" }).thinking, { type: "disabled" });
});

// ── 3. Billing line at the head of a client system text (9router 971ae638) ──

beforeEach(() => __resetAutoCache());

const acct: any = { deviceId: "d", accountUuid: "a" };
const req: any = { headers: { authorization: "Bearer k" }, body: {} };
const cloak = (system: any) =>
  applyCloaking({
    request: req,
    account: acct,
    config: { cloaking: {}, "prompt-cache": { auto: false } } as any,
    body: { model: "claude-opus-5-5", system, messages: [{ role: "user", content: "hi" }] },
  });

const LINE = "x-anthropic-billing-header: cc_version=2.1.321.abc; cc_entrypoint=cli; cc_workload=cron;";

test("billing line joined with the system text becomes system[0], the rest stays cacheable", () => {
  const out = cloak([{ type: "text", text: `${LINE}\nYou are a helpful agent.\nRules...`, cache_control: { type: "ephemeral" } }]);
  assert.equal(out.system[0].text, LINE);
  assert.equal(out.system[0].cache_control, undefined);
  assert.match(out.system[1].text, /^You are Claude Code/);
  assert.equal(out.system[2].text, "You are a helpful agent.\nRules...");
  assert.deepEqual(out.system[2].cache_control, { type: "ephemeral" });
  assert.equal(out.system.filter((b: any) => b.text.includes("x-anthropic-billing-header")).length, 1);
});

test("billing line: CRLF and case are handled, only one billing block is kept", () => {
  const out = cloak([
    { type: "text", text: `X-Anthropic-Billing-Header: cc_version=1\r\nfirst` },
    { type: "text", text: `${LINE}\nsecond` },
  ]);
  assert.equal(out.system[0].text, "X-Anthropic-Billing-Header: cc_version=1");
  assert.deepEqual(out.system.slice(2).map((b: any) => b.text), ["first", "second"]);
});

test("billing line: a standalone client billing block wins, joined lines are dropped", () => {
  const out = cloak([
    { type: "text", text: LINE },
    { type: "text", text: `${LINE}\nbody` },
  ]);
  assert.equal(out.system[0].text, LINE);
  assert.deepEqual(out.system.slice(2).map((b: any) => b.text), ["body"]);
});

test("billing line: plain system text is untouched, a header is generated", () => {
  const out = cloak("Just a system prompt");
  assert.match(out.system[0].text, /^x-anthropic-billing-header: cc_version=/);
  assert.equal(out.system[2].text, "Just a system prompt");
});
