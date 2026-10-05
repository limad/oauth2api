import { randomUUID } from "node:crypto";
import { Request } from "express";
import { Config } from "../config";
import { AvailableAccount } from "../accounts/manager";
import { withTimeoutSignal } from "../utils/abort";
import { readSseEvents } from "./streaming";
import {
  anthropicToGeminiContents,
  geminiResponseToAnthropic,
  geminiChunkToAnthropicSSE,
  finishGeminiStream,
  makeGeminiStreamState,
  resolveGeminiModel,
} from "./gemini-translator";

// RPC-style URL shape (`:method`, not `/method`) verified against
// google-gemini/gemini-cli (packages/core/src/code_assist/server.ts).
//
// Base host: three environments exist behind this same v1internal API —
// prod rate-limits aggressively (429) for Code Assist traffic, so
// lbjlaq/Antigravity-Manager (30k+ stars, actively maintained) prioritises
// sandbox/daily over prod and falls back on failure. Mirrored here for the
// same reason (Ref their issue #1176).
export const V1_INTERNAL_BASES = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal",
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal",
  "https://cloudcode-pa.googleapis.com/v1internal",
];

const SESSION_ID = String(-Math.floor(Math.random() * 2 ** 53));

export function methodUrl(base: string, method: string): string {
  return `${base}:${method}`;
}

// Google's Code Assist backend appears to gate free-tier eligibility on more
// than just the OAuth client_id — lbjlaq/Antigravity-Manager sends a
// User-Agent that mimics the real Antigravity Electron app on every
// v1internal call. Value below is the exact string captured from a live
// Antigravity install's own traffic, not the community repo's fallback
// constant. Updated 2026-10-05 from a mitmproxy capture of Antigravity CLI
// 1.2.17 (the real client sends only User-Agent/Authorization/Content-Type).
const ANTIGRAVITY_USER_AGENT =
  "antigravity/cli/1.2.17 (aidev_client; os_type=windows; arch=amd64; cl=993434119; auth_method=consumer)";

export function authHeaders(accessToken: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": ANTIGRAVITY_USER_AGENT,
  };
}

// ideType "ANTIGRAVITY" (rather than gemini-cli's "IDE_UNSPECIFIED") is
// what actually keeps the free "Code Assist for individuals" tier eligible
// under this OAuth client — see docs/gemini-code-assist-notes.md.
// The real Antigravity CLI sends exactly `{"metadata":{"ideType":"ANTIGRAVITY"}}`.
const CLIENT_METADATA = {
  ideType: "ANTIGRAVITY",
};

/**
 * POST `loadCodeAssist`/`onboardUser`/`generateContent` against each
 * v1internal base in turn, falling through on network errors or upstream
 * 429/5xx (which is exactly the failure mode the sandbox/daily fallback
 * exists for). A real 4xx (bad request, auth) is NOT retried against the
 * next base — that's a request problem, not an environment problem — it's
 * returned immediately so the caller sees the real error.
 */
async function postWithFallback<T>(
  method: string,
  accessToken: string,
  body: object,
): Promise<{ base: string; data: T }> {
  let lastErr: unknown;
  for (const base of V1_INTERNAL_BASES) {
    try {
      const resp = await fetch(methodUrl(base, method), {
        method: "POST",
        headers: authHeaders(accessToken),
        body: JSON.stringify(body),
      });
      if (resp.ok) {
        return { base, data: (await resp.json()) as T };
      }
      if (resp.status !== 429 && resp.status < 500) {
        const text = await resp.text();
        throw new Error(`Gemini Code Assist ${method} failed (${resp.status}): ${text}`);
      }
      lastErr = new Error(`Gemini Code Assist ${method} on ${base} failed (${resp.status})`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

interface LoadCodeAssistResponse {
  currentTier?: { id?: string; name?: string };
  cloudaicompanionProject?: string;
  allowedTiers?: Array<{
    id?: string;
    name?: string;
    isDefault?: boolean;
    userDefinedCloudaicompanionProject?: boolean;
  }>;
  ineligibleTiers?: Array<{
    tierId?: string;
    tierName?: string;
    reasonCode?: string;
    reasonMessage?: string;
  }>;
}

interface LongRunningOperationResponse {
  done?: boolean;
  name?: string;
  response?: { cloudaicompanionProject?: { id?: string } };
}

/**
 * Resolves the Gemini Code Assist project + tier for a freshly-authenticated
 * account.
 *
 * Primary path (lbjlaq/Antigravity-Manager's approach — see
 * docs/gemini-code-assist-notes.md): under the Antigravity OAuth client with
 * `ideType: "ANTIGRAVITY"` metadata, `loadCodeAssist` returns
 * `cloudaicompanionProject` directly as a plain string for eligible
 * accounts — no separate onboarding call needed.
 *
 * Fallback path (gemini-cli's documented `setupUser()`,
 * packages/core/src/code_assist/setup.ts): if that field is absent, fall
 * through to the tier/`onboardUser` handshake. This covers accounts that
 * still need it and, for the non-free `standard-tier`
 * (`userDefinedCloudaicompanionProject: true`), reads
 * `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_PROJECT_ID` from the environment
 * exactly like gemini-cli itself. Without one, onboarding fails with
 * Google's own ineligibility reason surfaced verbatim.
 */
export async function resolveGeminiProject(
  accessToken: string,
): Promise<{ projectId: string; userTier: string; apiBase: string }> {
  const envProjectId =
    process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID || undefined;

  const { base, data: loadRes } = await postWithFallback<LoadCodeAssistResponse>(
    "loadCodeAssist",
    accessToken,
    {
      cloudaicompanionProject: envProjectId,
      metadata: envProjectId
        ? { ...CLIENT_METADATA, duetProject: envProjectId }
        : CLIENT_METADATA,
    },
  );

  // Antigravity flow: project id handed back directly, no onboarding needed.
  if (loadRes.cloudaicompanionProject) {
    return {
      projectId: loadRes.cloudaicompanionProject,
      userTier: loadRes.currentTier?.id || "antigravity",
      apiBase: base,
    };
  }
  if (loadRes.currentTier) {
    if (!envProjectId) throw new Error(ineligibilityMessage(loadRes));
    return { projectId: envProjectId, userTier: loadRes.currentTier.id || "unknown", apiBase: base };
  }

  // gemini-cli fallback: tier/onboardUser handshake.
  const tier =
    loadRes.allowedTiers?.find((t) => t.isDefault) ||
    ({
      id: "free-tier",
      name: "Free",
      userDefinedCloudaicompanionProject: false,
    } as const);

  if (tier.userDefinedCloudaicompanionProject && !envProjectId) {
    throw new Error(ineligibilityMessage(loadRes));
  }

  // The free tier uses a Google-managed project; sending one triggers a
  // "Precondition Failed" upstream (verified in gemini-cli's setup.ts).
  const onboardReq =
    tier.id === "free-tier"
      ? { tierId: tier.id, metadata: CLIENT_METADATA }
      : {
          tierId: tier.id,
          cloudaicompanionProject: envProjectId,
          metadata: { ...CLIENT_METADATA, duetProject: envProjectId },
        };

  let lro = (await postWithFallback<LongRunningOperationResponse>(
    "onboardUser",
    accessToken,
    onboardReq,
  )).data;

  let attempts = 0;
  while (!lro.done && lro.name && attempts < 12) {
    attempts++;
    await new Promise((r) => setTimeout(r, 5000));
    const resp = await fetch(`${base}/${lro.name}`, {
      method: "GET",
      headers: authHeaders(accessToken),
    });
    if (!resp.ok) {
      throw new Error(`Gemini Code Assist getOperation failed (${resp.status}): ${await resp.text()}`);
    }
    lro = (await resp.json()) as LongRunningOperationResponse;
  }

  const projectId = lro.response?.cloudaicompanionProject?.id || envProjectId;
  if (!projectId) {
    throw new Error(ineligibilityMessage(loadRes));
  }
  return { projectId, userTier: tier.id || "free-tier", apiBase: base };
}

function ineligibilityMessage(loadRes: LoadCodeAssistResponse): string {
  const reasons = (loadRes.ineligibleTiers || [])
    .map((t) => t.reasonMessage)
    .filter(Boolean);
  if (reasons.length) {
    return `Gemini Code Assist onboarding failed: ${reasons.join(" / ")}`;
  }
  return "Gemini Code Assist onboarding did not return a project id — this account likely needs a billing-enabled Google Cloud project (set GOOGLE_CLOUD_PROJECT before logging in).";
}

export interface CallGeminiMessagesOptions {
  body?: any;
  request: Request;
  account: AvailableAccount;
  config: Config;
  signal?: AbortSignal;
}

/**
 * Anthropic Messages request → Gemini Code Assist call → Anthropic Messages
 * response. Fully self-contained: callers never see the Gemini wire format.
 * On a non-2xx upstream the raw upstream Response is returned as-is so
 * `proxyWithRetry` (utils/http.ts) can classify/retry/cool down exactly like
 * every other provider.
 */
export async function callGeminiMessages(
  options: CallGeminiMessagesOptions,
): Promise<Response> {
  const { request, account, config } = options;
  const body = options.body ?? request.body;
  // `model` is echoed back to the client as-is (whatever they requested);
  // `resolvedModel` is the real Code Assist backend id sent upstream — see
  // resolveGeminiModel's doc comment for why these can differ.
  const model = body.model || "gemini-3.1-pro";
  const resolvedModel = resolveGeminiModel(model);
  const stream = !!body.stream;
  const projectId = account.token.geminiProjectId;
  if (!projectId) {
    return new Response(
      JSON.stringify({
        error: {
          message:
            "Gemini account is missing its Code Assist project id — re-run login (auth2api --login --provider=gemini).",
          type: "account_not_onboarded",
        },
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  const { contents, systemInstruction, tools, toolConfig, generationConfig } =
    anthropicToGeminiContents(body);

  // Envelope as sent by the real Antigravity CLI 1.2.17 (mitmproxy capture,
  // requestType "agent"): requestId is "agent/<uuid>", userAgent is the fixed
  // string "antigravity", sessionId is a stable per-process negative integer.
  const envelope = {
    project: projectId,
    requestId: `agent/${randomUUID()}`,
    model: resolvedModel,
    userAgent: "antigravity",
    requestType: "agent",
    request: {
      contents,
      systemInstruction,
      tools,
      toolConfig,
      generationConfig,
      sessionId: SESSION_ID,
    },
  };

  const timeoutMs = stream
    ? config.timeouts["stream-messages-ms"]
    : config.timeouts["messages-ms"];
  const method = stream ? "streamGenerateContent" : "generateContent";
  // Reuse whichever base worked at onboarding time (persisted on the token)
  // so every request for this account hits the same environment — falls
  // back to the first candidate for accounts onboarded before this field
  // existed.
  const base = account.token.geminiApiBase || V1_INTERNAL_BASES[0];
  const url = stream ? `${methodUrl(base, method)}?alt=sse` : methodUrl(base, method);

  console.log(
    `[gemini-call] url=${url} requestedModel=${model} resolvedModel=${resolvedModel} project=${projectId}`,
  );

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: authHeaders(account.token.accessToken),
      body: JSON.stringify(envelope),
      signal: withTimeoutSignal(timeoutMs, options.signal),
    });
    if (!upstream.ok) {
      console.log(
        `[gemini-call] upstream ${upstream.status} for url=${url}: ${await upstream.clone().text()}`,
      );
    }
  } catch (err: any) {
    const cause = err?.cause;
    const detail = cause
      ? `${cause.code || cause.name || "error"}: ${cause.message || String(cause)}`
      : err?.message || String(err);
    throw new Error(`gemini upstream fetch failed: ${detail}`);
  }

  if (!upstream.ok) {
    return upstream;
  }

  if (!stream) {
    const data = await upstream.json();
    const anthropicJson = geminiResponseToAnthropic(data, model);
    return new Response(JSON.stringify(anthropicJson), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  const encoder = new TextEncoder();
  const state = makeGeminiStreamState(model);
  const sseStream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const { data } of readSseEvents(upstream)) {
          if (!data) continue;
          for (const line of geminiChunkToAnthropicSSE(data, state)) {
            controller.enqueue(encoder.encode(line));
          }
        }
        for (const line of finishGeminiStream(state)) {
          controller.enqueue(encoder.encode(line));
        }
      } catch (err) {
        controller.error(err);
        return;
      }
      controller.close();
    },
  });

  return new Response(sseStream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}
