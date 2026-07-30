import { describe, expect, it } from "vitest";
import { createModel, loadConfig } from "../src/config.js";

describe("configuration", () => {
  it("uses the TAgent OpenAI-compatible defaults", () => {
    const config = loadConfig({});
    expect(config.runtime).toBe("in-process");
    expect(config.model).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://one.tms.im/v1",
      modelId: "gpt-5.6-sol",
      provider: "openai-compatible",
    });
  });

  it("normalizes custom base URLs and constructs a pi model", () => {
    const config = loadConfig({
      TAGENT_API_BASE: "https://example.test/v1/",
      TAGENT_MODEL: "custom-model",
      TAGENT_REASONING: "false",
    });
    const model = createModel(config.model);
    expect(model).toMatchObject({
      id: "custom-model",
      api: "openai-completions",
      baseUrl: "https://example.test/v1",
      reasoning: false,
    });
    expect(model.compat?.maxTokensField).toBe("max_completion_tokens");
  });

  it("rejects unsupported runtime modes", () => {
    expect(() => loadConfig({ TAGENT_RUNTIME: "rpc" })).toThrow("Unsupported TAGENT_RUNTIME");
  });
});
