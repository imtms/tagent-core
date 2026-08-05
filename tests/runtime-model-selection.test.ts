import { describe, expect, it } from "vitest";
import { selectRuntimeModel } from "@tagent/execution/composition";
import type { RuntimeModelSpec } from "@tagent/execution/ports";

const model = (id: string, reasoning = true): RuntimeModelSpec => ({
  id, provider: "openai-compatible", api: "openai-responses", baseUrl: "https://example.test/v1",
  reasoning, contextWindow: 200_000, maxTokens: 32_768,
});

describe("Workspace runtime model selection", () => {
  it("selects only a configured model and preserves the remaining fallback order", () => {
    const primary = model("gpt-5.6-sol");
    const luna = model("gpt-5.6-luna");
    const selection = selectRuntimeModel({ modelId: luna.id, reasoningEffort: "high" }, primary, [luna]);
    expect(selection).toEqual({ model: luna, fallbackModels: [primary], reasoningEffort: "high" });
    expect(() => selectRuntimeModel({ modelId: "unconfigured", reasoningEffort: "high" }, primary, [luna]))
      .toThrow("Model is not allowed: unconfigured");
  });

  it("requires a concrete snapshot and disables reasoning for a non-reasoning model", () => {
    const plain = model("plain", false);
    expect(selectRuntimeModel({ modelId: "plain", reasoningEffort: "high" }, plain))
      .toMatchObject({ model: plain, reasoningEffort: "off" });
    expect(() => selectRuntimeModel({ modelId: "", reasoningEffort: "high" }, plain))
      .toThrow("TaskRun modelId is required");
    expect(selectRuntimeModel({ modelId: "embedded-model", reasoningEffort: "high" }, undefined))
      .toEqual({ model: undefined, fallbackModels: [], reasoningEffort: "high" });
  });
});
