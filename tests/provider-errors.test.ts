import { describe, expect, it } from "vitest";
import type { RuntimeMessage } from "@tagent/execution/ports";
type AssistantMessage = Extract<RuntimeMessage, { role: "assistant" }>;
import { classifyProviderFailure, describeProviderFailure, isRetryableProviderFailure, providerRetryAfterHeaderMs, providerRetryAfterMs } from "@tagent/runtime-pi/provider-errors";

function error(message: string, stopReason: AssistantMessage["stopReason"] = "error"): AssistantMessage {
  return { role: "assistant", content: [], api: "openai-completions", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, errorMessage: message, timestamp: 1 };
}

describe("provider failure classification", () => {
  it.each([
    ["401 Unauthorized", "auth", false],
    ["429 rate limit exceeded", "rate_limit", true],
    ['{"type":"model_cooldown","reset_seconds":47}', "model_cooldown", true],
    ["503 Service unavailable", "server", true],
    ["request timed out", "timeout", true],
    ["ECONNRESET socket closed", "network", true],
    ["400 invalid request", "invalid_request", false],
    ["Your input exceeds the context window of this model", "context_overflow", false],
  ] as const)("classifies %s", (message, kind, retryable) => {
    const classified = classifyProviderFailure(error(message));
    expect(classified).toBe(kind);
    expect(isRetryableProviderFailure(classified!)).toBe(retryable);
  });

  it("extracts bounded cooldown delays from provider bodies and Retry-After text", () => {
    expect(describeProviderFailure(error('{"type":"model_cooldown","reset_seconds":47}'))).toEqual({ kind: "model_cooldown", retryAfterMs: 47_000 });
    expect(providerRetryAfterMs("Retry-After: 12")).toBe(12_000);
    expect(providerRetryAfterMs("retry after 2.5 seconds")).toBe(2_500);
    expect(providerRetryAfterMs('{"reset_seconds":99999}')).toBe(3_600_000);
    expect(providerRetryAfterHeaderMs(new Headers({ "retry-after": "12" }))).toBe(12_000);
    expect(providerRetryAfterHeaderMs(new Headers({ "retry-after-ms": "2500" }))).toBe(2_500);
  });

  it("classifies aborted and successful messages without string heuristics", () => {
    expect(classifyProviderFailure(error("Request was aborted", "aborted"))).toBe("aborted");
    expect(classifyProviderFailure({ ...error(""), stopReason: "stop", content: [{ type: "text", text: "complete" }] })).toBeUndefined();
    expect(classifyProviderFailure({ ...error(""), stopReason: "stop" })).toBe("empty_response");
    expect(isRetryableProviderFailure("empty_response")).toBe(true);
  });
});
