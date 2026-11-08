import { test } from "node:test";
import assert from "node:assert/strict";
import { generateAuthURL, generateClaudeState } from "../src/auth/oauth";

test("claude oauth: state is base64url of 32 bytes (43 chars, like Claude Code)", () => {
  const state = generateClaudeState();
  assert.equal(state.length, 43);
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(state, "base64url").length, 32);
});

test("claude oauth: authorize URL carries the state and the native Claude Code scopes", () => {
  const state = generateClaudeState();
  const url = new URL(
    generateAuthURL(state, { codeVerifier: "v", codeChallenge: "c" } as any),
  );
  assert.equal(url.searchParams.get("state"), state);
  assert.equal(
    url.searchParams.get("scope"),
    "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
  );
});
