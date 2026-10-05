import test from "node:test";
import assert from "node:assert/strict";
import { compileModelFilter } from "../src/models-filter";

test("empty or missing patterns expose everything", () => {
  assert.equal(compileModelFilter([])("anything"), true);
  assert.equal(compileModelFilter(undefined)("anything"), true);
});

test("include patterns use * wildcards, case-insensitive", () => {
  const f = compileModelFilter(["gemini-3.8-*", "ag/claude-*", "gpt-5"]);
  assert.equal(f("gemini-3.8-flash-medium"), true);
  assert.equal(f("ag/claude-sonnet-4-6"), true);
  assert.equal(f("GPT-5"), true);
  assert.equal(f("gemini-3.7-flash-medium"), false);
  assert.equal(f("gpt-5.1"), false);
  assert.equal(f("claude-sonnet-4-6"), false);
});

test("exclusions apply with or without includes; regex chars are literal", () => {
  const onlyExclude = compileModelFilter(["!*-low"]);
  assert.equal(onlyExclude("gemini-3.8-flash-low"), false);
  assert.equal(onlyExclude("gemini-3.8-flash-high"), true);
  const mixed = compileModelFilter(["gemini-*", "!gemini-3.1-pro-high"]);
  assert.equal(mixed("gemini-3.1-pro-high"), false);
  assert.equal(mixed("gemini-pro-agent"), true);
  assert.equal(compileModelFilter(["gemini-3.8.x"])("gemini-3a8bx"), false);
});
