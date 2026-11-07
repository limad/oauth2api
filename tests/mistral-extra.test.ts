import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRegistry } from "../src/providers/registry";
import { createServer } from "../src/server";
import { saveToken } from "../src/auth/token-storage";
import { StatsRecorder } from "../src/stats/recorder";
import {
  clientAffinity,
  multipartField,
  replaceMultipartField,
} from "../src/upstream/mistral-api";
import { MISTRAL_NO_REFRESH } from "../src/auth/mistral/vibe-login";

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

/** Local server + fake api.mistral.ai (only that origin is stubbed). */
async function withServer(
  answer: (seen: Seen) => Response,
  fn: (base: string, seen: Seen[]) => Promise<void>,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mistral-extra-"));
  saveToken(dir, {
    accessToken: "vibe-test-key",
    refreshToken: MISTRAL_NO_REFRESH,
    email: "a@b.c",
    expiresAt: "2036-01-01T00:00:00.000Z",
    accountUuid: "u",
    provider: "mistral",
  });
  const registry = buildRegistry(dir);
  registry.get("mistral").manager.load();
  const recorder = new StatsRecorder();
  recorder.start(dir);
  const app = createServer(
    {
      host: "",
      port: 0,
      "auth-dir": dir,
      "api-keys": new Set(["sk-test"]),
      "body-limit": "1mb",
      cloaking: {},
      timeouts: { "messages-ms": 5000, "stream-messages-ms": 5000, "count-tokens-ms": 1000 },
      stats: { enabled: true },
      debug: "off",
    } as any,
    registry,
    recorder,
  );
  const seen: Seen[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    if (!url.startsWith("https://api.mistral.ai/")) return orig(input, init);
    const s: Seen = {
      url,
      headers: Object.fromEntries(
        Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]),
      ),
      body: Buffer.from(init?.body ?? ""),
    };
    seen.push(s);
    return answer(s);
  }) as typeof fetch;
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", () => r()));
  try {
    await fn(`http://127.0.0.1:${(server.address() as any).port}`, seen);
  } finally {
    globalThis.fetch = orig;
    await new Promise<void>((r) => server.close(() => r()));
    await recorder.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const AUTH = { Authorization: "Bearer sk-test", "Content-Type": "application/json" };
const json = (o: any, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

test("x-affinity: forwarded only when it is a plain token", () => {
  const req = (v?: string) => ({ header: (n: string) => (n === "x-affinity" ? v : undefined) }) as any;
  assert.equal(clientAffinity(req("sess_01H-abc:2")), "sess_01H-abc:2");
  assert.equal(clientAffinity(req(" abc ")), "abc");
  assert.equal(clientAffinity(req(undefined)), undefined);
  assert.equal(clientAffinity(req("a b")), undefined);
  assert.equal(clientAffinity(req("x".repeat(129))), undefined);
  assert.equal(clientAffinity(req("a\r\nX-Evil: 1")), undefined);
});

test("multipart: read and replace one text field, file bytes untouched", () => {
  const file = Buffer.from([0, 1, 2, 13, 10, 45, 45, 255]);
  const body = Buffer.concat([
    Buffer.from('--B\r\nContent-Disposition: form-data; name="model"\r\n\r\nmistral/voxtral-mini-latest\r\n'),
    Buffer.from('--B\r\nContent-Disposition: form-data; name="file"; filename="a.wav"\r\n\r\n'),
    file,
    Buffer.from("\r\n--B--\r\n"),
  ]);
  assert.equal(multipartField(body, "model"), "mistral/voxtral-mini-latest");
  assert.equal(multipartField(body, "stream"), null);
  const out = replaceMultipartField(body, "model", "voxtral-mini-latest");
  assert.equal(multipartField(out, "model"), "voxtral-mini-latest");
  assert.ok(out.includes(file));
  assert.equal(out.length, body.length - "mistral/".length);
  assert.equal(replaceMultipartField(body, "absent", "x"), body);
});

test("embeddings: prefix removed, body otherwise untouched, answer relayed, affinity forwarded", async () => {
  const upstream = { object: "list", data: [{ embedding: [0.1, 0.2], index: 0 }], usage: { prompt_tokens: 4, total_tokens: 4 } };
  await withServer(() => json(upstream), async (base, seen) => {
    const r = await fetch(`${base}/v1/embeddings`, {
      method: "POST",
      headers: { ...AUTH, "x-affinity": "s1" },
      body: JSON.stringify({ model: "mistral/mistral-embed", input: ["a"], encoding_format: "float" }),
    });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), upstream);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://api.mistral.ai/v1/embeddings");
    assert.equal(seen[0].headers.authorization, "Bearer vibe-test-key");
    assert.equal(seen[0].headers["x-affinity"], "s1");
    assert.deepEqual(JSON.parse(seen[0].body.toString()), { model: "mistral-embed", input: ["a"], encoding_format: "float" });
  });
});

test("non-Mistral model or missing model: 400 without any upstream call", async () => {
  await withServer(() => json({}), async (base, seen) => {
    for (const [p, body] of [
      ["/v1/embeddings", { model: "text-embedding-3-small", input: "a" }],
      ["/v1/fim/completions", { prompt: "x" }],
      ["/v1/ocr", []],
    ] as const) {
      const r = await fetch(`${base}${p}`, { method: "POST", headers: AUTH, body: JSON.stringify(body) });
      assert.equal(r.status, 400, p);
      assert.match((await r.json()).error.message, /Mistral|model|JSON/);
    }
    const r = await fetch(`${base}/v1/audio/transcriptions`, { method: "POST", headers: AUTH, body: "{}" });
    assert.equal(r.status, 400);
    assert.equal(seen.length, 0);
  });
});

test("audio: multipart relayed byte for byte (model prefix removed), boundary kept", async () => {
  const file = Buffer.from("RIFF\0\0\0\0WAVEdata\r\n--x", "latin1");
  const mk = (model: string) =>
    Buffer.concat([
      Buffer.from(`--BND\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`),
      Buffer.from('--BND\r\nContent-Disposition: form-data; name="file"; filename="s.wav"\r\nContent-Type: audio/wav\r\n\r\n'),
      file,
      Buffer.from("\r\n--BND--\r\n"),
    ]);
  await withServer(() => json({ text: "bonjour", usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 382, prompt_tokens_details: { audio_tokens: 374 } } }), async (base, seen) => {
    const r = await fetch(`${base}/v1/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: "Bearer sk-test", "Content-Type": "multipart/form-data; boundary=BND" },
      body: mk("mistral/voxtral-mini-latest"),
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).text, "bonjour");
    const st = await (await fetch(`${base}/admin/stats`, { headers: { Authorization: "Bearer sk-test" } })).json();
    const row: any = Object.values(st.byApi).find((v: any) => v.endpoint === "POST /v1/audio/transcriptions");
    assert.equal(row.totalInputTokens, 379); // 382 total - 3 completion: audio tokens counted
    assert.equal(row.totalOutputTokens, 3);
    assert.equal(seen[0].url, "https://api.mistral.ai/v1/audio/transcriptions");
    assert.equal(seen[0].headers["content-type"], "multipart/form-data; boundary=BND");
    assert.ok(seen[0].body.equals(mk("voxtral-mini-latest")));
  });
});

test("FIM stream: SSE bytes relayed unchanged", async () => {
  const sse =
    'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"return"}}]}\n\n' +
    'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":" a + b"},"finish_reason":"stop"}],"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}}\n\n' +
    "data: [DONE]\n\n";
  await withServer(
    () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
    async (base, seen) => {
      const r = await fetch(`${base}/v1/fim/completions`, {
        method: "POST",
        headers: AUTH,
        body: JSON.stringify({ model: "codestral-latest", prompt: "def add(a, b):", suffix: "", stream: true, max_tokens: 8 }),
      });
      assert.equal(r.status, 200);
      assert.equal(await r.text(), sse);
      assert.equal(seen[0].headers.accept, "text/event-stream");
    },
  );
});

test("OCR 403 is relayed with Mistral's message and does not pause the account", async () => {
  let n = 0;
  await withServer(
    () =>
      n++ === 0
        ? json({ object: "error", message: "Feature not enabled for this organization", type: "forbidden" }, 403)
        : json({ pages: [{ index: 0, markdown: "OK" }], usage_info: { pages_processed: 1 } }),
    async (base) => {
      const body = JSON.stringify({ model: "mistral-ocr-latest", document: { type: "image_url", image_url: "data:image/png;base64,AA==" } });
      const a = await fetch(`${base}/v1/ocr`, { method: "POST", headers: AUTH, body });
      assert.equal(a.status, 403);
      assert.equal((await a.json()).error.message, "Feature not enabled for this organization");
      const b = await fetch(`${base}/v1/ocr`, { method: "POST", headers: AUTH, body });
      assert.equal(b.status, 200);
      assert.equal((await b.json()).pages[0].markdown, "OK");
    },
  );
});

test("chat: x-affinity forwarded, invalid value dropped", async () => {
  const ok = { id: "1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
  await withServer(() => json(ok), async (base, seen) => {
    const body = JSON.stringify({ model: "mistral-small-latest", messages: [{ role: "user", content: "hi" }] });
    await (await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { ...AUTH, "x-affinity": "conv-42" }, body })).json();
    await (await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: { ...AUTH, "x-affinity": "bad value" }, body })).json();
    await (await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: AUTH, body })).json();
    assert.equal(seen[0].headers["x-affinity"], "conv-42");
    assert.equal(seen[1].headers["x-affinity"], undefined);
    assert.equal(seen[2].headers["x-affinity"], undefined);
  });
});
