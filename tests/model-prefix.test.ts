import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRegistry } from "../src/providers/registry";
import { resolveModel } from "../src/upstream/translator";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prefix-"));
const reg = buildRegistry(dir);

test("ag/ routes to Antigravity (gemini provider), any underlying id", () => {
  assert.equal(reg.forModel("ag/claude-sonnet-4-6").id, "gemini");
  assert.equal(reg.forModel("ag/gpt-oss-120b-medium").id, "gemini");
  assert.equal(reg.forModel("ag/gemini-3.8-flash-medium").id, "gemini");
  assert.equal(reg.forModel("gemini-3.8-flash-medium").id, "gemini");
});

test("at/ forces Anthropic and bare claude-* stays Anthropic", () => {
  assert.equal(reg.forModel("at/claude-sonnet-4-6").id, "anthropic");
  assert.equal(reg.forModel("claude-sonnet-4-6").id, "anthropic");
  assert.equal(resolveModel("at/claude-sonnet-4-6"), "claude-sonnet-4-6");
  assert.equal(resolveModel("ag/claude-sonnet-4-6"), "ag/claude-sonnet-4-6");
});
