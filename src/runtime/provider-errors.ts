import type { AssistantMessage } from "@mariozechner/pi-ai";
import { isContextOverflow } from "@mariozechner/pi-ai";

export type ProviderFailureKind = "aborted" | "auth" | "invalid_request" | "context_overflow" | "rate_limit" | "timeout" | "network" | "server" | "unknown";

export function classifyProviderFailure(message: AssistantMessage, contextWindow?: number): ProviderFailureKind | undefined {
  if (message.stopReason === "aborted") return "aborted";
  if (isContextOverflow(message, contextWindow)) return "context_overflow";
  if (message.stopReason !== "error") return undefined;
  const text = message.errorMessage?.toLowerCase() ?? "";
  if (/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid api key|authentication/.test(text)) return "auth";
  if (/\b429\b|rate.?limit|too many requests|throttl/.test(text)) return "rate_limit";
  if (/\b5\d\d\b|internal server|bad gateway|service unavailable|gateway timeout/.test(text)) return "server";
  if (/timeout|timed out|deadline exceeded/.test(text)) return "timeout";
  if (/econnreset|econnrefused|enotfound|network|socket|fetch failed|connection/.test(text)) return "network";
  if (/\b400\b|bad request|invalid request|invalid parameter|validation/.test(text)) return "invalid_request";
  return "unknown";
}

export function isRetryableProviderFailure(kind: ProviderFailureKind) {
  return kind === "rate_limit" || kind === "timeout" || kind === "network" || kind === "server" || kind === "unknown";
}
