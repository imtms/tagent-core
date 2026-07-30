import { describe, expect, it } from "vitest";
import { createModel, loadConfig, publicRuntimeConfig } from "../src/config.js";

describe("configuration", () => {
  it("uses the TAgent OpenAI-compatible defaults", () => {
    const config = loadConfig({});
    expect(config.runtime).toBe("in-process");
    expect(config.apiKey).toBeUndefined();
    expect(config).toMatchObject({ providerTimeoutMs: 120_000, providerMaxRetries: 1, runTimeoutMs: 7_200_000, maxContinuations: 128, maxRunTokens: 2_000_000, dynamicBudget: true });
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

  it("exposes runtime status without exposing the credential", () => {
    const status = publicRuntimeConfig(loadConfig({ OPENAI_API_KEY: "secret" }));
    expect(status.credentialConfigured).toBe(true);
    expect(status).not.toHaveProperty("apiKey");
    expect(JSON.stringify(status)).not.toContain("secret");
  });

  it("rejects unsupported runtime modes", () => {
    expect(() => loadConfig({ TAGENT_RUNTIME: "rpc" })).toThrow("Unsupported TAGENT_RUNTIME");
  });
});
