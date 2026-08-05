import type {
  JsonObject,
  ConsoleArtifactContent,
  ConsoleAutonomyApproval,
  ConsoleCaptureJob,
  ConsoleContextManifest,
  ConsoleCoreMemorySnapshot,
  ConsoleEventConsumerCursor,
  ConsoleLearningCenterData,
  ConsoleLearningFeatureState,
  ConsoleMemoryExport,
  ConsoleMemoryStatusResult,
  ConsoleMessage,
  ConsoleRecallResult,
  ConsoleReindexJob,
  ConsoleRunEvent,
  ConsoleRuntimeStatus,
  ConsoleSession,
  ConsoleSessionInboxItem,
  ConsoleTaskRun,
  ConsoleTranscriptItem,
  ConsoleWorkflowDefinition,
} from "@tagent/abi";
import { loadCoreAbi, type CoreAbi } from "./abi-loader.js";

function arrayPayload(payload: unknown): unknown[] {
  if (!Array.isArray(payload)) throw new TypeError("Expected an array response");
  return payload;
}

function objectPayload(abi: CoreAbi, payload: unknown): JsonObject {
  return abi.decodeAbi(abi.JsonObjectSchema, payload);
}

async function runtimeStatus(payload: unknown): Promise<ConsoleRuntimeStatus | null> {
  if (payload === null) return null;
  const abi = await loadCoreAbi();
  return abi.decodeAbi(abi.ConsoleRuntimeStatusSchema, payload);
}

async function learningFeatureState(payload: unknown): Promise<ConsoleLearningFeatureState> {
  const abi = await loadCoreAbi();
  return abi.decodeAbi(abi.ConsoleLearningFeatureStateSchema, payload);
}

async function session(payload: unknown): Promise<ConsoleSession> {
  const abi = await loadCoreAbi();
  return abi.decodeAbi(abi.ConsoleSessionSchema, payload);
}

async function sessions(payload: unknown): Promise<ConsoleSession[]> {
  const abi = await loadCoreAbi();
  return arrayPayload(payload).map((item) => abi.decodeAbi(abi.ConsoleSessionSchema, item));
}

async function messages(payload: unknown): Promise<ConsoleMessage[]> {
  const abi = await loadCoreAbi();
  return arrayPayload(payload).map((item) => abi.decodeAbi(abi.ConsoleMessageSchema, item));
}

async function taskRun(payload: unknown): Promise<ConsoleTaskRun> {
  const abi = await loadCoreAbi();
  return abi.decodeAbi(abi.ConsoleTaskRunSchema, payload);
}

async function taskRunOrNull(payload: unknown): Promise<ConsoleTaskRun | null> {
  if (payload === null) return null;
  return taskRun(payload);
}

async function taskRuns(payload: unknown): Promise<ConsoleTaskRun[]> {
  const abi = await loadCoreAbi();
  return arrayPayload(payload).map((item) => abi.decodeAbi(abi.ConsoleTaskRunSchema, item));
}

async function contextManifests(payload: unknown): Promise<ConsoleContextManifest[]> {
  const abi = await loadCoreAbi();
  return arrayPayload(payload).map((item) => abi.decodeAbi(abi.ConsoleContextManifestSchema, item));
}

async function transcriptItems(payload: unknown): Promise<ConsoleTranscriptItem[]> {
  const abi = await loadCoreAbi();
  return arrayPayload(payload).map((item) => abi.decodeAbi(abi.ConsoleTranscriptItemSchema, item));
}

async function artifactContent(payload: unknown): Promise<ConsoleArtifactContent> {
  const abi = await loadCoreAbi();
  return abi.decodeAbi(abi.ConsoleArtifactContentSchema, payload);
}

async function submissionResult(payload: unknown): Promise<{ item: ConsoleSessionInboxItem; run: ConsoleTaskRun | null }> {
  const abi = await loadCoreAbi();
  const value = objectPayload(abi, payload);
  return {
    item: abi.decodeAbi(abi.ConsoleSessionInboxItemSchema, value.item),
    run: value.run === null ? null : abi.decodeAbi(abi.ConsoleTaskRunSchema, value.run),
  };
}

async function inboxItem(payload: unknown): Promise<ConsoleSessionInboxItem> {
  const abi = await loadCoreAbi();
  return abi.decodeAbi(abi.ConsoleSessionInboxItemSchema, payload);
}

async function inboxItems(payload: unknown): Promise<ConsoleSessionInboxItem[]> {
  const abi = await loadCoreAbi();
  return arrayPayload(payload).map((item) => abi.decodeAbi(abi.ConsoleSessionInboxItemSchema, item));
}

async function startedRun(payload: unknown): Promise<{ status: "started"; item: ConsoleSessionInboxItem; run: ConsoleTaskRun }> {
  const abi = await loadCoreAbi();
  const value = objectPayload(abi, payload);
  if (value.status !== "started") throw new TypeError("Expected a started response");
  return {
    status: "started",
    item: abi.decodeAbi(abi.ConsoleSessionInboxItemSchema, value.item),
    run: abi.decodeAbi(abi.ConsoleTaskRunSchema, value.run),
  };
}

async function ok(payload: unknown): Promise<{ ok: true }> {
  const abi = await loadCoreAbi();
  const value = objectPayload(abi, payload);
  if (value.ok !== true) throw new TypeError("Expected an ok response");
  return { ok: true };
}

async function jsonObject(payload: unknown): Promise<JsonObject> {
  const abi = await loadCoreAbi();
  return objectPayload(abi, payload);
}

async function autonomyApproval(payload: unknown): Promise<ConsoleAutonomyApproval> {
  const abi = await loadCoreAbi();
  return abi.decodeAbi(abi.ConsoleAutonomyApprovalSchema, payload);
}

async function eventConsumerCursor(payload: unknown): Promise<ConsoleEventConsumerCursor> {
  const abi = await loadCoreAbi();
  return abi.decodeAbi(abi.ConsoleEventConsumerCursorSchema, payload);
}

async function captureJobs(payload: unknown): Promise<ConsoleCaptureJob[]> {
  const abi = await loadCoreAbi();
  return arrayPayload(payload).map((item) => abi.decodeAbi(abi.ConsoleCaptureJobSchema, item));
}

async function memoryStatus(payload: unknown): Promise<ConsoleMemoryStatusResult> {
  const abi = await loadCoreAbi();
  return abi.decodeAbi(abi.ConsoleMemoryStatusResultSchema, payload);
}

async function memoryExport(payload: unknown): Promise<ConsoleMemoryExport> {
  const abi = await loadCoreAbi();
  return abi.decodeAbi(abi.ConsoleMemoryExportSchema, payload);
}

async function recallResult(payload: unknown): Promise<ConsoleRecallResult> {
  const abi = await loadCoreAbi();
  return abi.decodeAbi(abi.ConsoleRecallResultSchema, payload);
}

async function captureJobId(payload: unknown): Promise<{ jobId: string }> {
  const abi = await loadCoreAbi();
  const value = objectPayload(abi, payload);
  if (typeof value.jobId !== "string" || value.jobId.length === 0) throw new TypeError("Expected a jobId response");
  return { jobId: value.jobId };
}

async function reindexJob(payload: unknown): Promise<ConsoleReindexJob> {
  const abi = await loadCoreAbi();
  return abi.decodeAbi(abi.ConsoleReindexJobSchema, payload);
}

async function reindexJobs(payload: unknown): Promise<ConsoleReindexJob[]> {
  const abi = await loadCoreAbi();
  return arrayPayload(payload).map((item) => abi.decodeAbi(abi.ConsoleReindexJobSchema, item));
}

async function coreMemorySnapshot(payload: unknown): Promise<ConsoleCoreMemorySnapshot | null> {
  if (payload === null) return null;
  const abi = await loadCoreAbi();
  return abi.decodeAbi(abi.ConsoleCoreMemorySnapshotSchema, payload);
}

async function forgetResult(payload: unknown): Promise<{ records: number; topics: number; objects: number }> {
  const abi = await loadCoreAbi();
  const value = objectPayload(abi, payload);
  if (typeof value.records !== "number" || typeof value.topics !== "number" || typeof value.objects !== "number") {
    throw new TypeError("Expected memory forget counts");
  }
  return { records: value.records, topics: value.topics, objects: value.objects };
}

async function learningCenter(payload: unknown): Promise<ConsoleLearningCenterData> {
  const abi = await loadCoreAbi();
  return abi.decodeAbi(abi.ConsoleLearningCenterDataSchema, payload);
}

async function workflowDefinition(payload: unknown): Promise<ConsoleWorkflowDefinition> {
  const abi = await loadCoreAbi();
  return abi.decodeAbi(abi.ConsoleWorkflowDefinitionSchema, payload);
}

async function runEvent(payload: unknown): Promise<ConsoleRunEvent> {
  const abi = await loadCoreAbi();
  return abi.decodeAbi(abi.ConsoleRunEventSchema, payload);
}

export const ConsoleDecode = {
  artifactContent,
  autonomyApproval,
  captureJobId,
  captureJobs,
  contextManifests,
  coreMemorySnapshot,
  eventConsumerCursor,
  forgetResult,
  inboxItem,
  inboxItems,
  jsonObject,
  learningCenter,
  learningFeatureState,
  memoryExport,
  memoryStatus,
  messages,
  ok,
  recallResult,
  reindexJob,
  reindexJobs,
  runEvent,
  runtimeStatus,
  session,
  sessions,
  startedRun,
  submissionResult,
  taskRun,
  taskRunOrNull,
  taskRuns,
  transcriptItems,
  workflowDefinition,
} as const;
