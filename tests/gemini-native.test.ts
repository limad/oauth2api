import test from "node:test";
import assert from "node:assert/strict";
import {
  geminiToAnthropicRequest,
  anthropicToGeminiResponse,
  makeGeminiStreamConverter,
  googleError,
} from "../src/upstream/gemini-native";

const request = () => ({
  systemInstruction: { parts: [{ text: "You audit code." }] },
  contents: [
    { role: "user", parts: [{ text: "Audit." }, { inlineData: { mimeType: "image/png", data: "AAA" } }] },
    {
      role: "model",
      parts: [
        { text: "plan", thought: true },
        { functionCall: { name: "read", args: { path: "a.php" } } },
        { functionCall: { name: "read", args: { path: "b.php" } } },
      ],
    },
    {
      role: "user",
      parts: [
        { functionResponse: { name: "read", response: { output: "<?php" } } },
        { functionResponse: { name: "read", response: { error: "not found" } } },
      ],
    },
  ],
  tools: [
    { functionDeclarations: [{ name: "read", description: "Read", parameters: { type: "OBJECT", properties: { path: { type: "STRING" } }, required: ["path"] } }] },
    { googleSearch: {} },
  ],
  toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["read"] } },
  generationConfig: { maxOutputTokens: 300, temperature: 0.2, stopSequences: ["END"] },
});

test("gemini-native: generateContent request -> Anthropic body", () => {
  const out = geminiToAnthropicRequest("mistral-large-4", request(), true);
  assert.equal(out.model, "mistral-large-4");
  assert.equal(out.stream, true);
  assert.equal(out.max_tokens, 300);
  assert.equal(out.temperature, 0.2);
  assert.deepEqual(out.stop_sequences, ["END"]);
  assert.equal(out.system, "You audit code.");
  assert.deepEqual(out.tool_choice, { type: "tool", name: "read" });
  assert.deepEqual(out.tools, [
    { name: "read", description: "Read", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  ]);
  assert.deepEqual(out.messages[0], {
    role: "user",
    content: [
      { type: "text", text: "Audit." },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
    ],
  });
  // thought part dropped, calls get ids, responses matched to them in order
  const [c1, c2] = out.messages[1].content;
  assert.equal(out.messages[1].role, "assistant");
  assert.equal(out.messages[1].content.length, 2);
  assert.deepEqual([c1.name, c1.input], ["read", { path: "a.php" }]);
  const [r1, r2] = out.messages[2].content;
  assert.deepEqual([r1.tool_use_id, r1.content, r1.is_error], [c1.id, "<?php", undefined]);
  assert.deepEqual([r2.tool_use_id, r2.content, r2.is_error], [c2.id, '{"error":"not found"}', true]);
  assert.equal(geminiToAnthropicRequest("m", { contents: [{ parts: [{ text: "x" }] }] }, false).max_tokens, 8192);
});

test("gemini-native: explicit ids are kept, audio is refused", () => {
  const out = geminiToAnthropicRequest("m", {
    contents: [
      { role: "model", parts: [{ functionCall: { id: "fc_9", name: "t", args: {} } }] },
      { role: "user", parts: [{ text: "after" }, { functionResponse: { id: "fc_9", name: "t", response: { ok: 1 } } }] },
    ],
  }, false);
  assert.equal(out.messages[0].content[0].id, "fc_9");
  // tool result moved before the user's text
  assert.deepEqual(out.messages[1].content.map((b: any) => b.type), ["tool_result", "text"]);
  assert.throws(() =>
    geminiToAnthropicRequest("m", { contents: [{ role: "user", parts: [{ inlineData: { mimeType: "audio/wav", data: "x" } }] }] }, false),
  );
});

test("gemini-native: Anthropic message -> generateContent response", () => {
  const out = anthropicToGeminiResponse(
    {
      id: "msg_1",
      content: [
        { type: "thinking", thinking: "hm" },
        { type: "text", text: "Reading." },
        { type: "tool_use", id: "t1", name: "read", input: { path: "x" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 },
    },
    "claude-opus-5-5",
  );
  assert.deepEqual(out.candidates[0].content.parts, [
    { text: "hm", thought: true },
    { text: "Reading." },
    { functionCall: { id: "t1", name: "read", args: { path: "x" } } },
  ]);
  assert.equal(out.candidates[0].finishReason, "STOP");
  assert.deepEqual(out.usageMetadata, { promptTokenCount: 100, candidatesTokenCount: 5, totalTokenCount: 105, cachedContentTokenCount: 90 });
  assert.equal(anthropicToGeminiResponse({ content: [], stop_reason: "max_tokens" }, "m").candidates[0].finishReason, "MAX_TOKENS");
  assert.deepEqual(googleError(429, "slow"), { error: { code: 429, message: "slow", status: "RESOURCE_EXHAUSTED" } });
});

test("gemini-native: Anthropic SSE -> Gemini stream chunks", () => {
  const conv = makeGeminiStreamConverter("m");
  const events: [string, any][] = [
    ["message_start", { type: "message_start", message: { id: "msg_1", usage: { input_tokens: 7 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "read" } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"path":' } }],
    ["content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"x"}' } }],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { input_tokens: 7, output_tokens: 4 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  const chunks = events.flatMap(([e, d]) => conv.push(e, d));
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[0].candidates[0].content.parts, [{ text: "Hi" }]);
  assert.deepEqual(chunks[1].candidates[0].content.parts, [{ functionCall: { id: "t1", name: "read", args: { path: "x" } } }]);
  assert.equal(chunks[2].candidates[0].finishReason, "STOP");
  assert.deepEqual(chunks[2].usageMetadata, { promptTokenCount: 7, candidatesTokenCount: 4, totalTokenCount: 11 });
  assert.deepEqual(conv.end(), []);
  // stream cut before message_stop: end() still closes it
  const cut = makeGeminiStreamConverter("m");
  cut.push("message_start", { type: "message_start", message: { usage: { input_tokens: 1 } } });
  assert.equal(cut.end()[0].candidates[0].finishReason, "STOP");
});
