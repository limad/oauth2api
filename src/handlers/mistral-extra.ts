import { Request, Response as ExpressResponse } from "express";
import { Config } from "../config";
import { ProviderRegistry } from "../providers/registry";
import { proxyWithRetry } from "../utils/http";
import { tagStatsModel, tagStatsUsage } from "../stats/recorder";
import { extractUsage, UsageData } from "../accounts/manager";
import { handleStreamingResponse } from "../upstream/streaming";
import {
  callMistralExtra,
  clientAffinity,
  MistralExtraKind,
  MISTRAL_EXTRA_PATHS,
  multipartField,
  replaceMultipartField,
  stripMistralPrefix,
} from "../upstream/mistral-api";
import { openaiErrorBody } from "./openai";

const EXAMPLE_MODEL: Record<MistralExtraKind, string> = {
  fim: "codestral-latest",
  embeddings: "mistral-embed",
  ocr: "mistral-ocr-latest",
  transcriptions: "voxtral-mini-latest",
};

const ZERO_USAGE: UsageData = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  reasoningOutputTokens: 0,
};

function badRequest(resp: ExpressResponse, message: string): void {
  resp
    .status(400)
    .json({ error: { message, type: "invalid_request_error" } });
}

/**
 * Mistral-only routes (FIM, embeddings, OCR, audio transcription), relayed as
 * is with the Vibe key: the body goes upstream untouched (only a `mistral/`
 * model prefix is removed), the answer comes back untouched. No other provider
 * serves them, so a non-Mistral model is refused here without any upstream call.
 */
export function createMistralExtraHandler(
  kind: MistralExtraKind,
  config: Config,
  registry: ProviderRegistry,
) {
  const path = MISTRAL_EXTRA_PATHS[kind];
  return async (req: Request, resp: ExpressResponse): Promise<void> => {
    try {
      const provider = registry.get("mistral");
      let body: any;
      let model: string;
      let stream = false;
      let contentType: string | undefined;

      if (kind === "transcriptions") {
        contentType = req.header("content-type") || "";
        if (!Buffer.isBuffer(req.body) || !req.body.length || !/^multipart\/form-data/i.test(contentType)) {
          badRequest(resp, `${path} expects a multipart/form-data body (file, model)`);
          return;
        }
        model = (multipartField(req.body, "model") || "").trim();
        stream = (multipartField(req.body, "stream") || "").trim() === "true";
        const bare = stripMistralPrefix(model);
        body = bare !== model ? replaceMultipartField(req.body, "model", bare) : req.body;
      } else {
        if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
          badRequest(resp, `${path} expects a JSON object body`);
          return;
        }
        model = typeof req.body.model === "string" ? req.body.model.trim() : "";
        stream = kind === "fim" && !!req.body.stream;
        const bare = stripMistralPrefix(model);
        body = bare !== model ? { ...req.body, model: bare } : req.body;
      }

      if (!model) {
        badRequest(resp, `model is required (e.g. ${EXAMPLE_MODEL[kind]})`);
        return;
      }
      if (!provider.matchesModel(model)) {
        badRequest(
          resp,
          `${path} is only served by Mistral: use a Mistral model (e.g. ${EXAMPLE_MODEL[kind]}) or prefix it with mistral/`,
        );
        return;
      }
      tagStatsModel(resp, model, provider.id);
      const affinity = clientAffinity(req);

      await proxyWithRetry(`${kind}(mistral)`, resp, config, {
        manager: provider.manager,
        requestErrorStatuses: provider.requestErrorStatuses,
        profile: req.header("x-auth2api-profile") || undefined,
        upstream: (account, signal) =>
          callMistralExtra({
            kind,
            body,
            contentType,
            stream,
            account,
            config,
            affinity,
            signal,
          }),
        success: async (upstream, account) => {
          if (stream) {
            const result = await handleStreamingResponse(upstream, resp);
            if (result.completed) {
              provider.manager.recordSuccess(account.token.email, result.usage);
            } else if (!result.clientDisconnected) {
              provider.manager.recordFailure(
                account.token.email,
                "network",
                "stream terminated before completion",
              );
            }
            return;
          }
          const text = await upstream.text();
          let usage = ZERO_USAGE;
          try {
            const json = JSON.parse(text);
            usage = extractUsage(json);
            // Transcription: audio tokens are in total_tokens only
            // (prompt_tokens counts the text prompt), seen live on 2026-11-07.
            const u = json?.usage;
            if (kind === "transcriptions" && typeof u?.total_tokens === "number") {
              usage = {
                ...usage,
                inputTokens: Math.max(usage.inputTokens, u.total_tokens - (u.completion_tokens || 0)),
              };
            }
          } catch {
            /* not JSON: relayed as is, no usage */
          }
          provider.manager.recordSuccess(account.token.email, usage);
          tagStatsUsage(resp, usage);
          resp
            .status(upstream.status)
            .type(upstream.headers.get("content-type") || "application/json")
            .send(text);
        },
        errorAdapter: openaiErrorBody,
      });
    } catch (err: any) {
      console.error(`${kind}(mistral) handler error:`, err?.message || err);
      if (!resp.headersSent) {
        resp.status(500).json({ error: { message: "Internal server error" } });
      } else if (!resp.writableEnded) {
        resp.end();
      }
    }
  };
}
