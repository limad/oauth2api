import test from "node:test";
import assert from "node:assert/strict";
import { openaiToAnthropic } from "../src/upstream/translator";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

function toolResult(content: any) {
  const out = openaiToAnthropic({
    model: "claude-haiku-4-5",
    messages: [
      { role: "user", content: "look" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "t1", type: "function", function: { name: "v", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "t1", content },
    ],
  });
  const msg = out.messages.find((m: any) =>
    Array.isArray(m.content) && m.content.some((b: any) => b.type === "tool_result"),
  );
  return msg.content.find((b: any) => b.type === "tool_result").content;
}

test("tool message image_url becomes an Anthropic image block", () => {
  const c = toolResult([
    { type: "text", text: "shot" },
    { type: "image_url", image_url: { url: PNG } },
  ]);
  assert.deepEqual(c, [
    { type: "text", text: "shot" },
    {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
    },
  ]);
});

test("string tool result is unchanged", () => {
  assert.equal(toolResult("ok"), "ok");
});

test("unconvertible array falls back to JSON string", () => {
  assert.equal(toolResult([{ type: "weird" }]), JSON.stringify([{ type: "weird" }]));
});
