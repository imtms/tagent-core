import { createRequestId } from "./id";
import { createCoreTransport, ConsoleDecode } from "@tagent/core-client";
import {
  decodeAbi,
  EventConsumerCursorSchema,
  SuccessEnvelopeSchema,
  TaskRunEventSchema,
  type ConsoleV1,
} from "@tagent/abi";

export type Session = ConsoleV1.ConsoleSession;
export type SessionInputAnalysis = ConsoleV1.ConsoleSessionInputAnalysis;
export type TaskRunContract = ConsoleV1.ConsoleTaskRunContract;
export type SessionInboxItem = ConsoleV1.ConsoleSessionInboxItem;
export type Message = ConsoleV1.ConsoleMessage;
export type ContextManifestItem = ConsoleV1.ConsoleContextManifestItem;
export type ContextManifest = ConsoleV1.ConsoleContextManifest;
export type PlanItem = ConsoleV1.ConsolePlanItem;
export type RunCheck = ConsoleV1.ConsoleRunCheck;
export type Artifact = ConsoleV1.ConsoleArtifact;
export type ArtifactContent = ConsoleV1.ConsoleArtifactContent;
export type UserInputField = ConsoleV1.ConsoleUserInputField;
export type UserInputRequest = ConsoleV1.ConsoleUserInputRequest;
export type TaskRun = ConsoleV1.ConsoleTaskRun;
export type EventConsumerCursor = ConsoleV1.ConsoleEventConsumerCursor;
export type RunEvent = ConsoleV1.ConsoleRunEvent;
export type TranscriptItem = ConsoleV1.ConsoleTranscriptItem;
export type LearningFeatureState = ConsoleV1.ConsoleLearningFeatureState;
export type RuntimeStatus = ConsoleV1.ConsoleRuntimeStatus;
export type WorkflowRevision = ConsoleV1.ConsoleWorkflowRevision;
export type WorkflowDefinition = ConsoleV1.ConsoleWorkflowDefinition;
export type AutonomyApproval = ConsoleV1.ConsoleAutonomyApproval;
export type LearningCenterData = ConsoleV1.ConsoleLearningCenterData;
export type MemoryKind = ConsoleV1.ConsoleMemoryKind;
export type MemoryTier = ConsoleV1.ConsoleMemoryTier;
export type MemoryStatus = ConsoleV1.ConsoleMemoryStatus;
export type MemoryScope = ConsoleV1.ConsoleMemoryScope;
export type MemorySourceRef = ConsoleV1.ConsoleMemorySourceRef;
export type MemoryRecord = ConsoleV1.ConsoleMemoryRecord;
export type PreferenceRecord = ConsoleV1.ConsolePreferenceRecord;
export type WarmMemory = ConsoleV1.ConsoleWarmMemory;
export type TopicDescriptor = ConsoleV1.ConsoleTopicDescriptor;
export type ColdTopic = ConsoleV1.ConsoleColdTopic;
export type CaptureJob = ConsoleV1.ConsoleCaptureJob;
export type MemoryStatusResult = ConsoleV1.ConsoleMemoryStatusResult;
export type ReindexJob = ConsoleV1.ConsoleReindexJob;
export type CoreMemorySnapshot = ConsoleV1.ConsoleCoreMemorySnapshot;
export type MemoryExport = ConsoleV1.ConsoleMemoryExport;
export type MemoryCard = ConsoleV1.ConsoleMemoryCard;
export type RecallResult = ConsoleV1.ConsoleRecallResult;

const coreClient = createCoreTransport();
const configuredCoreOrigin = configuredOrigin(import.meta.env.VITE_TAGENT_CORE_ORIGIN);
const oidcTokenStorageKey = "tagent.oidc.access_token";

function configuredOrigin(value: string | undefined): string {
  const candidate = value?.trim();
  if (!candidate) return "";
  const parsed = new URL(candidate);
  if (!["http:", "https:"].includes(parsed.protocol)
    || parsed.origin === "null"
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash) {
    throw new Error("VITE_TAGENT_CORE_ORIGIN must be an http(s) origin without credentials, path, query, or fragment");
  }
  return parsed.origin;
}

function oidcAccessToken(): string | undefined {
  try {
    return globalThis.sessionStorage?.getItem(oidcTokenStorageKey)?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface AuthenticatedCoreRequestOptions {
  origin?: string;
  accessToken?: string;
}

export function authenticatedCoreRequest(
  pathname: string,
  init: RequestInit = {},
  options: AuthenticatedCoreRequestOptions = {},
): { url: string; init: RequestInit } {
  const origin = options.origin === undefined ? configuredCoreOrigin : configuredOrigin(options.origin);
  const accessToken = options.accessToken === undefined ? oidcAccessToken() : options.accessToken.trim();
  const headers = new Headers(init.headers);
  if (accessToken && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${accessToken}`);
  return {
    url: origin ? new URL(pathname, `${origin}/`).toString() : pathname,
    init: { ...init, credentials: "omit", headers },
  };
}

async function authenticatedCoreFetch(
  pathname: string,
  init: RequestInit = {},
  options: AuthenticatedCoreRequestOptions = {},
): Promise<Response> {
  const prepared = authenticatedCoreRequest(pathname, init, options);
  const response = await fetch(prepared.url, prepared.init);
  if (!response.ok) throw new Error(`Core request failed with HTTP ${response.status}`);
  return response;
}

async function request<T>(url: string, init: RequestInit | undefined, decode: (payload: unknown) => T | Promise<T>): Promise<T> {
  const needsRunControlRequestId = init?.method === "POST" && init.body == null && /^\/api\/v1\/console\/task-runs\/[^/]+\/(cancel|resume|retry-launch)$/.test(url);
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const prepared = authenticatedCoreRequest(url, { ...init, headers });
  return coreClient.request(prepared.url, {
    ...prepared.init,
    decode: (payload) => decode(decodeAbi(SuccessEnvelopeSchema, payload).data),
    ...(needsRunControlRequestId ? { idempotent: true, json: {}, requestId: createRequestId() } : {}),
  });
}

export async function downloadArtifact(
  runId: string,
  artifactId: string,
  filename: string,
  options: AuthenticatedCoreRequestOptions = {},
): Promise<void> {
  const response = await authenticatedCoreFetch(
    `/api/v1/console/task-runs/${runId}/artifacts/${encodeURIComponent(artifactId)}/download`,
    {},
    options,
  );
  const objectUrl = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  try {
    anchor.href = objectUrl;
    anchor.download = filename.trim() || "artifact";
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }
}

async function decodeEventConsumerClaim(payload: unknown): Promise<EventConsumerCursor> {
  const cursor = decodeAbi(EventConsumerCursorSchema, (payload as { cursor?: unknown })?.cursor);
  return {
    runId: cursor.taskRunId,
    consumerId: cursor.consumerId,
    generation: cursor.generation,
    ackedSeq: cursor.acknowledgedSequence,
    terminalAckedSeq: cursor.terminalAcknowledgedSequence,
    claimedAt: Date.parse(cursor.claimedAt),
    updatedAt: Date.parse(cursor.updatedAt),
  };
}

export const api = {
  status: () => request("/api/v1/admin/config/status", undefined, ConsoleDecode.runtimeStatus),
  learningSettings: () => request("/api/v1/admin/console/learning/settings", undefined, ConsoleDecode.learningFeatureState),
  updateLearningSettings: (input:Partial<Pick<LearningFeatureState,"memoryEnabled"|"learningEnabled"|"autoExecutionEnabled">>)=>request("/api/v1/admin/console/learning/settings",{method:"PATCH",body:JSON.stringify({...input,reason:"web_ui"})},ConsoleDecode.learningFeatureState),
  sessions: () => request("/api/v1/console/sessions", undefined, ConsoleDecode.sessions),
  createSession: (title = "New workspace") => request("/api/v1/console/sessions", { method: "POST", body: JSON.stringify({ title }) }, ConsoleDecode.session),
  renameSession: (sessionId: string, title: string) => request(`/api/v1/console/sessions/${sessionId}`, { method: "PATCH", body: JSON.stringify({ title }) }, ConsoleDecode.session),
  messages: (sessionId: string, limit = 80, beforeId?: number) => request(`/api/v1/console/sessions/${sessionId}/messages?limit=${limit}${beforeId ? `&beforeId=${beforeId}` : ""}`, undefined, ConsoleDecode.messages),
  runs: (sessionId: string, limit = 50) => request(`/api/v1/console/sessions/${sessionId}/task-runs?limit=${limit}`, undefined, ConsoleDecode.taskRuns),
  latestRun: (sessionId: string) => request(`/api/v1/console/sessions/${sessionId}/task-run`, undefined, ConsoleDecode.taskRunOrNull),
  run: (runId: string) => request(`/api/v1/console/task-runs/${runId}`, undefined, ConsoleDecode.taskRun),
  contextManifests: (runId: string, limit = 20) => request(`/api/v1/console/task-runs/${runId}/context-manifests?limit=${limit}`, undefined, ConsoleDecode.contextManifests),
  transcriptView: (runId: string) => request(`/api/v1/console/task-runs/${runId}/transcript`, undefined, ConsoleDecode.transcriptItems),
  artifactContent: (runId: string, artifactId: string) => request(`/api/v1/console/task-runs/${runId}/artifacts/${encodeURIComponent(artifactId)}/content`, undefined, ConsoleDecode.artifactContent),
  downloadArtifact: (runId: string, artifactId: string, filename: string) => downloadArtifact(runId, artifactId, filename),
  send: (sessionId: string, content: string) => request(`/api/v1/console/sessions/${sessionId}/messages`, { method: "POST", body: JSON.stringify({ content, requestId: createRequestId() }) }, ConsoleDecode.submissionResult),
  inbox: (sessionId: string) => request(`/api/v1/console/sessions/${sessionId}/inbox`, undefined, ConsoleDecode.inboxItems),
  updateInbox: (sessionId: string, itemId: string, content: string) => request(`/api/v1/console/sessions/${sessionId}/inbox/${itemId}`, { method: "PATCH", body: JSON.stringify({ content }) }, ConsoleDecode.inboxItem),
  reorderInbox: (sessionId: string, itemIds: string[]) => request(`/api/v1/console/sessions/${sessionId}/inbox/order`, { method: "PUT", body: JSON.stringify({ itemIds }) }, ConsoleDecode.inboxItems),
  startInbox: (sessionId: string, itemId: string) => request(`/api/v1/console/sessions/${sessionId}/inbox/${itemId}/start`, { method: "POST" }, ConsoleDecode.startedRun),
  deleteInbox: (sessionId: string, itemId: string) => request(`/api/v1/console/sessions/${sessionId}/inbox/${itemId}`, { method: "DELETE" }, ConsoleDecode.ok),
  decideInbox: (sessionId: string, itemId: string, decision: "pending" | "defer") => request(`/api/v1/console/sessions/${sessionId}/inbox/${itemId}/decision`, { method: "POST", body: JSON.stringify({ decision }) }, ConsoleDecode.ok),
  mergeInbox: (sessionId: string, itemId: string, targetId: string) => request(`/api/v1/console/sessions/${sessionId}/inbox/${itemId}/merge`, { method: "POST", body: JSON.stringify({ targetId }) }, ConsoleDecode.ok),
  cancel: (runId: string) => request(`/api/v1/console/task-runs/${runId}/cancel`, { method: "POST" }, ConsoleDecode.jsonObject),
  steer: (runId: string, content: string) => request(`/api/v1/console/task-runs/${runId}/steer`, { method: "POST", body: JSON.stringify({ content, requestId: createRequestId() }) }, ConsoleDecode.jsonObject),
  resume: (runId: string) => request(`/api/v1/console/task-runs/${runId}/resume`, { method: "POST" }, ConsoleDecode.taskRun),
  submitUserInput: (requestId: string, response: Record<string, string>) => request(`/api/v1/console/user-input-requests/${requestId}/submit`, { method: "POST", body: JSON.stringify({ response }) }, ConsoleDecode.taskRun),
  approveRunApproval: (approvalId: string) => request(`/api/v1/console/approval-requests/${approvalId}/approve`, { method: "POST" }, ConsoleDecode.taskRun),
  rejectRunApproval: (approvalId: string) => request(`/api/v1/console/approval-requests/${approvalId}/reject`, { method: "POST" }, ConsoleDecode.taskRun),
  requestParallelStart: (sessionId: string, itemId: string) => request(`/api/v1/console/sessions/${sessionId}/inbox/${itemId}/parallel-start-request`, { method: "POST", body: JSON.stringify({ actor: "session_governor", reason: "Start this queued related task before the parent TaskRun completes" }) }, ConsoleDecode.autonomyApproval),
  retryLaunch: (runId: string) => request(`/api/v1/console/task-runs/${runId}/retry-launch`, { method: "POST" }, ConsoleDecode.startedRun),
  claimConsumer: (runId: string, consumerId: string) => request(`/api/v1/task-runs/${runId}/event-consumers/${encodeURIComponent(consumerId)}/claim`, { method: "POST" }, decodeEventConsumerClaim),
  ackConsumer: (runId: string, consumerId: string, generation: number, seq: number) => request(`/api/v1/task-runs/${runId}/event-consumers/${encodeURIComponent(consumerId)}/ack`, { method: "POST", body: JSON.stringify({ generation, sequence: seq }) }, ConsoleDecode.jsonObject),
  memoryJobs: (scope: MemoryScope) => request("/api/v1/admin/memory/jobs", { method: "POST", body: JSON.stringify({ scopes: [scope], limit: 100 }) }, ConsoleDecode.captureJobs),
  memoryStatus: (scope: MemoryScope) => request("/api/v1/admin/memory/status", { method: "POST", body: JSON.stringify({ scopes: [scope] }) }, ConsoleDecode.memoryStatus),
  memoryExport: (scope: MemoryScope, limit = 200) => request("/api/v1/admin/memory/export", { method: "POST", body: JSON.stringify({ scope, limit }) }, ConsoleDecode.memoryExport),
  memoryRecall: (scope: MemoryScope, cue: string, kinds?: MemoryKind[]) => request("/api/v1/admin/memory/recall-console", { method: "POST", body: JSON.stringify({ scopes: [scope], cue, kinds, maxCards: 12, maxColdTopics: 4 }) }, ConsoleDecode.recallResult),
  memoryCapture: (scope: MemoryScope, content: string) => request("/api/v1/admin/memory/capture", { method: "POST", body: JSON.stringify({ scope, content, idempotencyKey: createRequestId() }) }, ConsoleDecode.captureJobId),
  memoryReindex: (scope:MemoryScope)=>request("/api/v1/admin/memory/reindex",{method:"POST",body:JSON.stringify({scope})},ConsoleDecode.reindexJob),
  memoryReindexJobs: (scope:MemoryScope)=>request("/api/v1/admin/memory/reindex/jobs",{method:"POST",body:JSON.stringify({scopes:[scope],limit:20})},ConsoleDecode.reindexJobs),
  memoryGovern: (scope:MemoryScope,id:string,action:"approve"|"reject"|"correct"|"resolve",options:Record<string,unknown>={})=>request("/api/v1/admin/memory/govern",{method:"POST",body:JSON.stringify({scope,id,action,...options})},ConsoleDecode.jsonObject),
  memoryFeedback: (scope:MemoryScope,recordId:string,signal:string)=>request("/api/v1/admin/memory/feedback",{method:"POST",body:JSON.stringify({scope,recordId,signal})},ConsoleDecode.jsonObject),
  memoryCoreSnapshot: (scope:MemoryScope,options:Record<string,unknown>={})=>request("/api/v1/admin/memory/core-snapshot",{method:"POST",body:JSON.stringify({scope,...options})},ConsoleDecode.coreMemorySnapshot),
  memoryRestore: (scope:MemoryScope,ids?:string[],topicIds?:string[])=>request("/api/v1/admin/memory/restore",{method:"POST",body:JSON.stringify({scope,ids,topicIds})},ConsoleDecode.jsonObject),
  memoryForget: (scope: MemoryScope, ids?: string[], topicIds?: string[]) => request("/api/v1/admin/memory/forget", { method: "POST", body: JSON.stringify({ scope, ids, topicIds }) }, ConsoleDecode.forgetResult),
  learningCenter: (sessionId:string)=>request(`/api/v1/admin/sessions/${sessionId}/learning-center`,undefined,ConsoleDecode.learningCenter),
  requestWorkflowActivation: (id:string,revisionId?:string)=>request(`/api/v1/admin/workflows/${id}/activation-request`,{method:"POST",body:JSON.stringify({revisionId,actor:"learning_center",reason:"Activate this workflow for future runs"})},ConsoleDecode.autonomyApproval),
  activateWorkflow: (id:string,approvalId:string,revisionId?:string)=>request(`/api/v1/admin/workflows/${id}/activate`,{method:"POST",body:JSON.stringify({approvalId,revisionId})},ConsoleDecode.workflowDefinition),
  suspendWorkflow: (id:string)=>request(`/api/v1/admin/workflows/${id}/suspend`,{method:"POST",body:JSON.stringify({reason:"learning_center"})},ConsoleDecode.workflowDefinition),
  forgetWorkflow: (id:string)=>request(`/api/v1/admin/workflows/${id}`,{method:"DELETE",body:JSON.stringify({reason:"learning_center",gracePeriodMs:2_592_000_000})},ConsoleDecode.ok),
  restoreWorkflow: (id:string)=>request(`/api/v1/admin/workflows/${id}/restore`,{method:"POST",body:"{}"},ConsoleDecode.workflowDefinition),
  approveWorkflowProposal: (id:string)=>request(`/api/v1/admin/workflow-proposals/${id}/approve`,{method:"POST",body:JSON.stringify({actor:"learning_center"})},ConsoleDecode.jsonObject),
  rejectWorkflowProposal: (id:string)=>request(`/api/v1/admin/workflow-proposals/${id}/reject`,{method:"POST",body:JSON.stringify({actor:"learning_center"})},ConsoleDecode.jsonObject),
  requestWorkflowProposalApplication: (id:string)=>request(`/api/v1/admin/workflow-proposals/${id}/application-request`,{method:"POST",body:JSON.stringify({actor:"learning_center",reason:"Apply approved proposal as a candidate revision"})},ConsoleDecode.autonomyApproval),
  applyWorkflowProposal: (id:string,approvalId:string)=>request(`/api/v1/admin/workflow-proposals/${id}/apply`,{method:"POST",body:JSON.stringify({actor:"learning_center",approvalId})},ConsoleDecode.jsonObject),
  approveAutonomy: (id:string)=>request(`/api/v1/admin/autonomy-approvals/${id}/approve`,{method:"POST",body:JSON.stringify({actor:"learning_center_human",reason:"Reviewed evidence, impact, diff and rollback"})},ConsoleDecode.autonomyApproval),
  rejectAutonomy: (id:string)=>request(`/api/v1/admin/autonomy-approvals/${id}/reject`,{method:"POST",body:JSON.stringify({actor:"learning_center_human",reason:"Rejected after human review"})},ConsoleDecode.autonomyApproval),
  revokeAutonomy: (id:string)=>request(`/api/v1/admin/autonomy-approvals/${id}/revoke`,{method:"POST",body:JSON.stringify({actor:"learning_center_human",reason:"Approval withdrawn before execution"})},ConsoleDecode.autonomyApproval),
  executeAutonomy: (id:string)=>request(`/api/v1/admin/autonomy-approvals/${id}/execute`,{method:"POST",body:JSON.stringify({actor:"learning_center_human"})},ConsoleDecode.jsonObject),
  setLearningPolicy: (runId:string,policy:"allow"|"metadata_only"|"deny")=>request(`/api/v1/admin/task-runs/${runId}/learning-policy`,{method:"POST",body:JSON.stringify({policy,reason:"learning_center"})},ConsoleDecode.jsonObject),
  setWorkflowApplication: (bindingId:string,status:"exposed"|"adopted"|"partial"|"rejected")=>request(`/api/v1/admin/workflow-bindings/${bindingId}/application`,{method:"POST",body:JSON.stringify({status})},ConsoleDecode.jsonObject),
  runWorkflowDistiller: ()=>request("/api/v1/admin/workflow-distillation/run",{method:"POST",body:JSON.stringify({owner:"learning_center"})},ConsoleDecode.jsonObject),
  retryWorkflowDistillation: (id:string)=>request(`/api/v1/admin/workflow-distillation/${id}/retry`,{method:"POST",body:"{}"},ConsoleDecode.jsonObject),
};

function sseData(frame: string): string | undefined {
  const lines = frame.split(/\r?\n/);
  const values = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  return values.length ? values.join("\n") : undefined;
}

async function consumeEventStream(
  response: Response,
  onEvent: (event: RunEvent) => void | Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  if (!response.body) throw new Error("Core event stream has no response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.match(/\r?\n\r?\n/);
      while (boundary?.index !== undefined) {
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = sseData(frame);
        if (data !== undefined) {
          const event = decodeAbi(TaskRunEventSchema, JSON.parse(data) as unknown);
          await onEvent({
            runId: event.aggregateId,
            seq: event.sequence,
            type: event.type.startsWith("task_run.") ? `run.${event.type.slice(9)}` : event.type,
            data: event.payload,
            createdAt: Date.parse(event.occurredAt),
          });
        }
        boundary = buffer.match(/\r?\n\r?\n/);
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (!signal.aborted) throw new Error("Core event stream closed unexpectedly");
}

export function subscribe(
  runId: string,
  consumerId: string,
  generation: number,
  after: number,
  onEvent: (event: RunEvent) => void | Promise<void>,
  onError: (error: Error) => void,
  options: AuthenticatedCoreRequestOptions = {},
) {
  const controller = new AbortController();
  const pathname = `/api/v1/task-runs/${runId}/events?consumerId=${encodeURIComponent(consumerId)}&generation=${generation}&after=${after}`;
  void authenticatedCoreFetch(pathname, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  }, options).then((response) => consumeEventStream(response, onEvent, controller.signal)).catch((cause) => {
    if (controller.signal.aborted) return;
    onError(cause instanceof Error ? cause : new Error(String(cause)));
  });
  return () => controller.abort();
}
