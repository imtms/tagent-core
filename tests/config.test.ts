import { describe, expect, it } from "vitest";
import { createModel, loadConfig, publicRuntimeConfig } from "../src/config.js";

describe("configuration", () => {
  it("uses the TAgent OpenAI-compatible defaults", () => {
    const config = loadConfig({});
    expect(config.runtime).toBe("in-process");
    expect(config.apiKey).toBeUndefined();
    expect(config).toMatchObject({ providerTimeoutMs: 120_000, providerMaxRetries: 1, runTimeoutMs: 7_200_000, runHardTimeoutMs: 86_400_000, maxContinuations: 128, maxContextTurns: 20 });
    expect(config.memory).toEqual({ enabled: false });
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
    expect(status.memoryEnabled).toBe(false);
  });

  it("does not validate or initialize memory-only settings while memory is disabled", () => {
    const config = loadConfig({
      TAGENT_MEMORY_ENABLED: "false",
      TAGENT_MEMORY_BACKEND: "invalid",
      TAGENT_MEMORY_COLD_BACKEND: "invalid",
      TAGENT_MEMORY_WORKER_INTERVAL_MS: "invalid",
    });
    expect(config.memory).toEqual({ enabled: false });
  });

  it("validates enabled memory dependencies and backend settings", () => {
    expect(() => loadConfig({ TAGENT_MEMORY_ENABLED: "true" })).toThrow("TAGENT_MEMORY_POSTGRES_URL is required");
    expect(() => loadConfig({ TAGENT_MEMORY_ENABLED: "yes" })).toThrow("TAGENT_MEMORY_ENABLED must be true or false");
    expect(() => loadConfig({ TAGENT_MEMORY_ENABLED: "true", TAGENT_MEMORY_BACKEND: "invalid" })).toThrow("TAGENT_MEMORY_BACKEND must be memory or postgres");
    expect(() => loadConfig({ TAGENT_MEMORY_ENABLED: "true", TAGENT_MEMORY_BACKEND: "memory", TAGENT_MEMORY_COLD_BACKEND: "s3" })).toThrow("TAGENT_MEMORY_S3_BUCKET is required");

    const config = loadConfig({ TAGENT_MEMORY_ENABLED: "true", TAGENT_MEMORY_BACKEND: "memory" });
    expect(config.memory).toMatchObject({ enabled: true, backend: "memory", coldBackend: "local" });
    expect(publicRuntimeConfig(config)).toMatchObject({ memoryEnabled: true, memoryWorkspaceScopeId: "default", memoryBackend: "memory", memoryColdBackend: "local" });
  });

  it("resolves systemd-style extractor environment references", () => {
    const config = loadConfig({
      TAGENT_MEMORY_ENABLED: "true",
      TAGENT_MEMORY_BACKEND: "memory",
      TAGENT_MEMORY_EXTRACTOR_PROVIDER: "hybrid",
      TAGENT_API_BASE: "https://example.test/v1",
      TAGENT_MODEL: "semantic-model",
      OPENAI_API_KEY: "secret",
      TAGENT_MEMORY_EXTRACTOR_BASE_URL: "${TAGENT_API_BASE}",
      TAGENT_MEMORY_EXTRACTOR_MODEL: "${TAGENT_MODEL}",
      TAGENT_MEMORY_EXTRACTOR_API_KEY: "${OPENAI_API_KEY}",
    });
    expect(config.memory).toMatchObject({
      enabled: true,
      extractorBaseUrl: "https://example.test/v1",
      extractorModel: "semantic-model",
      extractorApiKey: "secret",
    });
  });

  it("configures scoped service credentials without exposing tokens", () => {
    const token = "service-token-with-at-least-24-characters";
    const config = loadConfig({ TAGENT_SERVICE_CREDENTIALS: JSON.stringify([{ token, scopes: ["sessions:read", "runs:read"] }]) });
    expect(config.serviceCredentials).toEqual([{ token, scopes: ["sessions:read", "runs:read"] }]);
    const status = publicRuntimeConfig(config);
    expect(status.serviceAuthenticationConfigured).toBe(true);
    expect(JSON.stringify(status)).not.toContain(token);
    expect(() => loadConfig({ TAGENT_SERVICE_CREDENTIALS: JSON.stringify([{ token: "short", scopes: ["sessions:read"] }]) })).toThrow("at least 24");
    expect(() => loadConfig({ TAGENT_SERVICE_CREDENTIALS: JSON.stringify([{ token, scopes: ["settings:admin"] }]) })).toThrow("invalid scope");
  });

  it("rejects unsupported runtime modes", () => {
    expect(() => loadConfig({ TAGENT_RUNTIME: "rpc" })).toThrow("Unsupported TAGENT_RUNTIME");
  });
});
