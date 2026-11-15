// Fixes ported from upstream (CLIProxyAPI / 9router) on 2026-11-15.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { openaiToAnthropic, responsesToAnthropic, usesAdaptiveThinking } from "../src/upstream/translator";
import { applyCloaking, computeFingerprint } from "../src/upstream/cloaking";
import { __resetAutoCache } from "../src/upstream/auto-cache";
import { anthropicToGeminiContents } from "../src/upstream/gemini-translator";
import { DEFAULT_CLI_VERSION } from "../src/upstream/anthropic-api";

const chat = (model: string, extra: any = {}) =>
  openaiToAnthropic({ model, messages: [{ role: "user", content: "hi" }], ...extra });

// ── 1. Claude 5.x adaptive thinking (9router 8aef7480) ──

test("adaptive thinking: only the Claude 5.x direct ids", () => {
  for (const m of ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-fable-5-1", "claude-fable-5-2"]) {
    assert.equal(usesAdaptiveThinking(m), true, m);
  }
  for (const m of ["claude-sonnet-4-6", "claude-haiku-4-5-20251001", "ag/claude-opus-5-5-low", "claude-mythos-preview"]) {
    assert.equal(usesAdaptiveThinking(m), false, m);
  }
});

test("adaptive thinking: haiku-5-5 gets type adaptive + output_config.effort, never enabled", () => {
  const out = chat("claude-haiku-5-5", { reasoning_effort: "high", max_tokens: 1000 });
  assert.deepEqual(out.thinking, { type: "adaptive" });
  assert.deepEqual(out.output_config, { effort: "high" });
  assert.equal(out.max_tokens, 1000, "no budget, so max_tokens is left alone");
});

test("adaptive thinking: effort mapping", () => {
  assert.equal(chat("claude-sonnet-5-5", { reasoning_effort: "minimal" }).output_config.effort, "low");
  assert.equal(chat("claude-sonnet-5-5", { reasoning_effort: "xhigh" }).output_config.effort, "xhigh");
  assert.equal(chat("claude-sonnet-5-5", { reasoning_effort: "max" }).output_config.effort, "max");
  assert.equal(chat("claude-sonnet-5-5", { reasoning_effort: "weird" }).output_config.effort, "medium");
});

test("adaptive thinking: none disables where allowed, clamps to low on always-on models", () => {
  const sonnet = chat("claude-sonnet-5-5", { reasoning_effort: "none" });
  assert.deepEqual(sonnet.thinking, { type: "disabled" });
  assert.equal(sonnet.output_config, undefined);

  for (const m of ["claude-opus-5-5", "claude-fable-5-2"]) {
    const out = chat(m, { reasoning_effort: "none" });
    assert.equal(out.thinking, undefined, m);
    assert.deepEqual(out.output_config, { effort: "low" }, m);
  }
  const opusHigh = chat("claude-opus-5-5", { reasoning_effort: "high" });
  assert.equal(opusHigh.thinking, undefined);
  assert.deepEqual(opusHigh.output_config, { effort: "high" });
});

test("adaptive thinking: response_format keeps the effort in output_config", () => {
  const out = chat("claude-haiku-5-5", {
    reasoning_effort: "low",
    response_format: { type: "json_schema", json_schema: { name: "x", schema: { type: "object" } } },
  });
  assert.equal(out.output_config.effort, "low");
  assert.equal(out.output_config.format.type, "json_schema");
});

test("adaptive thinking: Responses reasoning.summary becomes display", () => {
  const out = responsesToAnthropic({
    model: "claude-opus-5-5",
    input: "hi",
    reasoning: { effort: "medium", summary: "detailed" },
  });
  assert.deepEqual(out.thinking, { type: "adaptive", display: "summarized" });
  assert.deepEqual(out.output_config, { effort: "medium" });
});

test("budget thinking unchanged for 4.x and Antigravity ids", () => {
  const out = chat("claude-sonnet-4-6", { reasoning_effort: "high" });
  assert.deepEqual(out.thinking, { type: "enabled", budget_tokens: 24576 });
  assert.equal(out.output_config, undefined);
  const ag = chat("ag/claude-opus-5-5-low", { reasoning_effort: "high" });
  assert.equal(ag.thinking.type, "enabled");
});

// ── 2. Claude Code version (CLIProxyAPI #7392) ──

test("Claude Code 2.1.321: fingerprint matches the native capture", () => {
  assert.equal(DEFAULT_CLI_VERSION, "2.1.321");
  // CLIProxyAPI claude_executor_cli_2321_test.go: cc_version=2.1.321.20d for "say ok".
  assert.equal(computeFingerprint("say ok", "2.1.321"), "20d");
});

// ── 3. Top-level cache_control (CLIProxyAPI beb43359) ──

beforeEach(() => __resetAutoCache());

const acct: any = { deviceId: "d", accountUuid: "a" };
const req: any = { headers: { authorization: "Bearer k" }, body: {} };
const countMarks = (out: any): number => {
  const count = (blocks: any): number =>
    Array.isArray(blocks) ? blocks.reduce((n: number, b: any) => n + (b?.cache_control ? 1 : 0) + count(b?.content), 0) : 0;
  return (out.cache_control ? 1 : 0) + count(out.tools) + count(out.system) +
    (out.messages ?? []).reduce((n: number, m: any) => n + count(m.content), 0);
};

test("top-level cache_control is moved onto the last cacheable block, no auto cache added", () => {
  const out = applyCloaking({
    request: req,
    account: acct,
    config: { cloaking: {} } as any,
    body: {
      model: "claude-opus-5-5",
      cache_control: { type: "ephemeral" },
      system: [{ type: "text", text: "sys" }],
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: [{ type: "text", text: "a" }, { type: "thinking", thinking: "t", signature: "s" }] },
      ],
    },
  });
  assert.equal(out.cache_control, undefined);
  assert.deepEqual(out.messages[1].content[0].cache_control, { type: "ephemeral" });
  assert.equal(out.messages[1].content[1].cache_control, undefined, "thinking blocks are not cacheable");
  assert.ok(countMarks(out) <= 4, `breakpoints: ${countMarks(out)}`);
  // client breakpoint + injected prefix only: the auto cache stays out
  assert.equal(countMarks(out), 2);
});

test("top-level 1h cache_control: injected prefix also uses 1h (no 5m before 1h)", () => {
  const out = applyCloaking({
    request: req,
    account: acct,
    config: { cloaking: {} } as any,
    body: {
      model: "claude-opus-5-5",
      cache_control: { type: "ephemeral", ttl: "1h" },
      messages: [{ role: "user", content: "hello" }],
    },
  });
  assert.deepEqual(out.messages[0].content, [{ type: "text", text: "hello", cache_control: { type: "ephemeral", ttl: "1h" } }]);
  const prefix = out.system.find((b: any) => b.cache_control);
  assert.equal(prefix.cache_control.ttl, "1h");
});

// ── 4. Gemini schema annotations (9router cdcd09cc) ──

test("Gemini schemas drop optional / ~optional and annotation keys, keep property names", () => {
  const out = anthropicToGeminiContents({
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        name: "t",
        input_schema: {
          type: "object",
          "~optional": true,
          "x-vendor": 1,
          properties: {
            optional: { type: "string", deprecated: true, readOnly: true },
            meta: {
              type: "object",
              optional: true,
              markdownDescription: "**m**",
              properties: { list: { type: "array", items: { type: "string", "~optional": true, writeOnly: true, errorMessage: "e" } } },
            },
          },
        },
      },
    ],
  });
  assert.deepEqual(out.tools[0].functionDeclarations[0].parameters, {
    type: "object",
    properties: {
      optional: { type: "string" },
      meta: { type: "object", properties: { list: { type: "array", items: { type: "string" } } } },
    },
  });
});
