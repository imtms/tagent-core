import { createRequestId } from "./id";
import { ConsoleDecode } from "@tagent/core-client";
import type { OperatorInboxItem, TaskRun as AbiTaskRun } from "@tagent/abi";
import { createAdminApi } from "./admin-api";
import { downloadArtifact, request, withCoreAbi } from "./api-transport";
import type { EventConsumerCursor, GateProfile, Session, SessionInboxItem, TaskRun, TranscriptItem } from "./api-types";
import { createGoalApi } from "./goal-api";
import { createSkillApi } from "./skill-api";
export { authenticatedCoreRequest, downloadArtifact } from "./api-transport";
export { subscribe } from "./api-transport";
export type * from "./api-types";
export type { SkillRevision, SkillSummary } from "./skill-api";
export type { WorkspaceGoal, WorkspaceGoalSummary, WorkspaceGoalDefinition, WorkspaceGoalRoadmap, WorkspaceGoalRoadmapItem, WorkspaceGoalDecision, WorkspaceGoalTaskRunStart } from "./goal-api";

const webOrigin = { surface: "web" as const, gatewayActorId: "local-web", sourceId: "web-console" };

async function decodeEventConsumerClaim(payload: unknown): Promise<EventConsumerCursor> {
  const cursor = await withCoreAbi((abi) =>
    abi.decodeAbi(abi.EventConsumerCursorSchema, (payload as { cursor?: unknown })?.cursor));
  return {
    runId: cursor.taskRunId,
    consumerId: cursor.consumerId,
    generation: cursor.generation,
    ackedSeq: cursor.acknowledgedSequence,
    claimedAt: Date.parse(cursor.claimedAt),
    updatedAt: Date.parse(cursor.updatedAt),
  };
}

function sessionView(value: {
  id: string; title: string; modelId: string; reasoningEffort: Session["reasoningEffort"];
  createdAt: string; updatedAt: string; latestTaskRunStatus: string | null; latestTaskRunPhase: string | null;
}): Session {
  return {
    id: value.id, title: value.title, modelId: value.modelId, reasoningEffort: value.reasoningEffort,
    createdAt: Date.parse(value.createdAt), updatedAt: Date.parse(value.updatedAt),
    latestRunStatus: value.latestTaskRunStatus, latestRunPhase: value.latestTaskRunPhase,
  };
}

function taskRunView(value: AbiTaskRun): TaskRun {
  const userInputRequests = value.pendingInteractions.userInputs.map((item) => ({
    id: item.id, runId: item.taskRunId, attempt: item.attempt, prompt: item.prompt, fields: item.fields,
    status: item.status, response: item.response, requestedAt: Date.parse(item.requestedAt),
    submittedAt: item.submittedAt === null ? null : Date.parse(item.submittedAt),
  }));
  const supervision = value.supervision as TaskRun["supervision"];
  return {
    id: value.id, sessionId: value.sessionId, requestId: value.submissionId, status: value.status, phase: value.phase,
    goal: value.goal, modelId: value.modelId, reasoningEffort: value.reasoningEffort,
    contract: value.contract ? {
      ...value.contract,
      sourceInboxIds: value.contract.sourceSubmissionIds,
      parentRunId: value.contract.parentTaskRunId,
      workspaceGoal: value.contract.workspaceGoal ? { ...value.contract.workspaceGoal, attachedAt: Date.parse(value.contract.workspaceGoal.attachedAt) } : null,
    } as TaskRun["contract"] : null,
    gateRequired: true, blockedReason: value.blockedReason, lastEventSeq: value.lastEventSequence,
    attempt: value.attempt, resumedAt: value.resumedAt === null ? null : Date.parse(value.resumedAt),
    createdAt: Date.parse(value.createdAt), updatedAt: Date.parse(value.updatedAt), completedAt: value.completedAt === null ? null : Date.parse(value.completedAt),
    usage: value.usage, transcriptCount: value.transcriptCount,
    checkpoint: value.checkpoint ? {
      runId: value.checkpoint.taskRunId, attempt: value.checkpoint.attempt, active: value.checkpoint.active,
      assistantPartial: value.checkpoint.assistantPartial,
      currentTool: value.checkpoint.currentTool ? {
        toolCallId: value.checkpoint.currentTool.toolCallId, toolName: value.checkpoint.currentTool.toolName,
        ...(value.checkpoint.currentTool.startedAt === undefined ? {} : { startedAt: Date.parse(value.checkpoint.currentTool.startedAt) }),
        ...(value.checkpoint.currentTool.lastActivityAt === undefined ? {} : { lastActivityAt: Date.parse(value.checkpoint.currentTool.lastActivityAt) }),
      } : null,
      lastEventSeq: value.checkpoint.lastEventSequence, lastTranscriptSeq: value.checkpoint.lastTranscriptSequence,
      updatedAt: Date.parse(value.checkpoint.updatedAt),
    } : null,
    continuations: value.continuations.map((item) => ({
      ...item, runId: value.id, notBefore: Date.parse(item.notBefore), createdAt: Date.parse(item.createdAt),
      startedAt: item.startedAt === null ? null : Date.parse(item.startedAt), completedAt: item.completedAt === null ? null : Date.parse(item.completedAt),
      leaseOwner: "", leaseUntil: null, heartbeatAt: null,
    })),
    plan: value.plan, checks: value.checks.map((item) => ({
      ...item, observedAt: item.observedAt === null ? null : Date.parse(item.observedAt),
    })),
    artifacts: value.artifacts.map(({ id, title, kind, uri }) => ({ id, title, kind, uri })),
    completionGate: value.completionGate,
    supervision: {
      latestDecision: supervision.latestDecision ?? null,
      latestGates: supervision.latestGates ?? [],
      progress: supervision.progress ?? null,
      approvalRequests: supervision.approvalRequests ?? value.pendingInteractions.approvals.map((item) => ({
        id: item.id, decisionId: item.id, actionType: item.actionType, targetType: item.targetType, targetId: item.targetId,
        reason: item.reason, metadata: {}, status: item.status, requestedAt: Date.parse(item.requestedAt),
        resolvedAt: item.resolvedAt === null ? null : Date.parse(item.resolvedAt), resolvedBy: item.resolvedBy, resolution: item.resolution,
      })),
      latestContextManifest: supervision.latestContextManifest ?? null,
    },
    userInputRequests, pendingUserInput: userInputRequests[0] ?? null,
    launchRetryable: value.launchRetryable, resumable: value.resumable,
  };
}

function decodeCurrentTaskRun(payload: unknown): Promise<AbiTaskRun> {
  return withCoreAbi((abi) => abi.decodeAbi(abi.TaskRunSchema, payload));
}

function loadTaskRun(runId: string): Promise<TaskRun> {
  return request(`/api/v1/task-runs/${encodeURIComponent(runId)}`, undefined, async (payload) =>
    taskRunView(await decodeCurrentTaskRun(payload)));
}

async function sendTaskRunCommand(runId: string, type: string, payload: Record<string, unknown>): Promise<TaskRun> {
  const commandId = createRequestId();
  const receipt = await request(`/api/v1/task-runs/${encodeURIComponent(runId)}/commands`, {
    method: "POST",
    body: JSON.stringify({ commandId, expectedAttemptId: null, type, payload, origin: webOrigin }),
  }, (value) => withCoreAbi((abi) => abi.decodeAbi(abi.CommandResponseSchema.properties.data, value).receipt));
  const resultingRunId = typeof receipt.result?.taskRunId === "string" ? receipt.result.taskRunId : runId;
  return loadTaskRun(resultingRunId);
}

const inboxCollectionRevisions = new Map<string, number>();

function inboxItemView(item: OperatorInboxItem): SessionInboxItem {
  return {
    id: item.id, sessionId: item.sessionId, content: item.content, status: item.status, decision: item.decision,
    runId: item.runId, position: item.position, createdAt: Date.parse(item.createdAt), updatedAt: Date.parse(item.updatedAt),
    analysis: {
      summary: item.summary, intent: item.intent, targetRunId: item.targetRunId, priority: item.priority,
      urgency: item.urgency, relation: item.relation, acceptanceCriteria: item.acceptanceCriteria,
      confidence: item.confidence, reason: item.reason,
    },
  };
}

function inboxMutationHeaders(sessionId: string, includeRevision = true): Headers {
  const headers = new Headers({ "Idempotency-Key": createRequestId() });
  if (includeRevision) headers.set("If-Match", `"r${inboxCollectionRevisions.get(sessionId) ?? 1}"`);
  return headers;
}

async function listInbox(sessionId: string): Promise<SessionInboxItem[]> {
  return request(`/api/v1/operator/sessions/${encodeURIComponent(sessionId)}/inbox?limit=200`, undefined, (payload) => withCoreAbi((abi) => {
    const data = abi.decodeAbi(abi.OperatorInboxListResponseSchema.properties.data, payload);
    inboxCollectionRevisions.set(sessionId, data.collectionRevision);
    return data.items.filter((item) => item.status === "queued").map(inboxItemView);
  }));
}

async function mutateInbox(
  sessionId: string,
  suffix: string,
  method: "PUT" | "PATCH" | "POST" | "DELETE",
  body?: Record<string, unknown>,
): Promise<SessionInboxItem[]> {
  return request(`/api/v1/operator/sessions/${encodeURIComponent(sessionId)}/inbox${suffix}`, {
    method, headers: inboxMutationHeaders(sessionId), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, (payload) => withCoreAbi((abi) => {
    const schema = suffix.includes("/order") || suffix.includes("/merge") || method === "DELETE"
      ? abi.OperatorInboxMutationResponseSchema.properties.data
      : abi.OperatorInboxItemResponseSchema.properties.data;
    const data = abi.decodeAbi(schema, payload);
    inboxCollectionRevisions.set(sessionId, data.collectionRevision);
    const items = "items" in data ? data.items : [data.item];
    return items.filter((item) => item.status === "queued").map(inboxItemView);
  }));
}

async function runInboxOperation(sessionId: string, path: string): Promise<TaskRun> {
  const operation = await request(path, { method: "POST", headers: inboxMutationHeaders(sessionId, false) }, (payload) =>
    withCoreAbi((abi) => abi.decodeAbi(abi.ProfileOperationResponseSchema.properties.data, payload).operation));
  if (operation.status !== "succeeded" || typeof operation.result?.taskRunId !== "string") {
    throw new Error(String(operation.error?.code ?? `Inbox operation ${operation.status}`));
  }
  return loadTaskRun(operation.result.taskRunId);
}

async function updateSessionSettings(
  sessionId: string,
  settings: Partial<Pick<Session, "title" | "modelId" | "reasoningEffort">>,
): Promise<Session> {
  const path = `/api/v1/operator/sessions/${encodeURIComponent(sessionId)}/settings`;
  const current = await request(path, undefined, (payload) =>
    withCoreAbi((abi) => abi.decodeAbi(abi.OperatorSessionSettingsResponseSchema.properties.data, payload).settings));
  const headers = new Headers({ "Idempotency-Key": createRequestId(), "If-Match": `"r${current.revision}"` });
  await request(path, { method: "PATCH", headers, body: JSON.stringify(settings) }, (payload) =>
    withCoreAbi((abi) => abi.decodeAbi(abi.OperatorSessionSettingsResponseSchema.properties.data, payload).settings));
  return request(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, undefined, (payload) =>
    withCoreAbi((abi) => sessionView(abi.decodeAbi(abi.SessionSchema, payload))));
}

export interface TranscriptViewPage {
  items: TranscriptItem[];
  pageInfo: { nextCursor: number | null; hasMore: boolean; limit: number };
}

async function transcriptViewPage(runId: string, after = 0, limit = 200): Promise<TranscriptViewPage> {
  return request(`/api/v1/task-runs/${encodeURIComponent(runId)}/transcript?limit=${limit}&after=${after}`, undefined, (payload) => withCoreAbi((abi) => {
    const data = abi.decodeAbi(abi.TranscriptResponseSchema.properties.data, payload);
    return {
      items: data.items.map((item) => ({
        ...item, seq: item.sequence, index: item.partIndex, createdAt: Date.parse(item.occurredAt),
      })),
      pageInfo: data.pageInfo,
    };
  }));
}

export async function drainTranscriptView(runId: string, through: number, after = 0, limit = 200) {
  if (!Number.isSafeInteger(through) || through < 0 || !Number.isSafeInteger(after) || after < 0) {
    throw new Error("Transcript cursors must be non-negative safe integers");
  }
  if (through <= after) return { items: [] as TranscriptItem[], after };
  const items: TranscriptItem[] = [];
  let cursor = after;
  while (cursor < through) {
    const page = await transcriptViewPage(runId, cursor, limit);
    items.push(...page.items);
    if (!page.pageInfo.hasMore) {
      cursor = through;
      break;
    }
    const nextCursor = page.pageInfo.nextCursor;
    if (nextCursor === null || nextCursor <= cursor) throw new Error("Transcript pagination did not advance");
    cursor = nextCursor;
  }
  return { items, after: cursor };
}

export const api = {
  ...createAdminApi(request),
  sessions: () => request("/api/v1/operator/sessions?limit=200", undefined, (payload) => withCoreAbi((abi) =>
    abi.decodeAbi(abi.OperatorSessionListResponseSchema.properties.data, payload).items.map((item) => sessionView({
      ...item, latestTaskRunStatus: item.latestTaskRunStatus, latestTaskRunPhase: item.latestTaskRunPhase,
    })))),
  createSession: (title = "New workspace", requestId = createRequestId()) => request("/api/v1/sessions", {
    method: "POST", headers: { "Idempotency-Key": requestId }, body: JSON.stringify({ title, origin: webOrigin }),
  }, (payload) => withCoreAbi((abi) => sessionView(abi.decodeAbi(abi.SessionSchema, payload)))),
  renameSession: (sessionId: string, title: string) => updateSessionSettings(sessionId, { title }),
  updateSession: updateSessionSettings,
  messages: (sessionId: string, limit = 80, beforeId?: number) => request(`/api/v1/console/sessions/${sessionId}/messages?limit=${limit}${beforeId ? `&beforeId=${beforeId}` : ""}`, undefined, ConsoleDecode.messages),
  runs: (sessionId: string, limit = 50) => request(`/api/v1/operator/sessions/${encodeURIComponent(sessionId)}/task-runs?limit=${limit}`, undefined, (payload) => withCoreAbi((abi) =>
    abi.decodeAbi(abi.OperatorSessionTaskRunListResponseSchema.properties.data, payload).items.map((item) => ({
      id: item.id, goal: item.goalSummary, status: item.status, phase: item.phase, attempt: item.attempt,
      createdAt: Date.parse(item.createdAt), updatedAt: Date.parse(item.updatedAt),
    })))),
  run: loadTaskRun,
  contextManifests: (runId: string, limit = 20) => request(`/api/v1/console/task-runs/${runId}/context-manifests?limit=${limit}`, undefined, ConsoleDecode.contextManifests),
  transcriptView: transcriptViewPage,
  artifactContent: (runId: string, artifactId: string) => request(`/api/v1/task-runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}/content`, undefined, (payload) => withCoreAbi((abi) => {
    const artifact = abi.decodeAbi(abi.ArtifactContentResponseSchema.properties.data, payload).artifact;
    return { id: artifact.id, title: artifact.title, kind: artifact.kind, uri: artifact.uri, content: artifact.content, format: artifact.format, bytes: artifact.bytes, source: artifact.source };
  })),
  downloadArtifact: (runId: string, artifactId: string, filename: string) => downloadArtifact(runId, artifactId, filename),
  send: async (sessionId: string, content: string, gateProfile: GateProfile) => {
    const idempotencyKey = createRequestId();
    const receipt = await request(`/api/v1/sessions/${encodeURIComponent(sessionId)}/submissions`, {
      method: "POST", headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ content, gateProfile, origin: webOrigin }),
    }, (payload) => withCoreAbi((abi) => abi.decodeAbi(abi.SubmissionResponseSchema.properties.data, payload).receipt));
    return { run: receipt.taskRunId ? await loadTaskRun(receipt.taskRunId) : null };
  },
  inbox: listInbox,
  updateInbox: (sessionId: string, itemId: string, content: string) => mutateInbox(sessionId, `/${encodeURIComponent(itemId)}`, "PATCH", { content }),
  reorderInbox: (sessionId: string, itemIds: string[]) => mutateInbox(sessionId, "/order", "PUT", { itemIds }),
  startInbox: async (sessionId: string, itemId: string) => ({ status: "started" as const, run: await runInboxOperation(sessionId, `/api/v1/operator/sessions/${encodeURIComponent(sessionId)}/inbox/${encodeURIComponent(itemId)}/start`) }),
  ...createGoalApi(request),
  ...createSkillApi(request),
  deleteInbox: (sessionId: string, itemId: string) => mutateInbox(sessionId, `/${encodeURIComponent(itemId)}`, "DELETE"),
  decideInbox: (sessionId: string, itemId: string, decision: "pending" | "defer") => mutateInbox(sessionId, `/${encodeURIComponent(itemId)}/decision`, "POST", { decision }),
  mergeInbox: (sessionId: string, itemId: string, targetId: string) => mutateInbox(sessionId, `/${encodeURIComponent(itemId)}/merge`, "POST", { targetId }),
  cancel: (runId: string) => sendTaskRunCommand(runId, "task_run.cancel", { reason: "Stopped from the Web Console" }),
  resume: (runId: string) => sendTaskRunCommand(runId, "task_run.resume", { reason: "Resumed from the Web Console" }),
  submitUserInput: (runId: string, requestId: string, response: Record<string, string>) => sendTaskRunCommand(runId, "task_run.submit_user_input", { requestId, response }),
  resolveRunApproval: (runId: string, approvalRequestId: string, decision: "approved" | "rejected") => sendTaskRunCommand(runId, "task_run.resolve_approval", { approvalRequestId, decision, resolution: `${decision} from the Web Console` }),
  requestParallelStart: (sessionId: string, itemId: string) => request(`/api/v1/console/sessions/${sessionId}/inbox/${itemId}/parallel-start-request`, { method: "POST", body: JSON.stringify({ actor: "session_governor", reason: "Start this queued related task before the parent TaskRun completes" }) }, ConsoleDecode.autonomyApproval),
  retryLaunch: async (runId: string) => ({ status: "started" as const, run: await runInboxOperation((await loadTaskRun(runId)).sessionId, `/api/v1/operator/task-runs/${encodeURIComponent(runId)}/retry-launch`) }),
  claimConsumer: (runId: string, consumerId: string) => request(`/api/v1/task-runs/${runId}/event-consumers/${encodeURIComponent(consumerId)}/claim`, { method: "POST" }, decodeEventConsumerClaim),
  ackConsumer: (runId: string, consumerId: string, generation: number, seq: number) => request(`/api/v1/task-runs/${runId}/event-consumers/${encodeURIComponent(consumerId)}/ack`, { method: "POST", body: JSON.stringify({ generation, sequence: seq }) }, ConsoleDecode.jsonObject),
};
