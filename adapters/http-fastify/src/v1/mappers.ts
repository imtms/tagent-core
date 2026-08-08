import type {
  ArtifactContent,
  CommandReceipt,
  EventConsumerCursor,
  GatewayProvenance,
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
import type { SubmissionAuditReceipt } from "@tagent/admission/ports";
import type {
  EventConsumerCursor as DomainEventConsumerCursor,
  RunEvent,
  TaskRun,
  TaskRunCommandReceipt as DomainTaskRunCommandReceipt,
} from "@tagent/execution/domain";
import { publicEventProjection, publicIdentifier } from "./event-mappers.js";

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

export function mapSubmissionReceipt(item: SessionInboxItem, audit?: SubmissionAuditReceipt): SubmissionReceipt {
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
    audit: audit ? {
      principalId: audit.principalId,
      origin: Object.keys(audit.provenance).length ? audit.provenance as GatewayProvenance : null,
    } : null,
    createdAt: iso(item.createdAt),
    updatedAt: iso(item.updatedAt),
  };
}

export function mapArtifact(
  artifact: Pick<TaskRun["artifacts"][number], "id" | "runId" | "kind" | "title" | "uri" | "createdAt">,
): TaskRunArtifact {
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
    correlationId: publicIdentifier(event.data.requestId ?? event.data.commandId ?? event.data.submissionId
      ?? event.data.inboxItemId ?? event.data.sourceInboxItemId ?? event.data.approvalId),
    causationId: publicIdentifier(event.data.causationId ?? event.data.decisionId ?? event.data.controlId),
    payload: projected.payload,
  };
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
    audit: {
      principalId: receipt.principalId,
      origin: Object.keys(receipt.provenance).length ? receipt.provenance as GatewayProvenance : null,
    },
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
