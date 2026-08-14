import type { AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai";

export type ProviderFailureKind = "aborted" | "auth" | "invalid_request" | "context_overflow" | "model_cooldown" | "rate_limit" | "timeout" | "network" | "server" | "empty_response" | "unknown";

export interface ProviderFailure {
  kind: ProviderFailureKind;
  retryAfterMs?: number;
}

const DEFAULT_MODEL_COOLDOWN_MS = 60_000;
const MAX_PROVIDER_RETRY_AFTER_MS = 3_600_000;

function boundedRetryAfterMs(milliseconds: number) {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined;
  return Math.min(MAX_PROVIDER_RETRY_AFTER_MS, Math.max(1_000, Math.ceil(milliseconds)));
}

/** Parse common provider cooldown shapes after SDKs have flattened responses into error text. */
export function providerRetryAfterMs(errorMessage: string, timestamp = Date.now()) {
  const jsonSeconds = /["']?(?:reset_seconds|retry_after_seconds)["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/i.exec(errorMessage)?.[1];
  if (jsonSeconds) return boundedRetryAfterMs(Number(jsonSeconds) * 1_000);
  const retryAfterSeconds = /retry[-_ ]?after\s*(?::|=|is)?\s*["']?(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/i.exec(errorMessage)?.[1];
  if (retryAfterSeconds) return boundedRetryAfterMs(Number(retryAfterSeconds) * 1_000);
  const headerSeconds = /retry-after\s*:\s*(\d+(?:\.\d+)?)\b/i.exec(errorMessage)?.[1];
  if (headerSeconds) return boundedRetryAfterMs(Number(headerSeconds) * 1_000);
  const headerDate = /retry-after\s*:\s*([^\r\n,]+,\s*[^\r\n]+)/i.exec(errorMessage)?.[1];
  if (headerDate) {
    const retryAt = Date.parse(headerDate.trim());
    if (Number.isFinite(retryAt)) return boundedRetryAfterMs(retryAt - timestamp);
  }
  return undefined;
}

export function providerRetryAfterHeaderMs(headers: Headers, timestamp = Date.now()) {
  const milliseconds = headers.get("retry-after-ms");
  if (milliseconds) {
    const value = Number.parseFloat(milliseconds);
    if (!Number.isNaN(value)) return boundedRetryAfterMs(value);
  }
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number.parseFloat(retryAfter);
  return boundedRetryAfterMs(Number.isNaN(seconds) ? Date.parse(retryAfter) - timestamp : seconds * 1_000);
}

export function describeProviderFailure(message: AssistantMessage, contextWindow?: number): ProviderFailure | undefined {
  if (message.stopReason === "aborted") return { kind: "aborted" };
  if (isContextOverflow(message, contextWindow)) return { kind: "context_overflow" };
  const meaningfulCompletion = message.content.some((part) => part.type === "toolCall"
    || part.type === "text" && Boolean(part.text.trim()));
  if (message.stopReason === "stop" && !meaningfulCompletion) return { kind: "empty_response" };
  if (message.stopReason !== "error") return undefined;
  const raw = message.errorMessage ?? "";
  const text = raw.toLowerCase();
  const retryAfterMs = providerRetryAfterMs(raw);
  if (/model[_ -]?cooldown|model is (?:currently )?(?:in|on) cooldown/.test(text)) {
    return { kind: "model_cooldown", retryAfterMs: retryAfterMs ?? DEFAULT_MODEL_COOLDOWN_MS };
  }
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid api key|authentication/.test(text)) return { kind: "auth" };
  if (/\b429\b|rate.?limit|too many requests|throttl/.test(text)) return { kind: "rate_limit", ...(retryAfterMs ? { retryAfterMs } : {}) };
  if (/\b5\d\d\b|internal server|bad gateway|service unavailable|gateway timeout/.test(text)) return { kind: "server", ...(retryAfterMs ? { retryAfterMs } : {}) };
  if (/timeout|timed out|deadline exceeded/.test(text)) return { kind: "timeout" };
  if (/econnreset|econnrefused|enotfound|network|socket|fetch failed|connection/.test(text)) return { kind: "network" };
  if (/\b400\b|bad request|invalid request|invalid parameter|validation/.test(text)) return { kind: "invalid_request" };
  return { kind: "unknown", ...(retryAfterMs ? { retryAfterMs } : {}) };
}

export function classifyProviderFailure(message: AssistantMessage, contextWindow?: number): ProviderFailureKind | undefined {
  return describeProviderFailure(message, contextWindow)?.kind;
}

export function isRetryableProviderFailure(kind: ProviderFailureKind) {
  return kind === "model_cooldown" || kind === "rate_limit" || kind === "timeout" || kind === "network" || kind === "server" || kind === "empty_response" || kind === "unknown";
}
