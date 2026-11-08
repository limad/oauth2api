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
 * Writing a cache entry costs 1.25x the input price (5 min lifetime) or 2x
 * (1 h) and only pays back when a later request repeats the prefix.
 * Breakpoints are therefore only added once the same tools + system prompt
 * (for the same client key and model) were already seen within the cache
 * lifetime: a prompt that is never repeated, or that changes every time (a
 * timestamp in the system prompt), is never billed for a write.
 *
 * Lifetime (`prompt-cache.ttl`):
 *   - "auto" (default): 1 h for the stable part (injected prefix, client
 *     system prompt), shared by every conversation of the client; for the
 *     conversation, 5 min while turns come quickly (agent loop: each read
 *     renews the 5 min, and a 1 h write would cost 2x instead of 1.25x on
 *     every new turn), 1 h once the previous turn came more than 2 min
 *     earlier (a person answering: a pause longer than 5 min would otherwise
 *     re-bill the whole history);
 *   - "5m" / "1h": that lifetime everywhere.
 * Anthropic refuses a 1 h breakpoint after a 5 min one; the order used here
 * (prefix, system, then messages) always respects it.
 */

export type CacheTtl = "auto" | "5m" | "1h";

const SHORT_MS = 5 * 60 * 1000;
const LONG_MS = 60 * 60 * 1000;
/** Gap between two turns above which the conversation is treated as paced by a person. */
const HUMAN_GAP_MS = 2 * 60 * 1000;
const SEEN_MAX = 2000;
const seen = new Map<string, number>();

/** @internal — tests only. */
export function __resetAutoCache(): void {
  seen.clear();
}

/** Time since this prefix was last sent (null if never or longer ago than `windowMs`); records it either way. */
function sinceLastSeen(key: string, now: number, windowMs: number): number | null {
  const last = seen.get(key);
  seen.delete(key);
  seen.set(key, now);
  if (seen.size > SEEN_MAX) {
    for (const k of seen.keys()) {
      seen.delete(k);
      if (seen.size <= SEEN_MAX) break;
    }
  }
  return last !== undefined && now - last < windowMs ? now - last : null;
}

function control(ttl: "5m" | "1h"): { type: "ephemeral"; ttl?: "1h" } {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/** Blocks that may carry cache_control (thinking blocks may not, empty text may not). */
function cacheable(block: any): boolean {
  if (!block || typeof block !== "object") return false;
  if (block.type === "text") return typeof block.text === "string" && block.text.length > 0;
  return ["image", "document", "tool_use", "tool_result", "search_result"].includes(block.type);
}

/** Puts a breakpoint on the last cacheable block of a message. Returns false if none. */
function markMessage(msg: any, ttl: "5m" | "1h"): boolean {
  if (!msg) return false;
  if (typeof msg.content === "string") {
    if (!msg.content) return false;
    msg.content = [{ type: "text", text: msg.content, cache_control: control(ttl) }];
    return true;
  }
  if (!Array.isArray(msg.content)) return false;
  for (let i = msg.content.length - 1; i >= 0; i--) {
    if (cacheable(msg.content[i])) {
      msg.content[i] = { ...msg.content[i], cache_control: control(ttl) };
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
  /** Injected CLI prefix block, when the proxy added it (its breakpoint follows the stable-part lifetime). */
  prefixBlock?: any;
  /** Breakpoints already in the body (injected prefix included). */
  used: number;
  ttl?: CacheTtl;
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
  const mode: CacheTtl = opts.ttl === "5m" || opts.ttl === "1h" ? opts.ttl : "auto";
  const stableTtl: "5m" | "1h" = mode === "5m" ? "5m" : "1h";
  // The injected prefix is the same for every conversation of the client: 1 h
  // from the first request, before any "seen" check (a few hundred tokens).
  if (opts.prefixBlock?.cache_control && stableTtl === "1h") {
    opts.prefixBlock.cache_control = control("1h");
  }
  const gap = sinceLastSeen(key, opts.now ?? Date.now(), mode === "5m" ? SHORT_MS : LONG_MS);
  if (gap === null) return 0;
  const historyTtl: "5m" | "1h" =
    mode === "auto" ? (gap > HUMAN_GAP_MS ? "1h" : "5m") : mode;

  let free = Math.max(0, 4 - opts.used);
  let added = 0;
  const last = messages.length - 1;
  if (free > 0 && markMessage(messages[last], historyTtl)) {
    free--;
    added++;
  }
  // Previous user message: where the previous turn's breakpoint 1 was.
  if (free > 0) {
    for (let i = last - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") {
        if (markMessage(messages[i], historyTtl)) {
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
        b.cache_control = control(stableTtl);
        added++;
        break;
      }
    }
  }
  return added;
}
