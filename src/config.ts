import type { ServiceCredential, ServiceScope } from "./auth.js";
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
  routerTimeoutMs: number;
  supervisorTimeoutMs: number;
  runTimeoutMs: number;
  runHardTimeoutMs: number;
  maxContinuations: number;
  maxContextTurns: number;
  controlInboxCapacity: number;
  serviceCredentials: ServiceCredential[];
  model: ModelConfig;
  routerModel: ModelConfig;
  supervisorModel: ModelConfig;
  memory: MemoryConfig;
  learning: {
    enabledByDefault: boolean;
    autoExecutionEnabledByDefault: boolean;
    distillationWorkerIntervalMs: number;
    semanticJudgeEnabled: boolean;
    semanticJudgeBaseUrl?: string;
    semanticJudgeApiKey?: string;
    semanticJudgeModel?: string;
    semanticJudgeTimeoutMs: number;
    semanticJudgeMinimumConfidence: number;
    semanticJudgeCacheTtlMs: number;
    semanticJudgeMaxCallsPerMinute: number;
  };
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
      coldMinimumRecords: number;
      warmAfterMs: number;
      hotTtlMs: number;
      candidateTtlMs: number;
      deletedGracePeriodMs: number;
      retentionFactStaleMs: number;
      retentionFactDeleteMs: number;
      retentionPreferenceStaleMs: number;
      retentionPreferenceDeleteMs: number;
      retentionEpisodeStaleMs: number;
      retentionEpisodeDeleteMs: number;
      retentionProcedureStaleMs: number;
      retentionProcedureDeleteMs: number;
      embeddingProvider: "hash" | "openai" | "none";
      embeddingBaseUrl?: string;
      embeddingApiKey?: string;
      embeddingModel?: string;
      embeddingDimensions?: number;
      embeddingBatchSize: number;
      embeddingExtraBody?: Record<string,unknown>;
      extractorProvider: "rule" | "hybrid";
      extractorBaseUrl?: string;
      extractorApiKey?: string;
      extractorModel?: string;
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

function probability(value: string | undefined, fallback: number, name: string) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) throw new Error(`${name} must be between 0 and 1`);
  return parsed;
}

function enabled(value: string | undefined, name: string) {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error(`${name} must be true or false`);
}


function parseJsonObject(value:string|undefined,name:string){if(!value?.trim())return undefined;let parsed:unknown;try{parsed=JSON.parse(value);}catch{throw new Error(`${name} must be valid JSON`);}if(!parsed||Array.isArray(parsed)||typeof parsed!=="object")throw new Error(`${name} must be a JSON object`);return parsed as Record<string,unknown>;}
function memoryEmbeddingProvider(env: NodeJS.ProcessEnv) {
  const value = env.TAGENT_MEMORY_EMBEDDING_PROVIDER ?? (env.TAGENT_MEMORY_BACKEND === "memory" ? "hash" : "none");
  if (value !== "hash" && value !== "openai" && value !== "none") throw new Error("TAGENT_MEMORY_EMBEDDING_PROVIDER must be hash, openai, or none");
  if (value === "openai" && (!env.TAGENT_MEMORY_EMBEDDING_BASE_URL?.trim() || !env.TAGENT_MEMORY_EMBEDDING_API_KEY?.trim() || !env.TAGENT_MEMORY_EMBEDDING_MODEL?.trim())) throw new Error("OpenAI memory embeddings require TAGENT_MEMORY_EMBEDDING_BASE_URL, TAGENT_MEMORY_EMBEDDING_API_KEY, and TAGENT_MEMORY_EMBEDDING_MODEL");
  return value;
}
function referencedEnvValue(env: NodeJS.ProcessEnv, name: string) {
  const raw = env[name]?.trim();
  if (!raw) return undefined;
  const reference = /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(raw)?.[1];
  return reference ? env[reference]?.trim() || undefined : raw;
}
function memoryExtractorProvider(env: NodeJS.ProcessEnv) {
  const value = env.TAGENT_MEMORY_EXTRACTOR_PROVIDER ?? "rule";
  if (value !== "rule" && value !== "hybrid") throw new Error("TAGENT_MEMORY_EXTRACTOR_PROVIDER must be rule or hybrid");
  if (value === "hybrid" && (!(referencedEnvValue(env, "TAGENT_MEMORY_EXTRACTOR_BASE_URL") || env.TAGENT_API_BASE?.trim()) || !(referencedEnvValue(env, "TAGENT_MEMORY_EXTRACTOR_API_KEY") || env.OPENAI_API_KEY?.trim()) || !(referencedEnvValue(env, "TAGENT_MEMORY_EXTRACTOR_MODEL") || env.TAGENT_MODEL?.trim()))) throw new Error("Hybrid memory extraction requires extractor or main model base URL, API key, and model");
  return value;
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
    coldMinimumRecords: positiveInteger(env.TAGENT_MEMORY_COLD_MINIMUM_RECORDS, 2, "TAGENT_MEMORY_COLD_MINIMUM_RECORDS"),
    warmAfterMs: nonNegativeInteger(env.TAGENT_MEMORY_WARM_AFTER_MS, 0, "TAGENT_MEMORY_WARM_AFTER_MS"),
    hotTtlMs: positiveInteger(env.TAGENT_MEMORY_HOT_TTL_MS, 2_592_000_000, "TAGENT_MEMORY_HOT_TTL_MS"),
    candidateTtlMs: positiveInteger(env.TAGENT_MEMORY_CANDIDATE_TTL_MS, 7_776_000_000, "TAGENT_MEMORY_CANDIDATE_TTL_MS"),
    deletedGracePeriodMs: positiveInteger(env.TAGENT_MEMORY_DELETED_GRACE_PERIOD_MS, 2_592_000_000, "TAGENT_MEMORY_DELETED_GRACE_PERIOD_MS"),
    retentionFactStaleMs: positiveInteger(env.TAGENT_MEMORY_FACT_STALE_MS, 31_536_000_000, "TAGENT_MEMORY_FACT_STALE_MS"),
    retentionFactDeleteMs: positiveInteger(env.TAGENT_MEMORY_FACT_DELETE_MS, 63_072_000_000, "TAGENT_MEMORY_FACT_DELETE_MS"),
    retentionPreferenceStaleMs: positiveInteger(env.TAGENT_MEMORY_PREFERENCE_STALE_MS, 31_536_000_000, "TAGENT_MEMORY_PREFERENCE_STALE_MS"),
    retentionPreferenceDeleteMs: positiveInteger(env.TAGENT_MEMORY_PREFERENCE_DELETE_MS, 63_072_000_000, "TAGENT_MEMORY_PREFERENCE_DELETE_MS"),
    retentionEpisodeStaleMs: positiveInteger(env.TAGENT_MEMORY_EPISODE_STALE_MS, 7_776_000_000, "TAGENT_MEMORY_EPISODE_STALE_MS"),
    retentionEpisodeDeleteMs: positiveInteger(env.TAGENT_MEMORY_EPISODE_DELETE_MS, 15_552_000_000, "TAGENT_MEMORY_EPISODE_DELETE_MS"),
    retentionProcedureStaleMs: positiveInteger(env.TAGENT_MEMORY_PROCEDURE_STALE_MS, 15_552_000_000, "TAGENT_MEMORY_PROCEDURE_STALE_MS"),
    retentionProcedureDeleteMs: positiveInteger(env.TAGENT_MEMORY_PROCEDURE_DELETE_MS, 31_536_000_000, "TAGENT_MEMORY_PROCEDURE_DELETE_MS"),
    embeddingProvider: memoryEmbeddingProvider(env),
    embeddingBaseUrl: env.TAGENT_MEMORY_EMBEDDING_BASE_URL?.trim() || undefined,
    embeddingApiKey: env.TAGENT_MEMORY_EMBEDDING_API_KEY?.trim() || undefined,
    embeddingModel: env.TAGENT_MEMORY_EMBEDDING_MODEL?.trim() || undefined,
    embeddingDimensions: env.TAGENT_MEMORY_EMBEDDING_DIMENSIONS ? positiveInteger(env.TAGENT_MEMORY_EMBEDDING_DIMENSIONS, 1024, "TAGENT_MEMORY_EMBEDDING_DIMENSIONS") : undefined,
    embeddingBatchSize: positiveInteger(env.TAGENT_MEMORY_EMBEDDING_BATCH_SIZE, 64, "TAGENT_MEMORY_EMBEDDING_BATCH_SIZE"),
    embeddingExtraBody: parseJsonObject(env.TAGENT_MEMORY_EMBEDDING_EXTRA_BODY, "TAGENT_MEMORY_EMBEDDING_EXTRA_BODY"),
    extractorProvider: memoryExtractorProvider(env),
    extractorBaseUrl: referencedEnvValue(env, "TAGENT_MEMORY_EXTRACTOR_BASE_URL") || env.TAGENT_API_BASE?.trim() || undefined,
    extractorApiKey: referencedEnvValue(env, "TAGENT_MEMORY_EXTRACTOR_API_KEY") || env.OPENAI_API_KEY?.trim() || undefined,
    extractorModel: referencedEnvValue(env, "TAGENT_MEMORY_EXTRACTOR_MODEL") || env.TAGENT_MODEL?.trim() || undefined,
  };
}

function parseServiceCredentials(value?: string): ServiceCredential[] {
  if (!value?.trim()) return [];
  const allowed = new Set<ServiceScope>(["sessions:read", "sessions:write", "runs:read", "runs:control", "events:consume", "workflows:teach", "workflows:govern", "workflows:approve"]);
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("TAGENT_SERVICE_CREDENTIALS must be a JSON array");
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`TAGENT_SERVICE_CREDENTIALS[${index}] must be an object`);
    const token = "token" in item && typeof item.token === "string" ? item.token.trim() : "";
    const scopes = "scopes" in item && Array.isArray(item.scopes) ? item.scopes : [];
    if (token.length < 24) throw new Error(`TAGENT_SERVICE_CREDENTIALS[${index}].token must be at least 24 characters`);
    if (!scopes.length || scopes.some((scope: unknown) => typeof scope !== "string" || !allowed.has(scope as ServiceScope))) throw new Error(`TAGENT_SERVICE_CREDENTIALS[${index}].scopes contains an invalid scope`);
    return { token, scopes: [...new Set(scopes as ServiceScope[])] };
  });
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
    providerTimeoutMs: positiveInteger(env.TAGENT_PROVIDER_TIMEOUT_MS, 15_000, "TAGENT_PROVIDER_TIMEOUT_MS"),
    providerMaxRetries: nonNegativeInteger(env.TAGENT_PROVIDER_MAX_RETRIES, 1, "TAGENT_PROVIDER_MAX_RETRIES"),
    routerTimeoutMs: positiveInteger(env.TAGENT_ROUTER_TIMEOUT_MS, 15_000, "TAGENT_ROUTER_TIMEOUT_MS"),
    supervisorTimeoutMs: positiveInteger(env.TAGENT_SUPERVISOR_TIMEOUT_MS, 15_000, "TAGENT_SUPERVISOR_TIMEOUT_MS"),
    runTimeoutMs: positiveInteger(env.TAGENT_RUN_TIMEOUT_MS, 15_000, "TAGENT_RUN_TIMEOUT_MS"),
    runHardTimeoutMs: positiveInteger(env.TAGENT_RUN_HARD_TIMEOUT_MS, 86_400_000, "TAGENT_RUN_HARD_TIMEOUT_MS"),
    maxContinuations: nonNegativeInteger(env.TAGENT_MAX_CONTINUATIONS, 128, "TAGENT_MAX_CONTINUATIONS"),
    maxContextTurns: positiveInteger(env.TAGENT_MAX_CONTEXT_TURNS, 20, "TAGENT_MAX_CONTEXT_TURNS"),
    controlInboxCapacity: positiveInteger(env.TAGENT_CONTROL_INBOX_CAPACITY, 32, "TAGENT_CONTROL_INBOX_CAPACITY"),
    serviceCredentials: parseServiceCredentials(env.TAGENT_SERVICE_CREDENTIALS),
    memory: loadMemoryConfig(env),
    learning: {
      enabledByDefault: enabled(env.TAGENT_LEARNING_ENABLED, "TAGENT_LEARNING_ENABLED"),
      autoExecutionEnabledByDefault: enabled(env.TAGENT_LEARNING_AUTO_EXECUTION_ENABLED, "TAGENT_LEARNING_AUTO_EXECUTION_ENABLED"),
      distillationWorkerIntervalMs: positiveInteger(env.TAGENT_DISTILLATION_WORKER_INTERVAL_MS, 1_000, "TAGENT_DISTILLATION_WORKER_INTERVAL_MS"),
      semanticJudgeEnabled: enabled(env.TAGENT_LEARNING_SEMANTIC_JUDGE_ENABLED, "TAGENT_LEARNING_SEMANTIC_JUDGE_ENABLED"),
      semanticJudgeBaseUrl: referencedEnvValue(env, "TAGENT_LEARNING_SEMANTIC_JUDGE_BASE_URL") || env.TAGENT_ROUTER_API_BASE?.trim() || env.TAGENT_API_BASE?.trim() || undefined,
      semanticJudgeApiKey: referencedEnvValue(env, "TAGENT_LEARNING_SEMANTIC_JUDGE_API_KEY") || env.OPENAI_API_KEY?.trim() || undefined,
      semanticJudgeModel: referencedEnvValue(env, "TAGENT_LEARNING_SEMANTIC_JUDGE_MODEL") || env.TAGENT_ROUTER_MODEL?.trim() || env.TAGENT_MODEL?.trim() || undefined,
      semanticJudgeTimeoutMs: positiveInteger(env.TAGENT_LEARNING_SEMANTIC_JUDGE_TIMEOUT_MS, 8_000, "TAGENT_LEARNING_SEMANTIC_JUDGE_TIMEOUT_MS"),
      semanticJudgeMinimumConfidence: probability(env.TAGENT_LEARNING_SEMANTIC_JUDGE_MIN_CONFIDENCE, .72, "TAGENT_LEARNING_SEMANTIC_JUDGE_MIN_CONFIDENCE"),
      semanticJudgeCacheTtlMs: positiveInteger(env.TAGENT_LEARNING_SEMANTIC_JUDGE_CACHE_TTL_MS, 86_400_000, "TAGENT_LEARNING_SEMANTIC_JUDGE_CACHE_TTL_MS"),
      semanticJudgeMaxCallsPerMinute: positiveInteger(env.TAGENT_LEARNING_SEMANTIC_JUDGE_MAX_CALLS_PER_MINUTE, 120, "TAGENT_LEARNING_SEMANTIC_JUDGE_MAX_CALLS_PER_MINUTE"),
    },
    model: {
      provider: env.TAGENT_PROVIDER ?? "openai-compatible",
      modelId: env.TAGENT_MODEL ?? "gpt-5.6-sol",
      api: "openai-completions",
      baseUrl: normalizeBaseUrl(env.TAGENT_API_BASE ?? "https://one.tms.im/v1"),
      contextWindow: positiveInteger(env.TAGENT_CONTEXT_WINDOW, 200_000, "TAGENT_CONTEXT_WINDOW"),
      maxTokens: positiveInteger(env.TAGENT_MAX_TOKENS, 32_768, "TAGENT_MAX_TOKENS"),
      reasoning: env.TAGENT_REASONING !== "false",
    },
    routerModel: {
      provider: env.TAGENT_ROUTER_PROVIDER?.trim() || env.TAGENT_PROVIDER || "openai-compatible",
      modelId: env.TAGENT_ROUTER_MODEL ?? "gpt-5.6-luna",
      api: "openai-completions",
      baseUrl: normalizeBaseUrl(env.TAGENT_ROUTER_API_BASE?.trim() || env.TAGENT_API_BASE || "https://one.tms.im/v1"),
      contextWindow: positiveInteger(env.TAGENT_ROUTER_CONTEXT_WINDOW, 64_000, "TAGENT_ROUTER_CONTEXT_WINDOW"),
      maxTokens: positiveInteger(env.TAGENT_ROUTER_MAX_TOKENS, 2_048, "TAGENT_ROUTER_MAX_TOKENS"),
      reasoning: env.TAGENT_ROUTER_REASONING === "true",
    },
    supervisorModel: {
      provider: env.TAGENT_SUPERVISOR_PROVIDER?.trim() || env.TAGENT_PROVIDER || "openai-compatible",
      modelId: env.TAGENT_SUPERVISOR_MODEL ?? "gpt-5.6-luna",
      api: "openai-completions",
      baseUrl: normalizeBaseUrl(env.TAGENT_SUPERVISOR_API_BASE?.trim() || env.TAGENT_API_BASE || "https://one.tms.im/v1"),
      contextWindow: positiveInteger(env.TAGENT_SUPERVISOR_CONTEXT_WINDOW, 64_000, "TAGENT_SUPERVISOR_CONTEXT_WINDOW"),
      maxTokens: positiveInteger(env.TAGENT_SUPERVISOR_MAX_TOKENS, 1_024, "TAGENT_SUPERVISOR_MAX_TOKENS"),
      reasoning: env.TAGENT_SUPERVISOR_REASONING === "true",
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
  serviceAuthenticationConfigured: boolean;
  providerTimeoutMs: number;
  providerMaxRetries: number;
  routerModelId: string;
  routerTimeoutMs: number;
  supervisorModelId: string;
  supervisorTimeoutMs: number;
  runTimeoutMs: number;
  runHardTimeoutMs: number;
  maxContinuations: number;
  maxContextTurns: number;
  controlInboxCapacity: number;
  schemaVersion?: number;
  memoryEnabled: boolean;
  memoryWorkspaceScopeId?: string;
  memoryBackend?: "memory" | "postgres";
  memoryColdBackend?: "local" | "s3";
  learningEnabled: boolean;
  learningAutoExecutionEnabled: boolean;
  learningRequiresMemory: true;
  learningActiveExecutionRequiresApproval: true;
}

export function publicRuntimeConfig(config: AppConfig, schemaVersion?: number): PublicRuntimeConfig {
  return {
    runtime: config.runtime,
    provider: config.model.provider,
    api: config.model.api,
    baseUrl: config.model.baseUrl,
    modelId: config.model.modelId,
    credentialConfigured: Boolean(config.apiKey),
    serviceAuthenticationConfigured: config.serviceCredentials.length > 0,
    providerTimeoutMs: config.providerTimeoutMs,
    providerMaxRetries: config.providerMaxRetries,
    routerModelId: config.routerModel.modelId,
    routerTimeoutMs: config.routerTimeoutMs,
    supervisorModelId: config.supervisorModel.modelId,
    supervisorTimeoutMs: config.supervisorTimeoutMs,
    runTimeoutMs: config.runTimeoutMs,
    runHardTimeoutMs: config.runHardTimeoutMs,
    maxContinuations: config.maxContinuations,
    maxContextTurns: config.maxContextTurns,
    controlInboxCapacity: config.controlInboxCapacity,
    schemaVersion,
    memoryEnabled: config.memory.enabled,
    memoryWorkspaceScopeId: config.memory.enabled ? config.memory.workspaceScopeId : undefined,
    memoryBackend: config.memory.enabled ? config.memory.backend : undefined,
    memoryColdBackend: config.memory.enabled ? config.memory.coldBackend : undefined,
    learningEnabled: config.memory.enabled && config.learning.enabledByDefault,
    learningAutoExecutionEnabled: config.memory.enabled && config.learning.enabledByDefault && config.learning.autoExecutionEnabledByDefault,
    learningRequiresMemory: true,
    learningActiveExecutionRequiresApproval: true,
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
