/**
 * Cursor client version reported in `x-cursor-client-version`.
 *
 * Cursor refuses clients it no longer supports ("Your version of Cursor is no
 * longer supported"), so a pinned version goes stale within weeks. We follow
 * the public desktop update feed instead (no auth needed) and only fall back
 * to the constants below when the feed is unreachable.
 */

export const CURSOR_UPDATE_FEED_URL =
  "https://api2.cursor.sh/updates/api/update/linux-x64/cursor/0.0.0/stable";

/** Last known desktop release (checked 2026-11-08). Used only when the feed fails. */
export const FALLBACK_CURSOR_CLIENT_VERSION = "3.29.9";
export const FALLBACK_CURSOR_CLIENT_COMMIT =
  "306d153d51d714882ab7b1bc49649cab624e8a31";

const REFRESH_MS = 6 * 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 3_000;

export interface CursorClientVersion {
  version: string;
  /** Build commit sent as `x-cursor-client-commit`; empty when unknown. */
  commit: string;
  source: "feed" | "fallback";
}

let current: CursorClientVersion = {
  version: FALLBACK_CURSOR_CLIENT_VERSION,
  commit: FALLBACK_CURSOR_CLIENT_COMMIT,
  source: "fallback",
};
let nextCheckAt = 0;
let inflight: Promise<CursorClientVersion> | null = null;

/** Parse the update feed answer: `{version, url: ".../production/<commit>/..."}`. */
export function parseCursorUpdateFeed(
  payload: unknown,
): CursorClientVersion | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const version = String(p.productVersion || p.version || "").trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  const url = typeof p.url === "string" ? p.url : "";
  const commit =
    url.match(/\/production\/([0-9a-f]{40})\//i)?.[1]?.toLowerCase() || "";
  return { version, commit, source: "feed" };
}

/** Latest known version, without waiting on the network. */
export function getCursorClientVersion(): CursorClientVersion {
  return current;
}

/**
 * Refresh the cached version from the update feed when it is stale. Never
 * throws: on failure the previous value stays and a retry is scheduled.
 */
export async function ensureCursorClientVersion(
  fetchImpl: typeof fetch = fetch,
): Promise<CursorClientVersion> {
  if (Date.now() < nextCheckAt) return current;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const resp = await fetchImpl(CURSOR_UPDATE_FEED_URL, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`status ${resp.status}`);
      const parsed = parseCursorUpdateFeed(await resp.json());
      if (!parsed) throw new Error("unexpected payload");
      current = parsed;
      nextCheckAt = Date.now() + REFRESH_MS;
    } catch (err: any) {
      nextCheckAt = Date.now() + RETRY_MS;
      console.error(
        `[cursor] client version feed failed (${err?.message || String(err)}); using ${current.version}`,
      );
    } finally {
      inflight = null;
    }
    return current;
  })();
  return inflight;
}

/** Test-only: reset the cache, optionally forcing a value. */
export function __resetCursorClientVersion(value?: CursorClientVersion): void {
  current = value || {
    version: FALLBACK_CURSOR_CLIENT_VERSION,
    commit: FALLBACK_CURSOR_CLIENT_COMMIT,
    source: "fallback",
  };
  nextCheckAt = value ? Date.now() + REFRESH_MS : 0;
  inflight = null;
}
