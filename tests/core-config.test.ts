import { describe, expect, it } from "vitest";
import { createModel, loadConfig, publicRuntimeConfig } from "@tagent/core-service/config";

describe("Core service configuration", () => {
  it("uses the TAgent OpenAI-compatible defaults", () => {
    const config = loadConfig({});
    expect(config.runtime).toBe("in-process");
    expect(config.apiCredentialReference).toBe("OPENAI_API_KEY");
    expect(config.apiCredentialConfigured).toBe(false);
    expect(config).toMatchObject({
      providerTimeoutMs: 15_000,
      providerMaxRetries: 1,
      runTimeoutMs: 120_000,
      runHardTimeoutMs: 86_400_000,
      maxContinuations: 4,
      maxContextTurns: 20,
      historicalToolResultChars: 4_000,
      historicalTaskRunReceiptChars: 600,
      routerTimeoutMs: 5_000,
      supervisorTimeoutMs: 5_000,
    });
    expect(config.memory).toEqual({ enabled: false });
    expect(config.model).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://one.tms.im/v1",
      modelId: "gpt-5.6-sol",
      provider: "openai-compatible",
    });
    expect(config.routerModel).toMatchObject({ modelId: "gpt-5.6-luna", reasoning: false });
    expect(config.supervisorModel).toMatchObject({
      modelId: "gpt-5.6-luna",
      reasoning: false,
      maxTokens: 1_024,
    });
  });

  it("supports an ordered main-model fallback chain", () => {
    const config = loadConfig({ TAGENT_MODEL: "primary, fallback-a, fallback-b" });
    expect(config.model.modelId).toBe("primary");
    expect(config.fallbackModels.map((model) => model.modelId)).toEqual(["fallback-a", "fallback-b"]);
    expect(publicRuntimeConfig(config).fallbackModelIds).toEqual(["fallback-a", "fallback-b"]);
  });

  it("allows independent lightweight Router and Supervisor models", () => {
    const config = loadConfig({
      TAGENT_MODEL: "main-model",
      TAGENT_ROUTER_MODEL: "router-small",
      TAGENT_SUPERVISOR_MODEL: "supervisor-small",
      TAGENT_SUPERVISOR_TIMEOUT_MS: "9000",
    });
    expect(config.model.modelId).toBe("main-model");
    expect(config.routerModel.modelId).toBe("router-small");
    expect(config.supervisorModel.modelId).toBe("supervisor-small");
    expect(publicRuntimeConfig(config)).toMatchObject({
      routerModelId: "router-small",
      supervisorModelId: "supervisor-small",
      supervisorTimeoutMs: 9_000,
    });
  });

  it("normalizes custom base URLs and constructs a runtime-neutral model", () => {
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
    expect(model).not.toHaveProperty("compat");
  });

  it("supports native Anthropic transport and loopback IPv6 hosting", () => {
    const config = loadConfig({
      HOST: "::1",
      TAGENT_API: "anthropic-messages",
      TAGENT_API_BASE: "https://relay.example",
    });
    expect(config.host).toBe("::1");
    expect(createModel(config.model)).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://relay.example",
    });
    expect(createModel(config.model)).not.toHaveProperty("compat");
    expect(() => loadConfig({ TAGENT_API: "unsupported" })).toThrow("TAGENT_API must be");
  });

  it("exposes runtime status without exposing credentials", () => {
    const status = publicRuntimeConfig(loadConfig({ OPENAI_API_KEY: "secret" }));
    expect(status.releaseVersion).toBe("0.8.6");
    expect(status.credentialConfigured).toBe(true);
    expect(status).not.toHaveProperty("apiKey");
    expect(JSON.stringify(status)).not.toContain("secret");
    expect(status.memoryEnabled).toBe(false);
  });

  it("does not validate memory-only settings while Memory is disabled", () => {
    const config = loadConfig({
      TAGENT_MEMORY_ENABLED: "false",
      TAGENT_MEMORY_BACKEND: "invalid",
      TAGENT_MEMORY_COLD_BACKEND: "invalid",
      TAGENT_MEMORY_WORKER_INTERVAL_MS: "invalid",
    });
    expect(config.memory).toEqual({ enabled: false });
  });

  it("validates enabled Memory dependencies and backend settings", () => {
    expect(() => loadConfig({ TAGENT_MEMORY_ENABLED: "true" }))
      .toThrow("TAGENT_MEMORY_POSTGRES_URL is required");
    expect(() => loadConfig({ TAGENT_MEMORY_ENABLED: "yes" }))
      .toThrow("TAGENT_MEMORY_ENABLED must be true or false");
    expect(() => loadConfig({ TAGENT_MEMORY_ENABLED: "true", TAGENT_MEMORY_BACKEND: "invalid" }))
      .toThrow("TAGENT_MEMORY_BACKEND must be memory or postgres");
    expect(() => loadConfig({
      TAGENT_MEMORY_ENABLED: "true",
      TAGENT_MEMORY_BACKEND: "memory",
      TAGENT_MEMORY_COLD_BACKEND: "s3",
    })).toThrow("TAGENT_MEMORY_S3_BUCKET is required");

    const config = loadConfig({ TAGENT_MEMORY_ENABLED: "true", TAGENT_MEMORY_BACKEND: "memory" });
    expect(config.memory).toMatchObject({ enabled: true, backend: "memory", coldBackend: "local" });
    expect(publicRuntimeConfig(config)).toMatchObject({
      memoryEnabled: true,
      memoryWorkspaceScopeId: "default",
      memoryBackend: "memory",
      memoryColdBackend: "local",
    });
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
      extractorCredentialReference: "OPENAI_API_KEY",
    });
    expect(JSON.stringify(config.memory)).not.toContain("secret");
  });

  it("configures scoped service credentials without exposing tokens", () => {
    const token = "service-token-with-at-least-24-characters";
    const principal = {
      subjectId: "gateway:test",
      resourceScopes: [{ type: "workspace" as const, id: "workspace-1" }],
    };
    const config = loadConfig({
      TAGENT_SERVICE_CREDENTIALS: JSON.stringify([
        { token, scopes: ["sessions:read", "runs:read"], principal },
      ]),
    });
    expect(config.serviceCredentials).toEqual([
      { token, scopes: ["sessions:read", "runs:read"], principal },
    ]);
    const status = publicRuntimeConfig(config);
    expect(status.serviceAuthenticationConfigured).toBe(true);
    expect(JSON.stringify(status)).not.toContain(token);
    expect(() => loadConfig({
      TAGENT_SERVICE_CREDENTIALS: JSON.stringify([{ token: "short", scopes: ["sessions:read"] }]),
    })).toThrow("at least 24");
    expect(() => loadConfig({
      TAGENT_SERVICE_CREDENTIALS: JSON.stringify([{ token, scopes: ["settings:admin"] }]),
    })).toThrow("invalid scope");
  });

  it("fails closed on non-loopback hosts without service credentials", () => {
    expect(() => loadConfig({ HOST: "0.0.0.0" }))
      .toThrow("TAGENT_SERVICE_CREDENTIALS is required when HOST is not loopback");

    const token = "remote-service-token-with-24-characters";
    const config = loadConfig({
      HOST: "0.0.0.0",
      TAGENT_SERVICE_CREDENTIALS: JSON.stringify([{ token, scopes: ["sessions:read"] }]),
    });
    expect(config).toMatchObject({ host: "0.0.0.0", serviceCredentials: [{ token }] });
  });

  it("rejects unsupported runtime modes", () => {
    expect(() => loadConfig({ TAGENT_RUNTIME: "rpc" })).toThrow("Unsupported TAGENT_RUNTIME");
  });
});
