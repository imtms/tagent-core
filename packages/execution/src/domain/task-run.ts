import type { TaskRunContractSnapshot } from "./task-run-launch.js";
import type {
  ApprovalRequest,
  Artifact,
  CompletionGate,
  GateEvaluation,
  PlanItem,
  ProgressSnapshot,
  RunCheck,
  SupervisorDecision,
} from "@tagent/governance/domain";

export type {
  ApprovalRequest,
  Artifact,
  CompletionGate,
  CriterionCoverage,
  GateEvaluation,
  GateFailure,
  PlanItem,
  ProgressSnapshot,
  RunCheck,
  SupervisorAction,
  SupervisorDecision,
} from "@tagent/governance/domain";

/** Consumer-neutral reference to a conversation identifier owned outside Execution. */
export type ExecutionSessionRef = string;
export type RunId = string;
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type RunStatus = "running" | "waiting_input" | "completed" | "blocked" | "interrupted" | "cancelled" | "failed";
export type RunPhase = "discover" | "plan" | "implement" | "verify" | "review" | "waiting_input" | "done" | "blocked";
export type PlanStatus = PlanItem["status"];
export type CheckStatus = RunCheck["status"];

export const MAX_CONTROL_CONTENT_CHARS = 200_000;

export function assertControlContent(content: string): void {
  if (!content.trim()) throw new Error("Control content is required");
  if (content.length > MAX_CONTROL_CONTENT_CHARS) {
    throw new Error(`Control content cannot exceed ${MAX_CONTROL_CONTENT_CHARS} characters`);
  }
}

export interface RunCheckpoint {
  runId: RunId;
  attempt: number;
  active: boolean;
  assistantPartial: string;
  currentTool: { toolCallId: string; toolName: string; startedAt?: number; lastActivityAt?: number } | null;
  lastEventSeq: number;
  lastTranscriptSeq: number;
  updatedAt: number;
}

export interface EventConsumerCursor {
  runId: RunId;
  consumerId: string;
  generation: number;
  ackedSeq: number;
  settledAckedSeq: number | null;
  finalAckedSeq: number | null;
  claimedAt: number;
  updatedAt: number;
}

export interface ControlInboxItem {
  id: string;
  runId: RunId;
  requestId: string;
  attempt: number;
  kind: "steer" | "follow_up";
  content: string;
  status: "queued" | "delivering" | "delivered" | "rejected" | "superseded" | "outcome_unknown";
  error: string;
  createdAt: number;
  claimedAt: number | null;
  completedAt: number | null;
}

export type TaskRunCommandReceiptState = "started" | "succeeded" | "failed" | "outcome_unknown";
export interface TaskRunCommandReceipt {
  principalId: string;
  taskRunId: RunId;
  commandId: string;
  commandType: string;
  payloadHash: string;
  payload: Record<string, unknown>;
  targetAttemptId: string | null;
  state: TaskRunCommandReceiptState;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  provenance: Record<string, unknown>;
  requestId: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export type TaskRunRelation = "depends_on" | "follow_up" | "parallel" | "derived" | "blocks" | "supersedes";
export interface TaskRunEdge { fromRunId: RunId; toRunId: RunId; relation: TaskRunRelation; reason: string; createdAt: number }
export interface UserInputField { key: string; label: string; description: string; inputType: "text" | "textarea"; required: boolean; placeholder: string }
export interface UserInputRequest { id: string; runId: RunId; attempt: number; prompt: string; fields: UserInputField[]; status: "pending" | "submitted" | "cancelled" | "superseded"; response: Record<string, string>; requestedAt: number; submittedAt: number | null }

export type ContextManifestSource = "session" | "transcript";
export type ContextManifestItemKind = "system_prompt" | "taskrun_contract" | "workspace_goal" | "skill" | "session_message" | "transcript_message" | "core_memory" | "memory_card" | "cold_topic" | "workflow_revision" | "communication_profile" | "project_rule" | "user_prompt";
export interface ContextManifestItem { kind: ContextManifestItemKind; sourceId: string; role?: string; selected: boolean; reason: string; estimatedTokens: number; metadata?: Record<string, unknown> }
export interface ContextManifest { id: string; runId: RunId; attempt: number; source: ContextManifestSource; items: ContextManifestItem[]; stats: Record<string, number | string>; manifestHash: string; createdAt: number }

export interface RunContinuation { id: string; runId: RunId; ordinal: number; status: "queued" | "running" | "completed" | "blocked" | "failed" | "cancelled"; reason: string; error: string; notBefore: number; createdAt: number; startedAt: number | null; completedAt: number | null; leaseOwner: string; leaseUntil: number | null; heartbeatAt: number | null }
type RunEventPayload = Record<string, unknown>;
type MessageStartedEvent = RunEventPayload & { ordinal: number };
type MessageDeltaEvent = RunEventPayload & { delta: string; ordinal: number };
type MessageCompletedEvent = RunEventPayload & { content: string; willRetry: boolean; ordinal: number };
type TranscriptUpdatedEvent = RunEventPayload & { transcriptSeq: number; role: string; ordinal?: number };
type ToolLifecycleEvent = RunEventPayload & {
  toolCallId: string;
  toolName: string;
};
type ToolCompletedEvent = ToolLifecycleEvent & {
  isError: boolean;
  error?: { name: string; code: string; message: string };
};
type ProviderFailureEvent = RunEventPayload & {
  kind: string;
  retryable: boolean;
  summary: string;
  stopReason: string;
  retryAfterMs?: number;
};
type RequestEnvelopePersistedEvent = RunEventPayload & {
  envelopeId: string;
  requestOrdinal: number;
  envelopeHash: string;
  providerPayloadHash: string;
  model: string;
};

/** Authoritative event-name vocabulary. Specific payloads can be tightened without changing the wire ABI. */
export interface RunEventMap {
  "context.compaction.completed": RunEventPayload; "context.compaction.failed": RunEventPayload; "context.compaction.started": RunEventPayload;
  "context.loaded": RunEventPayload; "context.pruned": RunEventPayload; "context.summarization.retry": RunEventPayload;
  "context.summarization.retry.finished": RunEventPayload; "context.summarization.retry.started": RunEventPayload;
  "continuation.exhausted": RunEventPayload; "continuation.lease.lost": RunEventPayload; "continuation.preparation.failed": RunEventPayload;
  "continuation.queued": RunEventPayload; "continuation.recovered": RunEventPayload; "continuation.stalled": RunEventPayload; "continuation.started": RunEventPayload;
  "control.accepted": RunEventPayload; "control.delivered": RunEventPayload; "control.delivering": RunEventPayload;
  "control.duplicate": RunEventPayload; "control.rejected": RunEventPayload;
  "memory.capture.failed": RunEventPayload; "memory.capture.queued": RunEventPayload; "memory.feedback.attribution.failed": RunEventPayload;
  "memory.recall.degraded": RunEventPayload; "message.completed": MessageCompletedEvent; "message.delta": MessageDeltaEvent;
  "message.rejected": RunEventPayload; "message.retrying": RunEventPayload; "message.started": MessageStartedEvent; "message.thinking.delta": MessageDeltaEvent;
  "provider.failure": ProviderFailureEvent; "provider.fallback": RunEventPayload; "provider.retry": RunEventPayload; "provider.retry.completed": RunEventPayload;
  "request.envelope.persisted": RequestEnvelopePersistedEvent; "run.cancelled": RunEventPayload; "run.input.submitted": RunEventPayload;
  "run.interrupted": RunEventPayload; "run.launch.retrying": RunEventPayload; "run.resumed": RunEventPayload; "run.started": RunEventPayload; "run.updated": RunEventPayload;
  "run.blocked": RunEventPayload; "run.completed": RunEventPayload; "run.failed": RunEventPayload; "run.waiting_for_input": RunEventPayload;
  "runtime.abort.failed": RunEventPayload; "runtime.initialized": RunEventPayload; "runtime.queue": RunEventPayload; "runtime.queue.cleared": RunEventPayload; "runtime.settled": RunEventPayload;
  "session.inbox.related.queued": RunEventPayload; "skill.invoked": RunEventPayload;
  "supervisor.approval.approved": RunEventPayload; "supervisor.approval.rejected": RunEventPayload; "supervisor.approval.requested": RunEventPayload; "supervisor.decision": RunEventPayload;
  "tool.bash.composite": RunEventPayload; "tool.bash.timed_out": RunEventPayload; "tool.completed": ToolCompletedEvent;
  "tool.failed": ToolCompletedEvent & { reason?: string }; "tool.guard.blocked": RunEventPayload; "tool.output.spilled": RunEventPayload; "tool.progress": ToolLifecycleEvent; "tool.started": ToolLifecycleEvent;
  "restart.interruption": RunEventPayload;
  "maintenance.activation.dispatch_failed": RunEventPayload; "maintenance.handoff.prepared": RunEventPayload;
  "maintenance.activation.succeeded": RunEventPayload; "maintenance.activation.failed": RunEventPayload;
  "transcript.repaired": RunEventPayload; "transcript.updated": TranscriptUpdatedEvent; "workflow.learning.failed": RunEventPayload;
  "workspace.edit.completed": RunEventPayload; "workspace.edit.rejected": RunEventPayload;
}
export type RunEventType = keyof RunEventMap;
export type RunEvent<TType extends RunEventType = RunEventType> = {
  runId: RunId;
  seq: number;
  type: TType;
  data: RunEventMap[TType];
  createdAt: number;
};

export interface TaskRun {
  id: RunId;
  sessionId: ExecutionSessionRef;
  requestId: string;
  status: RunStatus;
  phase: RunPhase;
  goal: string;
  /** Immutable execution profile captured when the TaskRun is admitted. */
  modelId: string;
  reasoningEffort: ReasoningEffort;
  contract: TaskRunContractSnapshot | null;
  gateRequired: boolean;
  blockedReason: string;
  lastEventSeq: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  attempt: number;
  resumedAt: number | null;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };
  transcriptCount: number;
  checkpoint: RunCheckpoint | null;
  continuations: RunContinuation[];
  plan: PlanItem[];
  checks: RunCheck[];
  artifacts: Artifact[];
  completionGate: CompletionGate;
  supervision: {
    latestDecision: SupervisorDecision | null;
    latestGates: GateEvaluation[];
    progress: ProgressSnapshot | null;
    approvalRequests: ApprovalRequest[];
    latestContextManifest: ContextManifest | null;
  };
  userInputRequests: UserInputRequest[];
  pendingUserInput: UserInputRequest | null;
  launchRetryable: boolean;
  resumable: boolean;
}

export type TaskRunSummary = Pick<
  TaskRun,
  "id" | "goal" | "status" | "phase" | "contract" | "attempt" | "createdAt" | "updatedAt"
>;

export interface TaskRunExecutionState {
  id: RunId;
  status: RunStatus;
  phase: RunPhase;
  attempt: number;
  lastEventSeq: number;
  counts: { plan: number; checks: number; artifacts: number };
}
