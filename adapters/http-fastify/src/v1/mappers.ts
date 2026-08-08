import type {
  ArtifactContent,
  CommandReceipt,
  EventConsumerCursor,
  Session,
  SubmissionReceipt,
  TaskRun as V1TaskRun,
  TaskRunArtifact,
  TaskRunCommand,
  TaskRunEvent,
  TranscriptItem,
} from "@tagent/abi";
import { createTaskRunEventId } from "@tagent/abi";
import type { Session as DomainSession, SessionInboxItem } from "@tagent/admission/domain";
import type {
  EventConsumerCursor as DomainEventConsumerCursor,
  RunEvent,
  TaskRun,
  TaskRunCommandReceipt as DomainTaskRunCommandReceipt,
} from "@tagent/execution/domain";

function iso(timestamp: number): string;
function iso(timestamp: number | null): string | null;
function iso(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

export function mapSession(session: DomainSession): Session {
  return {
    id: session.id,
    title: session.title,
    modelId: session.modelId,
    reasoningEffort: session.reasoningEffort,
    createdAt: iso(session.createdAt),
    updatedAt: iso(session.updatedAt),
    latestTaskRunStatus: session.latestRunStatus,
    latestTaskRunPhase: session.latestRunPhase,
  };
}

export function mapSubmissionReceipt(item: SessionInboxItem): SubmissionReceipt {
  const status = item.status === "queued" ? "queued"
    : item.status === "started" ? "started"
    : item.status === "failed" || item.status === "deleted" ? "failed"
    : "accepted";
  return {
    idempotencyKey: item.requestId,
    sessionId: item.sessionId,
    submissionId: item.id,
    status,
    taskRunId: item.runId,
    error: item.error || null,
    createdAt: iso(item.createdAt),
    updatedAt: iso(item.updatedAt),
  };
}

function mapArtifact(artifact: TaskRun["artifacts"][number]): TaskRunArtifact {
  return {
    id: artifact.id,
    taskRunId: artifact.runId,
    kind: artifact.kind,
    title: artifact.title,
    uri: artifact.uri,
    createdAt: iso(artifact.createdAt),
  };
}

export function mapTaskRun(run: TaskRun): V1TaskRun {
  return {
    id: run.id,
    sessionId: run.sessionId,
    submissionId: run.contract?.sourceInboxIds[0] ?? run.requestId,
    status: run.status,
    phase: run.phase,
    goal: run.goal,
    modelId: run.modelId,
    reasoningEffort: run.reasoningEffort,
    contract: run.contract ? {
      sourceInput: run.contract.sourceInput,
      summary: run.contract.summary,
      objectives: run.contract.objectives,
      acceptanceCriteria: run.contract.acceptanceCriteria,
      scope: run.contract.scope,
      nonGoals: run.contract.nonGoals,
      sourceSubmissionIds: run.contract.sourceInboxIds,
      parentTaskRunId: run.contract.parentRunId,
      relation: run.contract.relation,
      intent: run.contract.intent,
      decisionReason: run.contract.decisionReason,
      routerVersion: run.contract.routerVersion,
      workspaceGoal: run.contract.workspaceGoal ? {
        ...run.contract.workspaceGoal,
        attachedAt: iso(run.contract.workspaceGoal.attachedAt),
      } : null,
    } : null,
    blockedReason: run.blockedReason,
    lastEventSequence: run.lastEventSeq,
    attempt: run.attempt,
    currentAttempt: {
      id: `attempt:${run.id}:${run.attempt}`,
      ordinal: run.attempt,
      status: run.status,
      active: run.status === "running",
    },
    createdAt: iso(run.createdAt),
    updatedAt: iso(run.updatedAt),
    completedAt: iso(run.completedAt),
    resumedAt: iso(run.resumedAt),
    usage: run.usage,
    transcriptCount: run.transcriptCount,
    checkpoint: run.checkpoint ? {
      taskRunId: run.checkpoint.runId,
      attempt: run.checkpoint.attempt,
      active: run.checkpoint.active,
      assistantPartial: run.checkpoint.assistantPartial,
      currentTool: run.checkpoint.currentTool ? {
        toolCallId: run.checkpoint.currentTool.toolCallId,
        toolName: run.checkpoint.currentTool.toolName,
        ...(run.checkpoint.currentTool.startedAt === undefined ? {} : { startedAt: iso(run.checkpoint.currentTool.startedAt) }),
        ...(run.checkpoint.currentTool.lastActivityAt === undefined ? {} : { lastActivityAt: iso(run.checkpoint.currentTool.lastActivityAt) }),
      } : null,
      lastEventSequence: run.checkpoint.lastEventSeq,
      lastTranscriptSequence: run.checkpoint.lastTranscriptSeq,
      updatedAt: iso(run.checkpoint.updatedAt),
    } : null,
    continuations: run.continuations.map((item) => ({
      id: item.id,
      ordinal: item.ordinal,
      status: item.status,
      reason: item.reason,
      error: item.error,
      createdAt: iso(item.createdAt),
      startedAt: iso(item.startedAt),
      completedAt: iso(item.completedAt),
    })),
    plan: run.plan,
    checks: run.checks.map((check) => ({
      ...check,
      sourceOperationId: check.sourceOperationId ?? null,
      observedAt: iso(check.observedAt ?? null),
    })),
    artifacts: run.artifacts.map(mapArtifact),
    completionGate: run.completionGate,
    supervision: run.supervision,
    pendingInteractions: {
      approvals: run.supervision.approvalRequests.filter((item) => item.status === "pending").map((item) => ({
        id: item.id,
        taskRunId: run.id,
        attempt: item.attempt ?? run.attempt,
        actionType: item.actionType,
        targetType: item.targetType,
        targetId: item.targetId,
        reason: item.reason,
        status: item.status,
        requestedAt: iso(item.requestedAt),
        resolvedAt: iso(item.resolvedAt),
        resolvedBy: item.resolvedBy,
        resolution: item.resolution,
      })),
      userInputs: run.userInputRequests.filter((item) => item.status === "pending").map((item) => ({
        id: item.id,
        taskRunId: run.id,
        attempt: item.attempt,
        prompt: item.prompt,
        fields: item.fields,
        status: item.status,
        response: item.response,
        requestedAt: iso(item.requestedAt),
        submittedAt: iso(item.submittedAt),
      })),
    },
    launchRetryable: run.launchRetryable,
    resumable: run.resumable,
  };
}

export function mapEventConsumerCursor(cursor: DomainEventConsumerCursor): EventConsumerCursor {
  return {
    taskRunId: cursor.runId,
    consumerId: cursor.consumerId,
    generation: cursor.generation,
    acknowledgedSequence: cursor.ackedSeq,
    settledAcknowledgedSequence: cursor.settledAckedSeq,
    finalAcknowledgedSequence: cursor.finalAckedSeq,
    terminalAcknowledgedSequence: cursor.settledAckedSeq,
    claimedAt: iso(cursor.claimedAt),
    updatedAt: iso(cursor.updatedAt),
  };
}

export function mapTaskRunEvent(event: RunEvent): TaskRunEvent {
  const projected = publicEventProjection(event);
  return {
    specVersion: "1.0",
    eventId: createTaskRunEventId(event.runId, event.seq),
    aggregateType: "task_run",
    aggregateId: event.runId,
    sequence: event.seq,
    type: projected.type,
    occurredAt: iso(event.createdAt),
    correlationId: publicIdentifier(event.data.requestId ?? event.data.commandId ?? event.data.submissionId),
    causationId: publicIdentifier(event.data.decisionId ?? event.data.approvalId ?? event.data.controlId),
    payload: projected.payload,
  };
}

function publicIdentifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

function publicText(value: unknown, maxLength = 16_384): string {
  if (typeof value !== "string") return "";
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n[truncated]`;
}

function publicInteger(value: unknown, fallback = 1): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function publicToolPayload(data: Record<string, unknown>) {
  return {
    toolCallId: publicIdentifier(data.toolCallId) ?? "unknown",
    toolName: publicText(data.toolName, 256) || "tool",
  };
}

function publicUserInputFields(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 64).flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return [];
    const field = candidate as Record<string, unknown>;
    const key = publicText(field.key, 256);
    if (!key) return [];
    return [{
      key,
      label: publicText(field.label, 512),
      description: publicText(field.description, 2_000),
      inputType: field.inputType === "textarea" ? "textarea" as const : "text" as const,
      required: Boolean(field.required),
      placeholder: publicText(field.placeholder, 1_000),
    }];
  });
}

function publicEventProjection(event: RunEvent): { type: string; payload: Record<string, unknown> } {
  const data = event.data;
  switch (event.type) {
    case "run.started": return { type: "task_run.started", payload: { goal: publicText(data.goal, 4_000), attempt: publicInteger(data.attempt) } };
    case "run.waiting_for_input": return { type: "task_run.waiting_input", payload: { requestId: publicIdentifier(data.requestId) ?? "unknown", prompt: publicText(data.prompt, 8_000), fields: publicUserInputFields(data.fields) } };
    case "run.blocked": return { type: "task_run.blocked", payload: { reason: publicText(data.reason ?? data.error, 4_000), ...(typeof data.action === "string" ? { action: publicText(data.action, 256) } : {}) } };
    case "run.resumed": return { type: "task_run.resumed", payload: { attempt: publicInteger(data.attempt), ...(typeof data.mode === "string" ? { mode: publicText(data.mode, 256) } : {}) } };
    case "run.completed": return { type: "task_run.completed", payload: {} };
    case "run.failed": return { type: "task_run.failed", payload: { reason: publicText(data.reason ?? data.error, 4_000), retryable: Boolean(data.retryable) } };
    case "run.cancelled": return { type: "task_run.cancelled", payload: { reason: publicText(data.reason, 4_000) } };
    case "run.interrupted":
    case "restart.interruption": return { type: "task_run.interrupted", payload: { reason: publicText(data.reason, 4_000) } };
    case "message.started": return { type: "message.started", payload: { ordinal: publicInteger(data.ordinal) } };
    case "message.delta": return { type: "message.delta", payload: { delta: publicText(data.delta), ordinal: publicInteger(data.ordinal) } };
    case "message.completed": return { type: "message.completed", payload: { content: publicText(data.content, 65_536), ordinal: publicInteger(data.ordinal) } };
    case "tool.started": return { type: "tool.started", payload: publicToolPayload(data) };
    case "tool.progress": return { type: "tool.progress", payload: publicToolPayload(data) };
    case "tool.completed": return { type: "tool.completed", payload: { ...publicToolPayload(data), isError: Boolean(data.isError) } };
    case "tool.failed": return { type: "tool.failed", payload: { ...publicToolPayload(data), reason: publicText(data.reason ?? data.error, 2_000) } };
    case "provider.failure": return { type: "provider.failure", payload: { kind: publicText(data.kind, 128), retryable: Boolean(data.retryable), ...(typeof data.stopReason === "string" ? { stopReason: publicText(data.stopReason, 128) } : {}) } };
    case "supervisor.approval.requested": return { type: "approval.requested", payload: { approvalRequestId: publicIdentifier(data.approvalId) ?? "unknown", reason: publicText(data.reason, 4_000) } };
    case "supervisor.approval.approved": return { type: "approval.resolved", payload: { approvalRequestId: publicIdentifier(data.approvalId) ?? "unknown", decision: "approved", resolution: publicText(data.resolution, 4_000) } };
    case "supervisor.approval.rejected": return { type: "approval.resolved", payload: { approvalRequestId: publicIdentifier(data.approvalId) ?? "unknown", decision: "rejected", resolution: publicText(data.resolution, 4_000) } };
    case "run.input.submitted": return { type: "user_input.submitted", payload: { userInputRequestId: publicIdentifier(data.requestId) ?? "unknown", fieldKeys: Array.isArray(data.fieldKeys) ? data.fieldKeys.filter((key): key is string => typeof key === "string" && key.length > 0).slice(0, 64) : [] } };
    default: return { type: "diagnostic.internal", payload: { sourceType: publicText(event.type, 128) || "internal" } };
  }
}

type TranscriptViewItem =
  | { seq: number; index?: number; attempt: number; kind: "user" | "assistant"; text: string; createdAt: number }
  | { seq: number; index: number; attempt: number; kind: "thinking"; text: string; redacted: boolean; createdAt: number }
  | { seq: number; index: number; attempt: number; kind: "tool"; toolCallId: string; toolName: string; arguments: unknown; result: string; isError: boolean; status: "pending" | "completed" | "failed"; createdAt: number };

export function mapTranscriptItem(item: TranscriptViewItem): TranscriptItem {
  const base = {
    sequence: item.seq,
    ...(item.index === undefined ? {} : { partIndex: item.index }),
    attempt: item.attempt,
    occurredAt: iso(item.createdAt),
  };
  if (item.kind === "tool") return {
    ...base,
    kind: item.kind,
    toolCallId: item.toolCallId,
    toolName: item.toolName,
    arguments: publicToolArguments(item.toolName, item.arguments),
    result: publicToolResult(item.toolName, item.result),
    isError: item.isError,
    status: item.status,
  };
  if (item.kind === "thinking") return { ...base, kind: item.kind, text: "Model reasoning is hidden in the public transcript.", redacted: true };
  return { ...base, kind: item.kind, text: item.text };
}

export function mapArtifactContent(artifact: TaskRun["artifacts"][number], content: string, format: "markdown" | "text", source: "inline" | "file"): ArtifactContent {
  return { ...mapArtifact(artifact), content, format, bytes: Buffer.byteLength(content), source };
}

export function mapCommandReceipt(receipt: DomainTaskRunCommandReceipt, replayed: boolean): CommandReceipt {
  const error = receipt.error as CommandReceipt["error"];
  return {
    commandId: receipt.commandId,
    taskRunId: receipt.taskRunId,
    type: receipt.commandType as TaskRunCommand["type"],
    status: replayed ? "duplicate" : receipt.state === "failed" ? "rejected" : "accepted",
    state: receipt.state,
    outcome: receipt.state === "succeeded" ? "accepted" : receipt.state === "failed" ? "rejected" : "unknown",
    replayed,
    requestId: receipt.requestId,
    result: receipt.result,
    error,
    createdAt: iso(receipt.createdAt),
    updatedAt: iso(receipt.updatedAt),
  };
}


const SENSITIVE_KEY = /(?:api[_-]?key|token|secret|password|authorization|cookie|credential)/i;

function publicToolArguments(toolName: string, value: unknown): unknown {
  if (toolName === "bash") return { summary: "Bash arguments hidden from the public transcript." };
  return redactPublicValue(value, 0);
}

function redactPublicValue(value: unknown, depth: number): unknown {
  if (depth > 4) return "[nested value omitted]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactPublicValue(item, depth + 1));
  if (!value || typeof value !== "object") return typeof value === "string" && value.length > 2_000 ? `${value.slice(0, 2_000)}\n[truncated]` : value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "[redacted]" : redactPublicValue(item, depth + 1)]));
}

function publicToolResult(toolName: string, result: string): string {
  if (!result) return "";
  if (toolName === "bash") return result.length <= 4_000 ? result : `${result.slice(0, 2_000)}\n[public transcript truncated; inspect the authorized Artifact for full output]\n${result.slice(-2_000)}`;
  return result.length <= 8_000 ? result : `${result.slice(0, 4_000)}\n[public transcript truncated]\n${result.slice(-4_000)}`;
}
