import test from "node:test";
import assert from "node:assert/strict";

import {
  anthropicToGeminiContents,
  geminiResponseToAnthropic,
  geminiChunkToAnthropicSSE,
  finishGeminiStream,
  makeGeminiStreamState,
  resolveGeminiModel,
} from "../src/upstream/gemini-translator";

// ───────────────── resolveGeminiModel ─────────────────

test("resolveGeminiModel: maps friendly names to real Code Assist backend ids", () => {
  assert.equal(resolveGeminiModel("gemini-3.1-pro"), "gemini-pro-agent");
  assert.equal(resolveGeminiModel("gemini-2.5-pro"), "gemini-pro-agent");
  assert.equal(resolveGeminiModel("gemini-2.5-flash"), "gemini-3-flash");
});

test("resolveGeminiModel: real backend ids pass through unchanged", () => {
  assert.equal(resolveGeminiModel("gemini-3.1-pro-low"), "gemini-3.1-pro-low");
  assert.equal(resolveGeminiModel("gemini-3.5-flash-high"), "gemini-3.5-flash-high");
  assert.equal(resolveGeminiModel("gemini-3-flash"), "gemini-3-flash");
});

test("resolveGeminiModel: unknown model passes through unchanged (forward-compat)", () => {
  assert.equal(resolveGeminiModel("gemini-9-nonexistent"), "gemini-9-nonexistent");
});

// ───────────────── anthropicToGeminiContents (request) ─────────────────

test("anthropicToGeminiContents: maps roles and text content", () => {
  const out = anthropicToGeminiContents({
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ],
  });
  assert.deepEqual(out.contents, [
    { role: "user", parts: [{ text: "hi" }] },
    { role: "model", parts: [{ text: "hello" }] },
  ]);
});

test("anthropicToGeminiContents: system string becomes systemInstruction", () => {
  const out = anthropicToGeminiContents({
    system: "Be terse.",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(out.systemInstruction, {
    role: "user",
    parts: [{ text: "Be terse." }],
  });
});

test("anthropicToGeminiContents: system array of text blocks is joined", () => {
  const out = anthropicToGeminiContents({
    system: [{ type: "text", text: "A" }, { type: "text", text: "B" }],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(out.systemInstruction.parts[0].text, "A\n\nB");
});

test("anthropicToGeminiContents: tool_use → functionCall, tool_result → functionResponse", () => {
  const out = anthropicToGeminiContents({
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling tool" },
          { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.txt" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "file contents" },
        ],
      },
    ],
  });
  assert.deepEqual(out.contents[0].parts[0], { text: "calling tool" });
  assert.deepEqual(out.contents[0].parts[1], {
    functionCall: { name: "read_file", args: { path: "a.txt" } },
    thoughtSignature: "skip_thought_signature_validator",
    thought_signature: "skip_thought_signature_validator",
  });
  // functionResponse.name must be the function NAME ("read_file"), not the
  // tool_use call id ("call_1") — Gemini correlates responses by name.
  assert.deepEqual(out.contents[1].parts[0], {
    functionResponse: { name: "read_file", response: { output: "file contents" } },
  });
});

test("anthropicToGeminiContents: tool_use with a captured signature reuses it instead of the placeholder", () => {
  const out = anthropicToGeminiContents({
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "read_file",
            input: {},
            signature: "real-signature-abc",
          },
        ],
      },
    ],
  });
  assert.equal(out.contents[0].parts[0].thoughtSignature, "real-signature-abc");
  assert.equal(out.contents[0].parts[0].thought_signature, "real-signature-abc");
});

test("anthropicToGeminiContents: tools[] converts to Gemini functionDeclarations and drops unsupported schema keys", () => {
  const out = anthropicToGeminiContents({
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        name: "read_file",
        description: "Reads a file",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          additionalProperties: false,
        },
      },
    ],
  });
  assert.deepEqual(out.tools, [
    {
      functionDeclarations: [
        {
          name: "read_file",
          description: "Reads a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      ],
    },
  ]);
});

test("anthropicToGeminiContents: tool_choice maps to functionCallingConfig", () => {
  assert.deepEqual(
    anthropicToGeminiContents({
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "tool", name: "read_file" },
    }).toolConfig,
    { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["read_file"] } },
  );
  assert.deepEqual(
    anthropicToGeminiContents({
      messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "auto" },
    }).toolConfig,
    { functionCallingConfig: { mode: "AUTO" } },
  );
});

test("anthropicToGeminiContents: generationConfig maps sampling + thinking", () => {
  const out = anthropicToGeminiContents({
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 1024,
    temperature: 0.7,
    top_p: 0.9,
    stop_sequences: ["END"],
    thinking: { type: "enabled", budget_tokens: 4096 },
  });
  assert.deepEqual(out.generationConfig, {
    maxOutputTokens: 1024,
    temperature: 0.7,
    topP: 0.9,
    stopSequences: ["END"],
    thinkingConfig: { thinkingBudget: 4096, includeThoughts: true },
  });
});

// ───────────────── geminiResponseToAnthropic (non-streaming) ─────────────────

test("geminiResponseToAnthropic: translates text response with usage", () => {
  const out = geminiResponseToAnthropic(
    {
      response: {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "hello there" }] },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      },
    },
    "gemini-2.5-pro",
  );
  assert.equal(out.role, "assistant");
  assert.deepEqual(out.content, [{ type: "text", text: "hello there" }]);
  assert.equal(out.stop_reason, "end_turn");
  assert.deepEqual(out.usage, {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 0,
  });
});

test("geminiResponseToAnthropic: functionCall part → tool_use, stop_reason tool_use", () => {
  const out = geminiResponseToAnthropic(
    {
      response: {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ functionCall: { name: "read_file", args: { path: "a.txt" } } }],
            },
            finishReason: "STOP",
          },
        ],
      },
    },
    "gemini-2.5-pro",
  );
  assert.equal(out.content[0].type, "tool_use");
  assert.equal(out.content[0].name, "read_file");
  assert.deepEqual(out.content[0].input, { path: "a.txt" });
  assert.equal(out.stop_reason, "tool_use");
});

test("geminiResponseToAnthropic: captures thoughtSignature onto the tool_use block", () => {
  const out = geminiResponseToAnthropic(
    {
      response: {
        candidates: [
          {
            content: {
              parts: [
                {
                  functionCall: { name: "read_file", args: {} },
                  thoughtSignature: "sig-xyz",
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
    },
    "gemini-2.5-pro",
  );
  assert.equal(out.content[0].signature, "sig-xyz");
});

test("geminiResponseToAnthropic: MAX_TOKENS finishReason maps to max_tokens", () => {
  const out = geminiResponseToAnthropic(
    {
      response: {
        candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: "MAX_TOKENS" }],
      },
    },
    "gemini-2.5-pro",
  );
  assert.equal(out.stop_reason, "max_tokens");
});

test("geminiResponseToAnthropic: thought part → thinking block", () => {
  const out = geminiResponseToAnthropic(
    {
      response: {
        candidates: [
          {
            content: {
              parts: [
                { thought: true, text: "reasoning..." },
                { text: "answer" },
              ],
            },
            finishReason: "STOP",
          },
        ],
      },
    },
    "gemini-2.5-pro",
  );
  assert.deepEqual(out.content, [
    { type: "thinking", thinking: "reasoning..." },
    { type: "text", text: "answer" },
  ]);
});

// ───────────────── streaming ─────────────────

function collectEvents(lines: string[]): Array<{ event: string; data: any }> {
  const out: Array<{ event: string; data: any }> = [];
  for (const line of lines) {
    const [eventPart, dataPart] = line.split("\n");
    out.push({
      event: eventPart.replace("event: ", ""),
      data: JSON.parse(dataPart.replace("data: ", "")),
    });
  }
  return out;
}

test("gemini streaming: text deltas open/close a single text block", () => {
  const state = makeGeminiStreamState("gemini-2.5-pro");
  const chunk1 = geminiChunkToAnthropicSSE(
    { response: { candidates: [{ content: { parts: [{ text: "Hel" }] } }] } },
    state,
  );
  const chunk2 = geminiChunkToAnthropicSSE(
    { response: { candidates: [{ content: { parts: [{ text: "lo" }] } }] } },
    state,
  );
  const final = finishGeminiStream(state);

  const events = collectEvents([...chunk1, ...chunk2, ...final]);
  const types = events.map((e) => e.event);
  assert.deepEqual(types, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.equal(events[2].data.delta.text, "Hel");
  assert.equal(events[3].data.delta.text, "lo");
  assert.equal(events[5].data.delta.stop_reason, "end_turn");
});

test("gemini streaming: functionCall part emits a full tool_use block in one chunk", () => {
  const state = makeGeminiStreamState("gemini-2.5-pro");
  const chunk = geminiChunkToAnthropicSSE(
    {
      response: {
        candidates: [
          {
            content: {
              parts: [{ functionCall: { name: "read_file", args: { path: "a.txt" } } }],
            },
          },
        ],
      },
    },
    state,
  );
  const final = finishGeminiStream(state);
  const events = collectEvents([...chunk, ...final]);
  const types = events.map((e) => e.event);
  assert.deepEqual(types, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.equal(events[1].data.content_block.type, "tool_use");
  assert.equal(events[1].data.content_block.name, "read_file");
  assert.deepEqual(JSON.parse(events[2].data.delta.partial_json), { path: "a.txt" });
  assert.equal(events[4].data.delta.stop_reason, "tool_use");
});

test("gemini streaming: usage from the final chunk lands on message_delta", () => {
  const state = makeGeminiStreamState("gemini-2.5-pro");
  geminiChunkToAnthropicSSE(
    {
      response: {
        candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
      },
    },
    state,
  );
  const final = finishGeminiStream(state);
  const events = collectEvents(final);
  const messageDelta = events.find((e) => e.event === "message_delta")!;
  assert.deepEqual(messageDelta.data.usage, {
    input_tokens: 7,
    output_tokens: 3,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  });
});
