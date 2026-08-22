import { SERVICE_SCOPES, type ServiceCredential, type ServiceScope } from "@tagent/http-fastify/auth";
import { credentialReference, type CredentialReference, type RuntimeModelSpec } from "@tagent/execution/ports";

export interface ModelConfig {
  provider: string;
  modelId: string;
  api: "openai-completions" | "anthropic-messages";
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
}

export interface AppConfig {
  host: string;
  port: number;
  database: string;
  workspace: string;
  projectRuleFiles: string[];
  toolArtifactMaxBytes: number;
  runtime: "in-process";
  apiCredentialReference: CredentialReference;
  apiCredentialConfigured: boolean;
  providerTimeoutMs: number;
  providerMaxRetries: number;
  routerTimeoutMs: number;
  supervisorTimeoutMs: number;
  runTimeoutMs: number;
  runHardTimeoutMs: number;
  maxContinuations: number;
  maxContextTurns: number;
  historicalToolResultChars: number;
  historicalTaskRunReceiptChars: number;
  controlInboxCapacity: number;
  serviceCredentials: ServiceCredential[];
  model: ModelConfig;
  fallbackModels: ModelConfig[];
  routerModel: ModelConfig;
  supervisorModel: ModelConfig;
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
      embeddingCredentialReference?: CredentialReference;
      embeddingModel?: string;
      embeddingDimensions?: number;
      embeddingBatchSize: number;
      embeddingExtraBody?: Record<string,unknown>;
      extractorProvider: "rule" | "hybrid";
      extractorBaseUrl?: string;
      extractorCredentialReference?: CredentialReference;
      extractorModel?: string;
      recallThresholds: { lexicalMin: number; topicMin: number; vectorMin: number; vectorTopicMin: number; finalMin: number };
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
function referencedCredential(env: NodeJS.ProcessEnv, name: string, fallback?: string) {
  const raw = env[name]?.trim();
  const referenced = raw ? /^\$\{([A-Z_][A-Z0-9_]*)\}$/.exec(raw)?.[1] : undefined;
  const selected = referenced ?? (raw ? name : fallback);
  return selected ? credentialReference(selected) : undefined;
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
    embeddingCredentialReference: referencedCredential(env, "TAGENT_MEMORY_EMBEDDING_API_KEY"),
    embeddingModel: env.TAGENT_MEMORY_EMBEDDING_MODEL?.trim() || undefined,
    embeddingDimensions: env.TAGENT_MEMORY_EMBEDDING_DIMENSIONS ? positiveInteger(env.TAGENT_MEMORY_EMBEDDING_DIMENSIONS, 1024, "TAGENT_MEMORY_EMBEDDING_DIMENSIONS") : undefined,
    embeddingBatchSize: positiveInteger(env.TAGENT_MEMORY_EMBEDDING_BATCH_SIZE, 64, "TAGENT_MEMORY_EMBEDDING_BATCH_SIZE"),
    embeddingExtraBody: parseJsonObject(env.TAGENT_MEMORY_EMBEDDING_EXTRA_BODY, "TAGENT_MEMORY_EMBEDDING_EXTRA_BODY"),
    extractorProvider: memoryExtractorProvider(env),
    extractorBaseUrl: referencedEnvValue(env, "TAGENT_MEMORY_EXTRACTOR_BASE_URL") || env.TAGENT_API_BASE?.trim() || undefined,
    extractorCredentialReference: referencedCredential(env, "TAGENT_MEMORY_EXTRACTOR_API_KEY", "OPENAI_API_KEY"),
    extractorModel: referencedEnvValue(env, "TAGENT_MEMORY_EXTRACTOR_MODEL") || env.TAGENT_MODEL?.trim() || undefined,
    recallThresholds: {
      lexicalMin: probability(env.TAGENT_MEMORY_LEXICAL_MIN, .04, "TAGENT_MEMORY_LEXICAL_MIN"),
      topicMin: probability(env.TAGENT_MEMORY_TOPIC_MIN, .06, "TAGENT_MEMORY_TOPIC_MIN"),
      vectorMin: probability(env.TAGENT_MEMORY_VECTOR_MIN, .62, "TAGENT_MEMORY_VECTOR_MIN"),
      vectorTopicMin: probability(env.TAGENT_MEMORY_VECTOR_TOPIC_MIN, .68, "TAGENT_MEMORY_VECTOR_TOPIC_MIN"),
      finalMin: probability(env.TAGENT_MEMORY_FINAL_MIN, .18, "TAGENT_MEMORY_FINAL_MIN"),
    },
  };
}

function parseServiceCredentials(value?: string): ServiceCredential[] {
  if (!value?.trim()) return [];
  const allowed = new Set<ServiceScope>(SERVICE_SCOPES);
  const resourceTypes = new Set(["user", "workspace", "project", "session"]);
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error("TAGENT_SERVICE_CREDENTIALS must be a JSON array");
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`TAGENT_SERVICE_CREDENTIALS[${index}] must be an object`);
    const token = "token" in item && typeof item.token === "string" ? item.token.trim() : "";
    const scopes = "scopes" in item && Array.isArray(item.scopes) ? item.scopes : [];
    if (token.length < 24) throw new Error(`TAGENT_SERVICE_CREDENTIALS[${index}].token must be at least 24 characters`);
    if (!scopes.length || scopes.some((scope: unknown) => typeof scope !== "string" || !allowed.has(scope as ServiceScope))) throw new Error(`TAGENT_SERVICE_CREDENTIALS[${index}].scopes contains an invalid scope`);
    if (!("principal" in item) || item.principal === undefined) {
      return { token, scopes: [...new Set(scopes as ServiceScope[])] };
    }
    const principal = item.principal;
    if (!principal || typeof principal !== "object" || Array.isArray(principal)) {
      throw new Error(`TAGENT_SERVICE_CREDENTIALS[${index}].principal must be an object`);
    }
    const subjectId = "subjectId" in principal && typeof principal.subjectId === "string"
      ? principal.subjectId.trim()
      : "";
    const resourceScopes: unknown[] | null = "resourceScopes" in principal && Array.isArray(principal.resourceScopes)
      ? principal.resourceScopes
      : null;
    if (!subjectId || subjectId.length > 256) {
      throw new Error(`TAGENT_SERVICE_CREDENTIALS[${index}].principal.subjectId must contain 1 to 256 characters`);
    }
    if (!resourceScopes || resourceScopes.length > 64) {
      throw new Error(`TAGENT_SERVICE_CREDENTIALS[${index}].principal.resourceScopes must be an array with at most 64 entries`);
    }
    const normalizedResourceScopes = resourceScopes.map((scope: unknown, scopeIndex: number) => {
      if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
        throw new Error(`TAGENT_SERVICE_CREDENTIALS[${index}].principal.resourceScopes[${scopeIndex}] must be an object`);
      }
      const type = "type" in scope && typeof scope.type === "string" ? scope.type : "";
      const id = "id" in scope && typeof scope.id === "string" ? scope.id.trim() : "";
      if (!resourceTypes.has(type) || !id || id.length > 256) {
        throw new Error(`TAGENT_SERVICE_CREDENTIALS[${index}].principal.resourceScopes[${scopeIndex}] is invalid`);
      }
      return { type: type as "user" | "workspace" | "project" | "session", id };
    });
    return {
      token,
      scopes: [...new Set(scopes as ServiceScope[])],
      principal: { subjectId, resourceScopes: normalizedResourceScopes },
    };
  });
}

function modelApi(value: string | undefined, name: string): ModelConfig["api"] {
  const api = value?.trim() || "openai-completions";
  if (api !== "openai-completions" && api !== "anthropic-messages") throw new Error(`${name} must be openai-completions or anthropic-messages`);
  return api;
}

function modelIds(value: string | undefined, fallback: string) {
  const ids = (value ?? fallback).split(",").map((item) => item.trim()).filter(Boolean);
  if (!ids.length) throw new Error("TAGENT_MODEL must contain at least one model id");
  return [...new Set(ids)];
}

function normalizeBaseUrl(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("TAGENT_API_BASE must use http or https");
  return url.toString().replace(/\/$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const runtime = env.TAGENT_RUNTIME ?? "in-process";
  if (runtime !== "in-process") throw new Error(`Unsupported TAGENT_RUNTIME: ${runtime}`);
  const host = env.HOST?.trim() || "127.0.0.1";
  const serviceCredentials = parseServiceCredentials(env.TAGENT_SERVICE_CREDENTIALS);
  if (serviceCredentials.length === 0 && !new Set(["127.0.0.1", "::1", "localhost"]).has(host.toLowerCase())) {
    throw new Error("TAGENT_SERVICE_CREDENTIALS is required when HOST is not loopback");
  }
  return {
    host,
    port: positiveInteger(env.PORT, 3100, "PORT"),
    database: env.TAGENT_DB ?? "./data/tagent.db",
    workspace: env.TAGENT_WORKSPACE ?? process.cwd(),
    projectRuleFiles: (env.TAGENT_PROJECT_RULE_FILES ?? "AGENTS.md").split(",").map((value) => value.trim()).filter(Boolean),
    toolArtifactMaxBytes: positiveInteger(env.TAGENT_TOOL_ARTIFACT_MAX_BYTES, 16 * 1024 * 1024, "TAGENT_TOOL_ARTIFACT_MAX_BYTES"),
    runtime,
    apiCredentialReference: credentialReference(env.TAGENT_API_KEY_ENV?.trim() || "OPENAI_API_KEY"),
    apiCredentialConfigured: Boolean(env[env.TAGENT_API_KEY_ENV?.trim() || "OPENAI_API_KEY"]?.trim()),
    providerTimeoutMs: positiveInteger(env.TAGENT_PROVIDER_TIMEOUT_MS, 15_000, "TAGENT_PROVIDER_TIMEOUT_MS"),
    providerMaxRetries: nonNegativeInteger(env.TAGENT_PROVIDER_MAX_RETRIES, 1, "TAGENT_PROVIDER_MAX_RETRIES"),
    routerTimeoutMs: positiveInteger(env.TAGENT_ROUTER_TIMEOUT_MS, 5_000, "TAGENT_ROUTER_TIMEOUT_MS"),
    supervisorTimeoutMs: positiveInteger(env.TAGENT_SUPERVISOR_TIMEOUT_MS, 5_000, "TAGENT_SUPERVISOR_TIMEOUT_MS"),
    runTimeoutMs: positiveInteger(env.TAGENT_RUN_TIMEOUT_MS, 120_000, "TAGENT_RUN_TIMEOUT_MS"),
    runHardTimeoutMs: positiveInteger(env.TAGENT_RUN_HARD_TIMEOUT_MS, 86_400_000, "TAGENT_RUN_HARD_TIMEOUT_MS"),
    maxContinuations: nonNegativeInteger(env.TAGENT_MAX_CONTINUATIONS, 4, "TAGENT_MAX_CONTINUATIONS"),
    maxContextTurns: positiveInteger(env.TAGENT_MAX_CONTEXT_TURNS, 20, "TAGENT_MAX_CONTEXT_TURNS"),
    historicalToolResultChars: positiveInteger(env.TAGENT_HISTORICAL_TOOL_RESULT_CHARS, 4_000, "TAGENT_HISTORICAL_TOOL_RESULT_CHARS"),
    historicalTaskRunReceiptChars: positiveInteger(env.TAGENT_HISTORICAL_TASK_RUN_RECEIPT_CHARS, 600, "TAGENT_HISTORICAL_TASK_RUN_RECEIPT_CHARS"),
    controlInboxCapacity: positiveInteger(env.TAGENT_CONTROL_INBOX_CAPACITY, 32, "TAGENT_CONTROL_INBOX_CAPACITY"),
    serviceCredentials,
    memory: loadMemoryConfig(env),
    ...(() => {
      const ids = modelIds(env.TAGENT_MODEL, "gpt-5.6-sol");
      const base = {
        provider: env.TAGENT_PROVIDER ?? "openai-compatible",
        api: modelApi(env.TAGENT_API, "TAGENT_API"),
        baseUrl: normalizeBaseUrl(env.TAGENT_API_BASE ?? "https://one.tms.im/v1"),
        contextWindow: positiveInteger(env.TAGENT_CONTEXT_WINDOW, 200_000, "TAGENT_CONTEXT_WINDOW"),
        maxTokens: positiveInteger(env.TAGENT_MAX_TOKENS, 32_768, "TAGENT_MAX_TOKENS"),
        reasoning: env.TAGENT_REASONING !== "false",
      };
      return { model: { ...base, modelId: ids[0] }, fallbackModels: ids.slice(1).map((modelId) => ({ ...base, modelId })) };
    })(),
    routerModel: {
      provider: env.TAGENT_ROUTER_PROVIDER?.trim() || env.TAGENT_PROVIDER || "openai-compatible",
      modelId: env.TAGENT_ROUTER_MODEL ?? "gpt-5.6-luna",
      api: modelApi(env.TAGENT_ROUTER_API, "TAGENT_ROUTER_API"),
      baseUrl: normalizeBaseUrl(env.TAGENT_ROUTER_API_BASE?.trim() || env.TAGENT_API_BASE || "https://one.tms.im/v1"),
      contextWindow: positiveInteger(env.TAGENT_ROUTER_CONTEXT_WINDOW, 64_000, "TAGENT_ROUTER_CONTEXT_WINDOW"),
      maxTokens: positiveInteger(env.TAGENT_ROUTER_MAX_TOKENS, 2_048, "TAGENT_ROUTER_MAX_TOKENS"),
      reasoning: env.TAGENT_ROUTER_REASONING === "true",
    },
    supervisorModel: {
      provider: env.TAGENT_SUPERVISOR_PROVIDER?.trim() || env.TAGENT_PROVIDER || "openai-compatible",
      modelId: env.TAGENT_SUPERVISOR_MODEL ?? "gpt-5.6-luna",
      api: modelApi(env.TAGENT_SUPERVISOR_API, "TAGENT_SUPERVISOR_API"),
      baseUrl: normalizeBaseUrl(env.TAGENT_SUPERVISOR_API_BASE?.trim() || env.TAGENT_API_BASE || "https://one.tms.im/v1"),
      contextWindow: positiveInteger(env.TAGENT_SUPERVISOR_CONTEXT_WINDOW, 64_000, "TAGENT_SUPERVISOR_CONTEXT_WINDOW"),
      maxTokens: positiveInteger(env.TAGENT_SUPERVISOR_MAX_TOKENS, 1_024, "TAGENT_SUPERVISOR_MAX_TOKENS"),
      reasoning: env.TAGENT_SUPERVISOR_REASONING === "true",
    },
  };
}

export interface PublicRuntimeConfig {
  releaseVersion: string;
  runtime: AppConfig["runtime"];
  provider: string;
  api: ModelConfig["api"];
  baseUrl: string;
  modelId: string;
  fallbackModelIds: string[];
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
  historicalToolResultChars: number;
  historicalTaskRunReceiptChars: number;
  controlInboxCapacity: number;
  schemaVersion?: number;
  memoryEnabled: boolean;
  memoryRuntimeEnabled?: boolean;
  memoryWorkspaceScopeId?: string;
  memoryBackend?: "memory" | "postgres";
  memoryColdBackend?: "local" | "s3";
}

export function publicRuntimeConfig(config: AppConfig, schemaVersion?: number): PublicRuntimeConfig {
  return {
    releaseVersion: "0.8.25",
    runtime: config.runtime,
    provider: config.model.provider,
    api: config.model.api,
    baseUrl: config.model.baseUrl,
    modelId: config.model.modelId,
    fallbackModelIds: config.fallbackModels.map((model) => model.modelId),
    credentialConfigured: config.apiCredentialConfigured,
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
    historicalToolResultChars: config.historicalToolResultChars,
    historicalTaskRunReceiptChars: config.historicalTaskRunReceiptChars,
    controlInboxCapacity: config.controlInboxCapacity,
    schemaVersion,
    memoryEnabled: config.memory.enabled,
    memoryWorkspaceScopeId: config.memory.enabled ? config.memory.workspaceScopeId : undefined,
    memoryBackend: config.memory.enabled ? config.memory.backend : undefined,
    memoryColdBackend: config.memory.enabled ? config.memory.coldBackend : undefined,
  };
}

export function createModel(config: ModelConfig): RuntimeModelSpec {
  const model: RuntimeModelSpec = {
    id: config.modelId,
    api: config.api,
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: config.reasoning,
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
  };
  return model;
}
