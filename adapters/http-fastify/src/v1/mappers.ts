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
    terminalAcknowledgedSequence: cursor.terminalAckedSeq,
    claimedAt: iso(cursor.claimedAt),
    updatedAt: iso(cursor.updatedAt),
  };
}

export function mapTaskRunEvent(event: RunEvent): TaskRunEvent {
  const type = event.type.startsWith("run.") ? `task_run.${event.type.slice(4)}` : event.type;
  return {
    specVersion: "1.0",
    eventId: createTaskRunEventId(event.runId, event.seq),
    aggregateType: "task_run",
    aggregateId: event.runId,
    sequence: event.seq,
    type,
    occurredAt: iso(event.createdAt),
    correlationId: null,
    causationId: null,
    payload: event.data,
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

interface OperationReceipt {
  status: string;
  error: string;
  createdAt: number;
  updatedAt: number;
}

export function mapCommandReceipt(command: TaskRunCommand, taskRunId: string, requestId: string, operation: OperationReceipt | undefined, duplicate: boolean): CommandReceipt {
  const timestamp = Date.now();
  return {
    commandId: command.commandId,
    taskRunId,
    type: command.type,
    status: duplicate ? "duplicate" : operation?.status === "failed" ? "rejected" : "accepted",
    requestId,
    error: operation?.status === "failed" ? {
      code: "command.execution_failed",
      message: operation.error || "Command execution failed",
      requestId,
      retryable: false,
      details: {},
    } : null,
    createdAt: iso(operation?.createdAt ?? timestamp),
    updatedAt: iso(operation?.updatedAt ?? timestamp),
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
