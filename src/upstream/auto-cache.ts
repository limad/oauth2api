import crypto from "crypto";

/**
 * Automatic prompt-cache breakpoints for Claude requests whose client sets none.
 *
 * Clients reaching Claude through the OpenAI formats (chat/completions,
 * responses) cannot express `cache_control`, and many Anthropic clients never
 * set it. Without breakpoints, only the injected CLI prefix is cached (tools +
 * prefix); the client's system prompt and the conversation are re-billed in
 * full on every turn of an agent loop.
 *
 * Breakpoints added (Anthropic allows 4 per request, the injected prefix may
 * already use one):
 *   1. last block of the last message: caches the whole request for the next turn;
 *   2. last block of the previous user message: the exact place where the
 *      previous turn wrote its cache, so it is read even when that turn added
 *      more than the ~20 blocks Anthropic looks back from a breakpoint;
 *   3. last block of the client system prompt: shared by one-shot requests that
 *      reuse the same instructions.
 *
 * Writing a cache entry costs 1.25x the input price and only pays back when a
 * later request repeats the prefix. Breakpoints are therefore only added once
 * the same tools + system prompt (for the same client key and model) have
 * already been seen less than 5 minutes ago (the cache lifetime): a prompt
 * that is never repeated, or that changes every time (a timestamp in the
 * system prompt), is never billed for a write.
 */

const SEEN_TTL_MS = 5 * 60 * 1000;
const SEEN_MAX = 2000;
const seen = new Map<string, number>();

/** @internal — tests only. */
export function __resetAutoCache(): void {
  seen.clear();
}

/** True when this prefix was already sent less than 5 min ago; records it either way. */
function prefixSeenRecently(key: string, now: number): boolean {
  const last = seen.get(key);
  seen.delete(key);
  seen.set(key, now);
  if (seen.size > SEEN_MAX) {
    for (const k of seen.keys()) {
      seen.delete(k);
      if (seen.size <= SEEN_MAX) break;
    }
  }
  return last !== undefined && now - last < SEEN_TTL_MS;
}

/** Blocks that may carry cache_control (thinking blocks may not, empty text may not). */
function cacheable(block: any): boolean {
  if (!block || typeof block !== "object") return false;
  if (block.type === "text") return typeof block.text === "string" && block.text.length > 0;
  return ["image", "document", "tool_use", "tool_result", "search_result"].includes(block.type);
}

/** Puts a 5 min breakpoint on the last cacheable block of a message. Returns false if none. */
function markMessage(msg: any): boolean {
  if (!msg) return false;
  if (typeof msg.content === "string") {
    if (!msg.content) return false;
    msg.content = [{ type: "text", text: msg.content, cache_control: { type: "ephemeral" } }];
    return true;
  }
  if (!Array.isArray(msg.content)) return false;
  for (let i = msg.content.length - 1; i >= 0; i--) {
    if (cacheable(msg.content[i])) {
      msg.content[i] = { ...msg.content[i], cache_control: { type: "ephemeral" } };
      return true;
    }
  }
  return false;
}

export interface AutoCacheOptions {
  /** Client system blocks (after the billing header and CLI prefix were taken out). */
  clientSystem: any[];
  /** Hash of the downstream API key: one client's prompts never mark another's. */
  apiKeyHash: string;
  /** Breakpoints already in the body (injected prefix included). */
  used: number;
  now?: number;
}

/**
 * Adds breakpoints in place on `body` (already cloned by the caller). Only call
 * it when the client itself set no cache_control at all.
 * Returns the number of breakpoints added.
 */
export function applyAutoCache(body: any, opts: AutoCacheOptions): number {
  const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) return 0;
  const key = crypto
    .createHash("sha256")
    .update(opts.apiKeyHash)
    .update("\0" + String(body.model ?? ""))
    .update("\0" + JSON.stringify(body.tools ?? null))
    .update("\0" + JSON.stringify(opts.clientSystem))
    .digest("hex");
  if (!prefixSeenRecently(key, opts.now ?? Date.now())) return 0;

  let free = Math.max(0, 4 - opts.used);
  let added = 0;
  const last = messages.length - 1;
  if (free > 0 && markMessage(messages[last])) {
    free--;
    added++;
  }
  // Previous user message: where the previous turn's breakpoint 1 was.
  if (free > 0) {
    for (let i = last - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        if (markMessage(messages[i])) {
          free--;
          added++;
        }
        break;
      }
    }
  }
  if (free > 0) {
    for (let i = opts.clientSystem.length - 1; i >= 0; i--) {
      const b = opts.clientSystem[i];
      if (cacheable(b)) {
        b.cache_control = { type: "ephemeral" };
        added++;
        break;
      }
    }
  }
  return added;
}
