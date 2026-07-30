import type { Model } from "@mariozechner/pi-ai";

export interface ModelConfig {
  provider: string;
  modelId: string;
  api: "openai-completions";
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}

export interface AppConfig {
  port: number;
  database: string;
  workspace: string;
  runtime: "in-process";
  apiKey?: string;
  providerTimeoutMs: number;
  providerMaxRetries: number;
  runTimeoutMs: number;
  model: ModelConfig;
}

function positiveInteger(value: string | undefined, fallback: number, name: string) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value: string | undefined, fallback: number, name: string) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function normalizeBaseUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("TAGENT_API_BASE must use http or https");
  return url.toString().replace(/\/$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const runtime = env.TAGENT_RUNTIME ?? "in-process";
  if (runtime !== "in-process") throw new Error(`Unsupported TAGENT_RUNTIME: ${runtime}`);
  return {
    port: positiveInteger(env.PORT, 3100, "PORT"),
    database: env.TAGENT_DB ?? "./data/tagent.db",
    workspace: env.TAGENT_WORKSPACE ?? process.cwd(),
    runtime,
    apiKey: env.OPENAI_API_KEY,
    providerTimeoutMs: positiveInteger(env.TAGENT_PROVIDER_TIMEOUT_MS, 120_000, "TAGENT_PROVIDER_TIMEOUT_MS"),
    providerMaxRetries: nonNegativeInteger(env.TAGENT_PROVIDER_MAX_RETRIES, 1, "TAGENT_PROVIDER_MAX_RETRIES"),
    runTimeoutMs: positiveInteger(env.TAGENT_RUN_TIMEOUT_MS, 900_000, "TAGENT_RUN_TIMEOUT_MS"),
    model: {
      provider: env.TAGENT_PROVIDER ?? "openai-compatible",
      modelId: env.TAGENT_MODEL ?? "gpt-5.6-sol",
      api: "openai-completions",
      baseUrl: normalizeBaseUrl(env.TAGENT_API_BASE ?? "https://one.tms.im/v1"),
      contextWindow: positiveInteger(env.TAGENT_CONTEXT_WINDOW, 200_000, "TAGENT_CONTEXT_WINDOW"),
      maxTokens: positiveInteger(env.TAGENT_MAX_TOKENS, 32_768, "TAGENT_MAX_TOKENS"),
      reasoning: env.TAGENT_REASONING !== "false",
    },
  };
}

export interface PublicRuntimeConfig {
  runtime: AppConfig["runtime"];
  provider: string;
  api: ModelConfig["api"];
  baseUrl: string;
  modelId: string;
  credentialConfigured: boolean;
  providerTimeoutMs: number;
  providerMaxRetries: number;
  runTimeoutMs: number;
}

export function publicRuntimeConfig(config: AppConfig): PublicRuntimeConfig {
  return {
    runtime: config.runtime,
    provider: config.model.provider,
    api: config.model.api,
    baseUrl: config.model.baseUrl,
    modelId: config.model.modelId,
    credentialConfigured: Boolean(config.apiKey),
    providerTimeoutMs: config.providerTimeoutMs,
    providerMaxRetries: config.providerMaxRetries,
    runTimeoutMs: config.runTimeoutMs,
  };
}

export function createModel(config: ModelConfig): Model<"openai-completions"> {
  return {
    id: config.modelId,
    name: config.modelId,
    api: config.api,
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: config.reasoning,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: true,
      supportsReasoningEffort: config.reasoning,
      supportsUsageInStreaming: true,
      maxTokensField: "max_completion_tokens",
      requiresToolResultName: false,
      requiresAssistantAfterToolResult: false,
      requiresThinkingAsText: false,
      requiresReasoningContentOnAssistantMessages: false,
      thinkingFormat: "openai",
      supportsStrictMode: true,
      sendSessionAffinityHeaders: false,
      supportsLongCacheRetention: false,
    },
  };
}
