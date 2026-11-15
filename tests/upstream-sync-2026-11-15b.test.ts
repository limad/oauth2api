// Second batch ported from upstream (CLIProxyAPI) on 2026-11-15: Gemini
// zero-output abnormal finish -> 502 (cf07c78a), Antigravity 403
// TOS_VIOLATION -> long pause (5a351d95), Claude adaptive thinking -> Gemini
// thinkingConfig (gemini_claude_request.go).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountManager, MAX_RESET_HINT_MS } from "../src/accounts/manager";
import { TokenData } from "../src/auth/types";
import { isGoogleTosViolation, proxyWithRetry, REQUEST_ERROR_HEADER } from "../src/utils/http";
import { callGeminiMessages } from "../src/upstream/gemini-api";
import {
  anthropicToGeminiContents,
  hasNoVisibleOutput,
  isZeroOutputAbnormalFinish,
} from "../src/upstream/gemini-translator";

// ── 1. zero-output abnormal finish ──

test("zero output: only the three abnormal reasons, only without text or tool call", () => {
  for (const r of ["MALFORMED_FUNCTION_CALL", "unexpected_tool_call", " MALFORMED_RESPONSE "]) {
    assert.equal(isZeroOutputAbnormalFinish(r), true, r);
  }
  for (const r of ["STOP", "MAX_TOKENS", "SAFETY", "", undefined]) {
    assert.equal(isZeroOutputAbnormalFinish(r), false, String(r));
  }
  assert.equal(hasNoVisibleOutput({ content: [] }), true);
  assert.equal(hasNoVisibleOutput({ content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "  " }] }), true);
  assert.equal(hasNoVisibleOutput({ content: [{ type: "text", text: "ok" }] }), false);
  assert.equal(hasNoVisibleOutput({ content: [{ type: "tool_use", name: "f", input: {} }] }), false);
});

const account: any = { token: { accessToken: "t", geminiProjectId: "p", email: "g@x" } };
const config: any = { timeouts: { "messages-ms": 5000, "stream-messages-ms": 5000 } };
const request = (body: any): any => ({ headers: { authorization: "Bearer k" }, body });

async function withFetch(reply: () => Response, fn: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => reply()) as any;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const sse = (...chunks: any[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });

const malformed = { response: { candidates: [{ content: { role: "model", parts: [] }, finishReason: "MALFORMED_FUNCTION_CALL" }] } };

test("non-stream: MALFORMED_FUNCTION_CALL with no output -> 502 flagged as request error", () =>
  withFetch(
    () => new Response(JSON.stringify(malformed), { status: 200 }),
    async () => {
      const r = await callGeminiMessages({ request: request({ model: "gemini-4-argon", messages: [{ role: "user", content: "hi" }] }), account, config });
      assert.equal(r.status, 502);
      assert.equal(r.headers.get(REQUEST_ERROR_HEADER), "empty_output");
      const body = await r.json();
      assert.equal(body.type, "error");
      assert.match(body.error.message, /MALFORMED_FUNCTION_CALL/);
    },
  ));

test("non-stream: abnormal reason with text keeps the 200", () =>
  withFetch(
    () =>
      new Response(
        JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: "partial" }] }, finishReason: "MALFORMED_FUNCTION_CALL" }] } }),
        { status: 200 },
      ),
    async () => {
      const r = await callGeminiMessages({ request: request({ model: "gemini-4-argon", messages: [{ role: "user", content: "hi" }] }), account, config });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).content[0].text, "partial");
    },
  ));

test("stream: no output then abnormal finish -> 502 before any byte", () =>
  withFetch(
    () => sse({ response: { candidates: [{ content: { parts: [] } }] } }, malformed),
    async () => {
      const r = await callGeminiMessages({
        request: request({ model: "gemini-4-argon", stream: true, messages: [{ role: "user", content: "hi" }] }),
        account,
        config,
      });
      assert.equal(r.status, 502);
      assert.equal(r.headers.get(REQUEST_ERROR_HEADER), "empty_output");
    },
  ));

test("stream: output then abnormal finish keeps the 200 stream, with the buffered frames first", () =>
  withFetch(
    () =>
      sse(
        { response: { candidates: [{ content: { parts: [] } }] } },
        { response: { candidates: [{ content: { parts: [{ text: "Hel" }] } }] } },
        { response: { candidates: [{ content: { parts: [{ text: "lo" }] }, finishReason: "MALFORMED_FUNCTION_CALL" }] } },
      ),
    async () => {
      const r = await callGeminiMessages({
        request: request({ model: "gemini-4-argon", stream: true, messages: [{ role: "user", content: "hi" }] }),
        account,
        config,
      });
      assert.equal(r.status, 200);
      const text = await r.text();
      assert.ok(text.startsWith("event: message_start"), text.slice(0, 40));
      assert.match(text, /"text":"Hel"/);
      assert.match(text, /"text":"lo"/);
      assert.match(text, /message_stop/);
    },
  ));

test("stream: normal STOP with no output stays a 200 (empty answer is not abnormal)", () =>
  withFetch(
    () => sse({ response: { candidates: [{ content: { parts: [] }, finishReason: "STOP" }] } }),
    async () => {
      const r = await callGeminiMessages({
        request: request({ model: "gemini-4-argon", stream: true, messages: [{ role: "user", content: "hi" }] }),
        account,
        config,
      });
      assert.equal(r.status, 200);
      assert.match(await r.text(), /message_stop/);
    },
  ));

// ── proxyWithRetry: request error header, TOS_VIOLATION ──

function withManager(emails: string[], fn: (m: AccountManager) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-sync15b-"));
  const m = new AccountManager(dir, {
    provider: "gemini",
    refresh: async (): Promise<TokenData> => {
      throw new Error("no refresh in this test");
    },
  });
  for (const email of emails) {
    m.addAccount({
      accessToken: "a-" + email,
      refreshToken: "r",
      email,
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      accountUuid: "u",
      provider: "gemini",
    });
  }
  return fn(m).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function mockResponse(): any {
  const r = new EventEmitter() as any;
  Object.assign(r, { headers: {}, locals: { stats: {} }, headersSent: false, destroyed: false, writableEnded: false });
  r.setHeader = (k: string, v: string) => ((r.headers[k.toLowerCase()] = v), r);
  r.status = (c: number) => ((r.statusCode = c), r);
  r.json = (b: any) => ((r.body = b), (r.headersSent = true), r);
  return r;
}

test("proxyWithRetry: proxy-built 502 is surfaced once, no cooldown, stats kind from the header", () =>
  withManager(["a@x", "b@x"], async (m) => {
    let calls = 0;
    const resp = mockResponse();
    await proxyWithRetry("T", resp, { debug: "off" } as any, {
      manager: m,
      upstream: async () => {
        calls++;
        return new Response(JSON.stringify({ type: "error", error: { type: "api_error", message: "empty" } }), {
          status: 502,
          headers: { [REQUEST_ERROR_HEADER]: "empty_output" },
        });
      },
      success: async () => assert.fail("not a success"),
    });
    assert.equal(calls, 1, "no retry");
    assert.equal(resp.statusCode, 502);
    assert.equal(resp.locals.stats.failureKind, "empty_output");
    assert.ok(m.getSnapshots().every((s) => s.cooldownUntil === 0), "no account cooled down");
  }));

const tosBody = JSON.stringify({
  error: {
    code: 403,
    message: "This service has been disabled in this account for violation of Terms of Service.",
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "TOS_VIOLATION",
        domain: "cloudcode-pa.googleapis.com",
        metadata: { appeal_url: "https://example.invalid/appeal" },
      },
    ],
  },
});

test("TOS_VIOLATION signature: 403 + google.rpc.ErrorInfo reason only", () => {
  assert.equal(isGoogleTosViolation(403, tosBody), true);
  assert.equal(isGoogleTosViolation(429, tosBody), false);
  assert.equal(isGoogleTosViolation(403, JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "TOS_VIOLATION" } })), false);
  assert.equal(isGoogleTosViolation(403, "not json"), false);
});

test("proxyWithRetry: 403 TOS_VIOLATION pauses the account for MAX_RESET_HINT_MS, plain 403 keeps the short backoff", () =>
  withManager(["a@x", "b@x"], async (m) => {
    const run = (body: string) => {
      const resp = mockResponse();
      return proxyWithRetry("T", resp, { debug: "off" } as any, {
        manager: m,
        upstream: async () => new Response(body, { status: 403 }),
        success: async () => assert.fail("not a success"),
      }).then(() => resp);
    };
    const before = Date.now();
    const r = await run(tosBody);
    assert.equal(r.statusCode, 403);
    const tos = m.getSnapshots().find((s) => s.lastError?.includes("TOS_VIOLATION"))!;
    assert.ok(tos, "lastError names TOS_VIOLATION");
    assert.ok(tos.cooldownUntil - before >= MAX_RESET_HINT_MS - 5_000);

    await run(JSON.stringify({ error: { code: 403, status: "PERMISSION_DENIED", message: "nope" } }));
    const plain = m.getSnapshots().find((s) => s.email !== tos.email)!;
    assert.ok(plain.cooldownUntil > 0 && plain.cooldownUntil - Date.now() <= 10 * 60_000 + 5_000);
  }));

// ── 3. adaptive thinking -> Gemini thinkingConfig ──

const gen = (extra: any) =>
  anthropicToGeminiContents({ messages: [{ role: "user", content: "hi" }], ...extra }).generationConfig;

test("adaptive thinking: effort maps to a thinkingBudget with thoughts returned", () => {
  assert.deepEqual(gen({ max_tokens: 32000, thinking: { type: "adaptive" }, output_config: { effort: "low" } }).thinkingConfig, {
    thinkingBudget: 1024,
    includeThoughts: true,
  });
  assert.equal(gen({ max_tokens: 128000, thinking: { type: "adaptive" }, output_config: { effort: "max" } }).thinkingConfig.thinkingBudget, 32768);
  assert.equal(gen({ thinking: { type: "adaptive" } }).thinkingConfig.thinkingBudget, 24576, "no effort = high");
  assert.equal(gen({ thinking: { type: "adaptive" }, output_config: { effort: "weird" } }).thinkingConfig.thinkingBudget, 24576);
});

test("adaptive thinking: capped at half of max_tokens, default kept when that is under 512, display omitted hides thoughts", () => {
  assert.equal(gen({ max_tokens: 8000, thinking: { type: "adaptive" }, output_config: { effort: "high" } }).thinkingConfig.thinkingBudget, 4000);
  assert.equal(gen({ max_tokens: 600, thinking: { type: "adaptive" } }).thinkingConfig, undefined);
  assert.equal(gen({ max_tokens: 32000, thinking: { type: "adaptive", display: "omitted" } }).thinkingConfig.includeThoughts, false);
});

test("enabled / disabled / absent thinking unchanged", () => {
  assert.deepEqual(gen({ thinking: { type: "enabled", budget_tokens: 2048 } }).thinkingConfig, { thinkingBudget: 2048, includeThoughts: true });
  assert.deepEqual(gen({ thinking: { type: "disabled" } }).thinkingConfig, { thinkingBudget: 0 });
  assert.equal(gen({}).thinkingConfig, undefined);
});
