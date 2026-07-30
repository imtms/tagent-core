import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { classifyProviderFailure, isRetryableProviderFailure } from "../src/runtime/provider-errors.js";

function error(message: string, stopReason: AssistantMessage["stopReason"] = "error"): AssistantMessage {
  return { role: "assistant", content: [], api: "openai-completions", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason, errorMessage: message, timestamp: 1 };
}

describe("provider failure classification", () => {
  it.each([
    ["401 Unauthorized", "auth", false],
    ["429 rate limit exceeded", "rate_limit", true],
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

  it("classifies aborted and successful messages without string heuristics", () => {
    expect(classifyProviderFailure(error("Request was aborted", "aborted"))).toBe("aborted");
    expect(classifyProviderFailure({ ...error(""), stopReason: "stop" })).toBeUndefined();
  });
});
