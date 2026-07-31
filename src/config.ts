import type { Model } from "@earendil-works/pi-ai/compat";

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
  runHardTimeoutMs: number;
  maxContinuations: number;
  maxRunTokens: number;
  maxContextTurns: number;
  contextReserveTokens?: number;
  dynamicBudget: boolean;
  controlInboxCapacity: number;
  model: ModelConfig;
  memory: MemoryConfig;
}

export type MemoryConfig =
  | { enabled: false }
  | {
      enabled: true;
      backend: "memory" | "postgres";
      postgresUrl?: string;
      coldBackend: "local" | "s3";
      coldPath: string;
      s3Bucket?: string;
      s3Prefix?: string;
      s3Endpoint?: string;
      s3Region?: string;
      s3ForcePathStyle: boolean;
      workerIntervalMs: number;
      maintenanceIntervalMs: number;
      workspaceScopeId: string;
      recallTokenBudget: number;
      coldMinimumRecords: number;
      warmAfterMs: number;
      hotTtlMs: number;
    };

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

function enabled(value: string | undefined, name: string) {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be true or false`);
}

function loadMemoryConfig(env: NodeJS.ProcessEnv): MemoryConfig {
  if (!enabled(env.TAGENT_MEMORY_ENABLED, "TAGENT_MEMORY_ENABLED")) return { enabled: false };

  const backend = env.TAGENT_MEMORY_BACKEND ?? "postgres";
  if (backend !== "memory" && backend !== "postgres") throw new Error("TAGENT_MEMORY_BACKEND must be memory or postgres");
  if (backend === "postgres" && !env.TAGENT_MEMORY_POSTGRES_URL?.trim()) {
    throw new Error("TAGENT_MEMORY_POSTGRES_URL is required when TAGENT_MEMORY_ENABLED=true and TAGENT_MEMORY_BACKEND=postgres");
  }

  const coldBackend = env.TAGENT_MEMORY_COLD_BACKEND ?? "local";
  if (coldBackend !== "local" && coldBackend !== "s3") throw new Error("TAGENT_MEMORY_COLD_BACKEND must be local or s3");
  if (coldBackend === "s3" && !env.TAGENT_MEMORY_S3_BUCKET?.trim()) {
    throw new Error("TAGENT_MEMORY_S3_BUCKET is required when TAGENT_MEMORY_COLD_BACKEND=s3");
  }

  return {
    enabled: true,
    backend,
    postgresUrl: env.TAGENT_MEMORY_POSTGRES_URL?.trim() || undefined,
    coldBackend,
    coldPath: env.TAGENT_MEMORY_COLD_PATH ?? "./data/memory-cold",
    s3Bucket: env.TAGENT_MEMORY_S3_BUCKET?.trim() || undefined,
    s3Prefix: env.TAGENT_MEMORY_S3_PREFIX,
    s3Endpoint: env.TAGENT_MEMORY_S3_ENDPOINT,
    s3Region: env.TAGENT_MEMORY_S3_REGION,
    s3ForcePathStyle: enabled(env.TAGENT_MEMORY_S3_FORCE_PATH_STYLE, "TAGENT_MEMORY_S3_FORCE_PATH_STYLE"),
    workerIntervalMs: positiveInteger(env.TAGENT_MEMORY_WORKER_INTERVAL_MS, 1_000, "TAGENT_MEMORY_WORKER_INTERVAL_MS"),
    maintenanceIntervalMs: positiveInteger(env.TAGENT_MEMORY_MAINTENANCE_INTERVAL_MS, 60_000, "TAGENT_MEMORY_MAINTENANCE_INTERVAL_MS"),
    workspaceScopeId: env.TAGENT_MEMORY_WORKSPACE_SCOPE_ID ?? "default",
    recallTokenBudget: positiveInteger(env.TAGENT_MEMORY_RECALL_TOKEN_BUDGET, 8_000, "TAGENT_MEMORY_RECALL_TOKEN_BUDGET"),
    coldMinimumRecords: positiveInteger(env.TAGENT_MEMORY_COLD_MINIMUM_RECORDS, 2, "TAGENT_MEMORY_COLD_MINIMUM_RECORDS"),
    warmAfterMs: nonNegativeInteger(env.TAGENT_MEMORY_WARM_AFTER_MS, 0, "TAGENT_MEMORY_WARM_AFTER_MS"),
    hotTtlMs: positiveInteger(env.TAGENT_MEMORY_HOT_TTL_MS, 2_592_000_000, "TAGENT_MEMORY_HOT_TTL_MS"),
  };
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
    runTimeoutMs: positiveInteger(env.TAGENT_RUN_TIMEOUT_MS, 7_200_000, "TAGENT_RUN_TIMEOUT_MS"),
    runHardTimeoutMs: positiveInteger(env.TAGENT_RUN_HARD_TIMEOUT_MS, 86_400_000, "TAGENT_RUN_HARD_TIMEOUT_MS"),
    maxContinuations: nonNegativeInteger(env.TAGENT_MAX_CONTINUATIONS, 128, "TAGENT_MAX_CONTINUATIONS"),
    maxRunTokens: positiveInteger(env.TAGENT_MAX_RUN_TOKENS, 2_000_000, "TAGENT_MAX_RUN_TOKENS"),
    maxContextTurns: positiveInteger(env.TAGENT_MAX_CONTEXT_TURNS, 20, "TAGENT_MAX_CONTEXT_TURNS"),
    contextReserveTokens: env.TAGENT_CONTEXT_RESERVE_TOKENS === undefined ? undefined : positiveInteger(env.TAGENT_CONTEXT_RESERVE_TOKENS, 10_000, "TAGENT_CONTEXT_RESERVE_TOKENS"),
    dynamicBudget: env.TAGENT_DYNAMIC_BUDGET !== "false",
    controlInboxCapacity: positiveInteger(env.TAGENT_CONTROL_INBOX_CAPACITY, 32, "TAGENT_CONTROL_INBOX_CAPACITY"),
    memory: loadMemoryConfig(env),
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
  runHardTimeoutMs: number;
  maxContinuations: number;
  maxRunTokens: number;
  maxContextTurns: number;
  contextReserveTokens?: number;
  dynamicBudget: boolean;
  controlInboxCapacity: number;
  schemaVersion?: number;
  memoryEnabled: boolean;
  memoryWorkspaceScopeId?: string;
  memoryBackend?: "memory" | "postgres";
  memoryColdBackend?: "local" | "s3";
}

export function publicRuntimeConfig(config: AppConfig, schemaVersion?: number): PublicRuntimeConfig {
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
    runHardTimeoutMs: config.runHardTimeoutMs,
    maxContinuations: config.maxContinuations,
    maxRunTokens: config.maxRunTokens,
    maxContextTurns: config.maxContextTurns,
    contextReserveTokens: config.contextReserveTokens,
    dynamicBudget: config.dynamicBudget,
    controlInboxCapacity: config.controlInboxCapacity,
    schemaVersion,
    memoryEnabled: config.memory.enabled,
    memoryWorkspaceScopeId: config.memory.enabled ? config.memory.workspaceScopeId : undefined,
    memoryBackend: config.memory.enabled ? config.memory.backend : undefined,
    memoryColdBackend: config.memory.enabled ? config.memory.coldBackend : undefined,
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
