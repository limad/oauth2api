import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRegistry } from "../src/providers/registry";
import { mistralListedId } from "../src/providers/mistral";
import {
  normalizeMistralChatBody,
  mistralModelsFromResponse,
  stripMistralPrefix,
} from "../src/upstream/mistral-api";
import {
  runVibeBrowserLogin,
  assertUnderBase,
  mistralTokenFromKey,
  MISTRAL_NO_REFRESH,
} from "../src/auth/mistral/vibe-login";
import { extractUsage } from "../src/accounts/manager";
import { saveToken, loadAllTokens } from "../src/auth/token-storage";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-"));
const reg = buildRegistry(dir);

test("Mistral families route to the mistral provider, others are untouched", () => {
  for (const m of [
    "mistral-medium-latest",
    "codestral-latest",
    "magistral-medium-latest",
    "ministral-8b-latest",
    "devstral-small-latest",
    "mistral/labs-leanstral-1-5",
    "mistral-vibe-cli-latest",
  ]) {
    assert.equal(reg.forModel(m).id, "mistral", m);
  }
  assert.equal(reg.forModel("claude-sonnet-4-6").id, "anthropic");
  assert.equal(reg.forModel("gpt-5.5").id, "codex");
  assert.equal(reg.forModel("gemini-3.8-flash-medium").id, "gemini");
  assert.equal(reg.get("mistral").nativeFormat, "openai-chat");
  assert.equal(
    stripMistralPrefix("mistral/codestral-latest"),
    "codestral-latest",
  );
  assert.equal(
    stripMistralPrefix("mistral-small-latest"),
    "mistral-small-latest",
  );
  // Listed ids always route back to Mistral.
  for (const id of [
    "labs-leanstral-1-5",
    "zai-glm-5-3-flash",
    "codestral-latest",
  ]) {
    assert.equal(reg.forModel(mistralListedId(id)).id, "mistral", id);
  }
  assert.equal(
    mistralListedId("zai-glm-5-3-flash"),
    "mistral/zai-glm-5-3-flash",
  );
  assert.equal(mistralListedId("codestral-latest"), "codestral-latest");
});

test("chat body: only what Mistral rejects is renamed or dropped, nothing added", () => {
  const input = {
    model: "mistral/mistral-small-latest",
    messages: [
      { role: "developer", content: "sys" },
      { role: "user", content: [{ type: "text", text: "hi" }], name: "bob" },
      {
        role: "assistant",
        content: "ok",
        refusal: null,
        annotations: [],
        audio: null,
        reasoning_content: "r",
        name: "a",
        function_call: null,
        tool_calls: [
          {
            id: "call_x",
            type: "function",
            function: { name: "f", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_x", name: "f", content: "r" },
    ],
    max_completion_tokens: 50,
    seed: 7,
    user: "u",
    store: false,
    safety_identifier: "s",
    verbosity: "low",
    web_search_options: {},
    logit_bias: {},
    thinking: { type: "disabled" },
    stream: true,
    stream_options: { include_usage: true },
    parallel_tool_calls: true,
    tools: [
      {
        type: "function",
        function: { name: "f", parameters: { type: "object" } },
      },
    ],
    temperature: 0.2,
  };
  const before = JSON.stringify(input);
  const out = normalizeMistralChatBody(input);
  assert.equal(JSON.stringify(input), before, "input must not be mutated");
  assert.deepEqual(out, {
    model: "mistral-small-latest",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: "ok",
        tool_calls: [
          {
            id: "call_x",
            type: "function",
            function: { name: "f", arguments: "{}" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_x", name: "f", content: "r" },
    ],
    max_tokens: 50,
    random_seed: 7,
    stream: true,
    stream_options: { include_usage: true },
    parallel_tool_calls: true,
    tools: [
      {
        type: "function",
        function: { name: "f", parameters: { type: "object" } },
      },
    ],
    temperature: 0.2,
  });
  // A body already in Mistral form is returned unchanged (byte-neutral).
  const clean = {
    model: "codestral-latest",
    messages: [{ role: "user", content: "x" }],
    max_tokens: 3,
  };
  assert.equal(
    JSON.stringify(normalizeMistralChatBody(clean)),
    JSON.stringify(clean),
  );
});

test("legacy functions/function_call map to tools/tool_choice; explicit values win", () => {
  const out = normalizeMistralChatBody({
    model: "m",
    messages: [],
    functions: [{ name: "f", parameters: {} }],
    function_call: { name: "f" },
    max_tokens: 1,
    max_completion_tokens: 9,
  });
  assert.deepEqual(out.tools, [
    { type: "function", function: { name: "f", parameters: {} } },
  ]);
  assert.deepEqual(out.tool_choice, {
    type: "function",
    function: { name: "f" },
  });
  assert.equal(out.max_tokens, 1);
  assert.equal(
    "functions" in out ||
      "function_call" in out ||
      "max_completion_tokens" in out,
    false,
  );
});

test("model list keeps chat-capable, non-deprecated ids", () => {
  const now = Date.parse("2026-11-07T00:00:00Z");
  const models = mistralModelsFromResponse(
    {
      data: [
        {
          id: "mistral-small-latest",
          max_context_length: 128000,
          capabilities: {
            completion_chat: true,
            function_calling: true,
            vision: true,
          },
        },
        { id: "mistral-embed", capabilities: { completion_chat: false } },
        {
          id: "old-model",
          capabilities: { completion_chat: true },
          deprecation: "2026-01-01T00:00:00Z",
        },
        {
          id: "future-dep",
          capabilities: { completion_chat: true },
          deprecation: "2027-01-01T00:00:00Z",
        },
        { id: "codestral-latest", capabilities: { completion_chat: true } },
        { id: "codestral-latest", capabilities: { completion_chat: true } },
      ],
    },
    now,
  );
  assert.deepEqual(
    models.map((m) => m.id),
    ["codestral-latest", "future-dep", "mistral-small-latest"],
  );
  const small = models.find((m) => m.id === "mistral-small-latest")!;
  assert.equal(small.context_length, 128000);
  assert.deepEqual(small.capabilities, {
    tools: true,
    vision: true,
    reasoning: false,
  });
});

test("Chat Completions usage is read (non-stream)", () => {
  const u = extractUsage({
    usage: {
      prompt_tokens: 52,
      completion_tokens: 3,
      total_tokens: 55,
      prompt_tokens_details: { cached_tokens: 40 },
      completion_tokens_details: { reasoning_tokens: 2 },
    },
  });
  assert.deepEqual(u, {
    inputTokens: 52,
    outputTokens: 3,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 40,
    reasoningOutputTokens: 2,
  });
  // Anthropic shape still wins when present.
  assert.equal(
    extractUsage({ usage: { input_tokens: 5, output_tokens: 1 } }).inputTokens,
    5,
  );
});

test("token file round-trip keeps the mistral provider", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-tok-"));
  saveToken(d, {
    accessToken: "k",
    refreshToken: MISTRAL_NO_REFRESH,
    email: "a@b.c",
    expiresAt: "2036-01-01T00:00:00.000Z",
    accountUuid: "u",
    provider: "mistral",
    planType: "FREE",
  });
  assert.ok(fs.existsSync(path.join(d, "mistral-a@b.c.json")));
  const [t] = loadAllTokens(d, "mistral");
  assert.equal(t.provider, "mistral");
  assert.equal(t.planType, "FREE");
  assert.equal(loadAllTokens(d).length, 1);
});

test("assertUnderBase only accepts the expected origin and path", () => {
  const base = "https://console.mistral.ai/api";
  assert.equal(
    assertUnderBase(
      "https://console.mistral.ai/api/vibe/sign-in/p1",
      base,
      "poll_url",
    ),
    "https://console.mistral.ai/api/vibe/sign-in/p1",
  );
  assert.throws(() =>
    assertUnderBase("https://evil.example/api/x", base, "poll_url"),
  );
  assert.throws(() =>
    assertUnderBase("https://console.mistral.ai/other", base, "poll_url"),
  );
  assert.throws(() =>
    assertUnderBase(
      "https://console.mistral.ai/api/%2e%2e/x",
      base,
      "poll_url",
    ),
  );
  assert.throws(() => assertUnderBase(undefined, base, "poll_url"));
});

type Call = { url: string; method: string; body: any };
function fakeFetch(handler: (c: Call) => { status: number; body: any }) {
  const calls: Call[] = [];
  const impl = (async (input: any, init?: any) => {
    const c: Call = {
      url: String(input),
      method: init?.method || "GET",
      body: init?.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(c);
    const r = handler(c);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { impl, calls };
}

const START = {
  process_id: "proc_123",
  sign_in_url:
    "https://console.mistral.ai/codestral/cli/authenticate?process_id=proc_123&complete_token=t",
  poll_url: "https://console.mistral.ai/api/vibe/sign-in/proc_123",
  expires_at: "2099-01-01T00:00:00Z",
};

test("Vibe sign-in: start, poll until completed, exchange with matching PKCE", async () => {
  let polls = 0;
  const { impl, calls } = fakeFetch((c) => {
    if (c.url.endsWith("/vibe/sign-in") && c.method === "POST")
      return { status: 200, body: START };
    if (c.url === START.poll_url) {
      polls++;
      return polls < 3
        ? { status: 200, body: { status: "pending" } }
        : {
            status: 200,
            body: { status: "completed", exchange_token: "ex_tok" },
          };
    }
    if (c.url.endsWith("/vibe/sign-in/proc_123/exchange"))
      return { status: 200, body: { api_key: "sk-vibe" } };
    return { status: 404, body: {} };
  });
  let shown = "";
  const key = await runVibeBrowserLogin({
    fetchImpl: impl,
    sleep: async () => {},
    onLoginUrl: (u) => {
      shown = u;
    },
  });
  assert.equal(key, "sk-vibe");
  assert.equal(shown, START.sign_in_url);
  assert.equal(calls[0].url, "https://console.mistral.ai/api/vibe/sign-in");
  assert.equal(calls[0].body.code_challenge_method, "S256");
  const ex = calls[calls.length - 1];
  const expected = createHash("sha256")
    .update(ex.body.code_verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  assert.equal(calls[0].body.code_challenge, expected);
  assert.equal(ex.body.exchange_token, "ex_tok");
  assert.equal(polls, 3);
});

test("Vibe sign-in: foreign poll_url, 410, denied and ineligible workspace fail", async () => {
  const run = (handler: (c: Call) => { status: number; body: any }) =>
    runVibeBrowserLogin({
      fetchImpl: fakeFetch(handler).impl,
      sleep: async () => {},
    });

  await assert.rejects(
    run(() => ({
      status: 200,
      body: { ...START, poll_url: "https://evil.example/poll" },
    })),
    /unexpected poll_url/,
  );
  await assert.rejects(
    run((c) =>
      c.method === "POST"
        ? { status: 200, body: START }
        : { status: 410, body: {} },
    ),
    /expired/,
  );
  await assert.rejects(
    run((c) =>
      c.method === "POST"
        ? { status: 200, body: START }
        : { status: 200, body: { status: "denied" } },
    ),
    /denied/,
  );
  await assert.rejects(
    run((c) => {
      if (c.url.endsWith("/exchange"))
        return { status: 403, body: { error_code: 9004 } };
      if (c.method === "POST") return { status: 200, body: START };
      return {
        status: 200,
        body: { status: "completed", exchange_token: "x" },
      };
    }),
    /not eligible/,
  );
});

test("account from key: e-mail and plan read, rejected key is an error", async () => {
  const ok = fakeFetch((c) => {
    if (c.url.endsWith("/v1/users/me"))
      return { status: 200, body: { id: "uid", email: "me@x.y" } };
    if (c.url.endsWith("/v1/billing/subscription"))
      return { status: 200, body: { plan_name: "FREE" } };
    return { status: 404, body: {} };
  });
  const t = await mistralTokenFromKey("sk", ok.impl);
  assert.equal(t.email, "me@x.y");
  assert.equal(t.planType, "FREE");
  assert.equal(t.provider, "mistral");
  assert.equal(t.refreshToken, MISTRAL_NO_REFRESH);
  assert.ok(Date.parse(t.expiresAt) > Date.now() + 365 * 86_400_000);

  const bad = fakeFetch(() => ({ status: 401, body: {} }));
  await assert.rejects(mistralTokenFromKey("sk", bad.impl), /rejected/);
});

test("Vibe sign-in: 429 on poll backs off and keeps polling, 429 on start is explicit", async () => {
  const waits: number[] = [];
  let polls = 0;
  const { impl } = fakeFetch((c) => {
    if (c.url.endsWith("/vibe/sign-in") && c.method === "POST")
      return { status: 200, body: START };
    if (c.url === START.poll_url) {
      polls++;
      if (polls <= 5) return { status: 429, body: {} };
      return {
        status: 200,
        body: { status: "completed", exchange_token: "ex" },
      };
    }
    if (c.url.endsWith("/exchange"))
      return { status: 200, body: { api_key: "sk-ok" } };
    return { status: 404, body: {} };
  });
  const key = await runVibeBrowserLogin({
    fetchImpl: impl,
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  assert.equal(key, "sk-ok");
  assert.deepEqual(waits, [6000, 12000, 24000, 30000, 30000]);

  const limited = fakeFetch(() => ({ status: 429, body: {} }));
  await assert.rejects(
    runVibeBrowserLogin({ fetchImpl: limited.impl, sleep: async () => {} }),
    /retry in a few minutes/,
  );
});
