import test from "node:test";
import assert from "node:assert/strict";
import { parseAvailableModels } from "../src/upstream/gemini-models";

test("parseAvailableModels keeps chat models and drops internal/tab/tiered/image ids", () => {
  const out = parseAvailableModels({
    models: {
      "gemini-3.8-flash-medium": { displayName: "Gemini 3.8 Flash (Medium)", apiProvider: "API_PROVIDER_GOOGLE_GEMINI" },
      "claude-sonnet-4-6": { displayName: "Claude Sonnet 4.6", apiProvider: "API_PROVIDER_ANTHROPIC_VERTEX" },
      "gemini-3.8-flash-tiered": { apiProvider: "API_PROVIDER_GOOGLE_GEMINI" },
      "tab_flash_lite_preview": { apiProvider: "API_PROVIDER_GOOGLE_GEMINI" },
      "chat_23310": { displayName: "x", apiProvider: "API_PROVIDER_INTERNAL" },
      "gemini-3.1-flash-image": { displayName: "Image", apiProvider: "API_PROVIDER_GOOGLE_GEMINI" },
    },
  });
  assert.deepEqual(out, [
    { id: "gemini-3.8-flash-medium", owned_by: "google" },
    { id: "claude-sonnet-4-6", owned_by: "antigravity" },
  ]);
  assert.deepEqual(parseAvailableModels(null), []);
});
