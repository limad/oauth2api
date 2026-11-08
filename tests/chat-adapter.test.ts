import test from "node:test";
import assert from "node:assert/strict";
import {
  anthropicToChatRequest,
  chatToAnthropicMessage,
  chatSseToAnthropicSse,
  callChatAsAnthropic,
} from "../src/upstream/chat-adapter";
import { anthropicView } from "../src/providers/registry";

const agentBody = () => ({
  model: "mistral-large-4",
  max_tokens: 512,
  system: [{ type: "text", text: "You audit code." }, { type: "text", text: " Be brief." }],
  tools: [
    { name: "read", description: "Read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
    { type: "web_search_20250305", name: "web_search" },
  ],
  tool_choice: { type: "any", disable_parallel_tool_use: true },
  stop_sequences: ["END"],
  messages: [
    { role: "user", content: "Audit." },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan", signature: "s" },
        { type: "text", text: "Reading." },
        { type: "tool_use", id: "t1", name: "read", input: { path: "a.php" } },
        { type: "tool_use", id: "t2", name: "read", input: { path: "b.php" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "<?php echo 1;" },
        {
          type: "tool_result",
          tool_use_id: "t2",
          is_error: true,
          content: [{ type: "text", text: "not found" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } }],
        },
        { type: "text", text: "Go on." },
      ],
    },
  ],
});

test("chat-adapter: Anthropic request -> Chat request, nothing added", () => {
  const out = anthropicToChatRequest(agentBody());
  assert.equal(out.model, "mistral-large-4");
  assert.equal(out.max_tokens, 512);
  assert.deepEqual(out.stop, ["END"]);
  assert.equal(out.tool_choice, "required");
  assert.equal(out.parallel_tool_calls, false);
  // server tool dropped, custom tool kept
  assert.deepEqual(out.tools.map((t: any) => t.function.name), ["read"]);
  assert.deepEqual(out.messages, [
    { role: "system", content: "You audit code. Be brief." },
    { role: "user", content: "Audit." },
    {
      role: "assistant",
      content: "Reading.",
      tool_calls: [
        { id: "t1", type: "function", function: { name: "read", arguments: '{"path":"a.php"}' } },
        { id: "t2", type: "function", function: { name: "read", arguments: '{"path":"b.php"}' } },
      ],
    },
    { role: "tool", tool_call_id: "t1", content: "<?php echo 1;" },
    { role: "tool", tool_call_id: "t2", content: "Error: not found" },
    {
      role: "user",
      // the tool's image keeps its place, before the user's own text
      content: [
        { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
        { type: "text", text: "Go on." },
      ],
    },
  ]);
  assert.equal(out.stream, undefined);
  assert.deepEqual(anthropicToChatRequest({ ...agentBody(), stream: true }).stream_options, { include_usage: true });
});

test("chat-adapter: Chat response -> Anthropic message (reasoning, text, tool calls, usage)", () => {
  const msg = chatToAnthropicMessage(
    {
      id: "c1",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            reasoning_content: "think",
            content: "Let me read.",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"x"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } },
    },
    "mistral-large-4",
  );
  assert.deepEqual(msg.content, [
    { type: "thinking", thinking: "think", signature: "" },
    { type: "text", text: "Let me read." },
    { type: "tool_use", id: "call_1", name: "read", input: { path: "x" } },
  ]);
  assert.equal(msg.stop_reason, "tool_use");
  assert.deepEqual(msg.usage, { input_tokens: 70, cache_creation_input_tokens: 0, cache_read_input_tokens: 30, output_tokens: 20 });
  assert.equal(chatToAnthropicMessage({ choices: [{ finish_reason: "length", message: { content: "x" } }] }, "m").stop_reason, "max_tokens");
});

async function runSse(chunks: any[]): Promise<any[]> {
  const raw = chunks.map((c) => `data: ${typeof c === "string" ? c : JSON.stringify(c)}\n\n`).join("");
  const stream = new Response(raw).body!.pipeThrough(chatSseToAnthropicSse("m"));
  const text = await new Response(stream).text();
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((ev) => JSON.parse(ev.split("\n").find((l) => l.startsWith("data: "))!.slice(6)));
}

test("chat-adapter: Chat SSE -> Anthropic SSE with text then a tool call and full usage", async () => {
  const ev = await runSse([
    { id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] },
    { id: "c1", choices: [{ index: 0, delta: { content: "Hi" } }] },
    { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read", arguments: "" } }] } }] },
    { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
    { id: "c1", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] },
    { id: "c1", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    { id: "c1", choices: [], usage: { prompt_tokens: 50, completion_tokens: 9 } },
    "[DONE]",
  ]);
  assert.deepEqual(ev.map((e) => e.type), [
    "message_start",
    "content_block_start", "content_block_delta", "content_block_stop",
    "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
    "message_delta", "message_stop",
  ]);
  assert.deepEqual(ev[4].content_block, { type: "tool_use", id: "call_1", name: "read", input: {} });
  assert.equal(ev[5].delta.partial_json + ev[6].delta.partial_json, '{"path":"x"}');
  assert.equal(ev[8].delta.stop_reason, "tool_use");
  assert.deepEqual(ev[8].usage, { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 9 });
});

test("chat-adapter: a stream cut without [DONE] still ends the message", async () => {
  const ev = await runSse([{ id: "c", choices: [{ index: 0, delta: { content: "x" } }] }]);
  assert.deepEqual(ev.slice(-2).map((e) => e.type), ["message_delta", "message_stop"]);
});

test("chat-adapter: errors pass through, document blocks are refused with 400", async () => {
  const err = await callChatAsAnthropic({ model: "m", messages: [{ role: "user", content: "x" }] }, async () =>
    new Response('{"message":"rate"}', { status: 429 }),
  );
  assert.equal(err.status, 429);
  assert.equal(await err.text(), '{"message":"rate"}');
  let called = false;
  const refused = await callChatAsAnthropic(
    { model: "m", messages: [{ role: "user", content: [{ type: "document", source: { type: "base64", data: "x" } }] }] },
    async () => {
      called = true;
      return new Response("{}");
    },
  );
  assert.equal(refused.status, 400);
  assert.equal(called, false);
});

test("chat-adapter: anthropicView makes a Chat provider Anthropic-native for the Anthropic handlers", () => {
  const chat: any = {
    id: "mistral",
    nativeFormat: "openai-chat",
    callMessages: () => "chat",
    callAnthropicMessages: () => "anthropic",
    requestErrorStatuses: [403],
  };
  const view = anthropicView(chat);
  assert.equal(view.nativeFormat, "anthropic-messages");
  assert.equal((view.callMessages as any)(), "anthropic");
  assert.equal(view.callCountTokens, undefined);
  assert.deepEqual(view.requestErrorStatuses, [403]);
  const native: any = { id: "anthropic", nativeFormat: "anthropic-messages" };
  assert.equal(anthropicView(native), native);
  const chatOnly: any = { id: "x", nativeFormat: "openai-chat" };
  assert.equal(anthropicView(chatOnly), chatOnly);
});
