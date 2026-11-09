import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountManager, MAX_RESET_HINT_MS } from "../src/accounts/manager";
import { TokenData, ProviderId } from "../src/auth/types";
import { accountResetAt, proxyWithRetry, upstreamResetAt } from "../src/utils/http";
import { loadConfig } from "../src/config";

const H = (h: Record<string, string>) => new Headers(h);
const NOW = Date.parse("2026-11-09T12:00:00Z");

function withManager(
  provider: ProviderId,
  emails: string[],
  fn: (m: AccountManager) => Promise<void> | void,
): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-strategy-"));
  const m = new AccountManager(dir, {
    provider,
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
      provider,
    });
  }
  return Promise.resolve(fn(m)).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

const pick = (m: AccountManager, accept?: (e: string) => boolean) =>
  m.getNextAccount(accept).account?.token.email;

function cooldownLeft(m: AccountManager, email: string): number {
  const s = m.getSnapshots().find((x: any) => x.email === email) as any;
  return s.cooldownUntil - Date.now();
}

// ── reset hints ──────────────────────────────────────────

test("upstreamResetAt: Retry-After in seconds and as an HTTP date", () => {
  assert.equal(upstreamResetAt(H({ "retry-after": "120" }), "", NOW), NOW + 120_000);
  const date = "Mon, 09 Nov 2026 15:00:00 GMT";
  assert.equal(upstreamResetAt(H({ "retry-after": date }), "", NOW), Date.parse(date));
});

test("upstreamResetAt: Codex usage_limit_reached body, latest hint wins", () => {
  const body = JSON.stringify({
    error: { type: "usage_limit_reached", resets_in_seconds: 86400, resets_at: NOW / 1000 + 3600 },
  });
  assert.equal(upstreamResetAt(H({ "retry-after": "30" }), body, NOW), NOW + 86_400_000);
});

test("upstreamResetAt: nothing usable gives null", () => {
  assert.equal(upstreamResetAt(H({}), "", NOW), null);
  assert.equal(upstreamResetAt(H({ "retry-after": "garbage" }), "not json", NOW), null);
  assert.equal(upstreamResetAt(H({ "retry-after": "0" }), "", NOW), null);
  assert.equal(
    upstreamResetAt(H({}), JSON.stringify({ error: { resets_at: NOW / 1000 - 10 } }), NOW),
    null,
  );
});

test("accountResetAt: only 429 on providers with account-wide limits", () => {
  const h = H({ "retry-after": "600" });
  for (const p of ["codex", "copilot", "cursor", "mistral"] as ProviderId[]) {
    assert.equal(accountResetAt(p, 429, h, "", NOW), NOW + 600_000, p);
  }
  // Claude and Gemini/Antigravity also limit per model: no long account pause.
  assert.equal(accountResetAt("anthropic", 429, h, "", NOW), null);
  assert.equal(accountResetAt("gemini", 429, h, "", NOW), null);
  assert.equal(accountResetAt("codex", 503, h, "", NOW), null);
});

// ── pauses ───────────────────────────────────────────────

test("recordFailure: pause lasts until the announced reset, capped", () =>
  withManager("codex", ["a@x", "b@x", "c@x"], (m) => {
    m.recordFailure("a@x", "rate_limit", "quota", Date.now() + 3 * 86_400_000);
    assert.ok(Math.abs(cooldownLeft(m, "a@x") - 3 * 86_400_000) < 5_000);

    m.recordFailure("b@x", "rate_limit", "quota", Date.now() + 40 * 86_400_000);
    assert.ok(Math.abs(cooldownLeft(m, "b@x") - MAX_RESET_HINT_MS) < 5_000);

    // A hint shorter than the backoff (60 s for a first 429) keeps the backoff.
    m.recordFailure("c@x", "rate_limit", "quota", Date.now() + 5_000);
    assert.ok(Math.abs(cooldownLeft(m, "c@x") - 60_000) < 5_000);
  }));

test("recordFailure without hint: unchanged backoff", () =>
  withManager("codex", ["a@x"], (m) => {
    m.recordFailure("a@x", "rate_limit");
    assert.ok(Math.abs(cooldownLeft(m, "a@x") - 60_000) < 5_000);
  }));

// ── strategies ───────────────────────────────────────────

test("default strategy is sticky: the same account is kept", () =>
  withManager("codex", ["b@x", "a@x", "c@x"], (m) => {
    assert.equal(m.getStrategy(), "sticky");
    const first = pick(m);
    for (let i = 0; i < 5; i++) assert.equal(pick(m), first);
  }));

test("fill-first: first available account by email, skips paused ones, comes back after", () =>
  withManager("codex", ["c@x", "a@x", "b@x"], (m) => {
    m.setStrategy("fill-first");
    for (let i = 0; i < 3; i++) assert.equal(pick(m), "a@x");
    m.recordFailure("a@x", "rate_limit", "quota", Date.now() + 86_400_000);
    for (let i = 0; i < 3; i++) assert.equal(pick(m), "b@x");
    m.recordSuccess("a@x"); // pause over (success clears it)
    assert.equal(pick(m), "a@x");
  }));

test("fill-first: honours the model filter, ignores a filter that matches nobody", () =>
  withManager("gemini", ["a@x", "b@x"], (m) => {
    m.setStrategy("fill-first");
    assert.equal(pick(m, (e) => e === "b@x"), "b@x");
    assert.equal(pick(m, () => false), "a@x");
  }));

test("fill-first: all paused reports the most recoverable failure", () =>
  withManager("codex", ["a@x", "b@x"], (m) => {
    m.setStrategy("fill-first");
    m.recordFailure("a@x", "rate_limit", "quota", Date.now() + 3600_000);
    m.recordFailure("b@x", "rate_limit", "quota", Date.now() + 7200_000);
    const r = m.getNextAccount();
    assert.equal(r.account, null);
    if (!r.account) {
      assert.equal(r.failureKind, "rate_limit");
      assert.ok(Math.abs((r.retryAfterMs ?? 0) - 3600_000) < 5_000);
    }
  }));

// ── proxyWithRetry: exhausted accounts are not called again ──

function mockResponse(): any {
  const r = new EventEmitter() as any;
  Object.assign(r, { headers: {}, locals: {}, headersSent: false, destroyed: false, writableEnded: false });
  r.setHeader = (k: string, v: string) => ((r.headers[k.toLowerCase()] = v), r);
  r.status = (c: number) => ((r.statusCode = c), r);
  r.json = (b: any) => ((r.body = b), (r.headersSent = true), r);
  return r;
}

test("proxyWithRetry: Codex accounts paused until reset, next request goes straight to a healthy one", () =>
  withManager("codex", ["a@x", "b@x", "c@x", "d@x"], async (m) => {
    m.setStrategy("fill-first");
    const calls: string[] = [];
    const exhausted = new Set(["a@x", "b@x", "c@x"]);
    const run = async () => {
      const resp = mockResponse();
      await proxyWithRetry("T", resp, { debug: "off" } as any, {
        manager: m,
        upstream: async (account) => {
          calls.push(account.token.email);
          return exhausted.has(account.token.email)
            ? new Response(
                JSON.stringify({ error: { type: "usage_limit_reached", resets_in_seconds: 86400 } }),
                { status: 429 },
              )
            : new Response("{}", { status: 200 });
        },
        success: async (_u, account) => {
          resp.status(200).json({ ok: account.token.email });
        },
      });
      return resp;
    };

    const r1 = await run(); // 3 attempts, 3 exhausted accounts
    assert.equal(r1.statusCode, 429);
    assert.deepEqual(calls, ["a@x", "b@x", "c@x"]);

    // 20 min later: past the longest backoff (15 min), still before the announced reset.
    calls.length = 0;
    const realNow = Date.now;
    const shifted = realNow() + 20 * 60_000;
    Date.now = () => shifted;
    try {
      const r2 = await run();
      assert.equal(r2.statusCode, 200);
      assert.deepEqual(calls, ["d@x"], "no call to the paused accounts");
    } finally {
      Date.now = realNow;
    }
  }));

// ── config ───────────────────────────────────────────────

test("loadConfig: account-strategy and per-provider overrides, invalid entries dropped", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-cfg-"));
  try {
    const f = path.join(dir, "c.yaml");
    fs.writeFileSync(
      f,
      "api-keys: [k]\naccount-strategy: fill-first\naccount-strategy-by-provider:\n  codex: sticky\n  gemini: round-robin\n  nope: fill-first\n",
    );
    const c = loadConfig(f);
    assert.equal(c["account-strategy"], "fill-first");
    assert.deepEqual(c["account-strategy-by-provider"], { codex: "sticky" });

    fs.writeFileSync(f, "api-keys: [k]\naccount-strategy: weird\n");
    assert.equal(loadConfig(f)["account-strategy"], "sticky");

    fs.writeFileSync(f, "api-keys: [k]\n");
    const d = loadConfig(f);
    assert.equal(d["account-strategy"], "sticky");
    assert.deepEqual(d["account-strategy-by-provider"], {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
