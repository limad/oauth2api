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
  assert.deepEqual(out.map((m) => [m.id, m.owned_by]), [
    ["gemini-3.8-flash-medium", "google"],
    ["claude-sonnet-4-6", "antigravity"],
  ]);
  assert.deepEqual(parseAvailableModels(null), []);
});

test("parseAvailableModels maps limits, capabilities and quota", () => {
  const [m] = parseAvailableModels({
    models: {
      "gemini-3.8-flash-medium": {
        displayName: "G",
        apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
        supportsImages: true,
        supportsThinking: true,
        supportsVideo: true,
        maxTokens: 1048576,
        maxOutputTokens: 65536,
        supportedMimeTypes: { "application/pdf": true, "audio/wav": true },
        quotaInfo: { remainingFraction: 0.5, resetTime: "2026-10-11T00:00:00Z" },
      },
    },
  });
  assert.equal(m.context_length, 1048576);
  assert.equal(m.max_completion_tokens, 65536);
  assert.deepEqual(m.quota, { remaining_fraction: 0.5, reset_time: "2026-10-11T00:00:00Z" });
  assert.equal((m.capabilities as any).pdf, true);
  assert.equal((m.capabilities as any).audioInput, true);
  assert.equal((m.capabilities as any).videoInput, true);
  assert.equal((m.capabilities as any).reasoning, true);
});
