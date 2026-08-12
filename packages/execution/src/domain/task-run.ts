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
  terminalAckedSeq: number | null;
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
export type ContextManifestItemKind = "system_prompt" | "taskrun_contract" | "workspace_goal" | "session_message" | "transcript_message" | "core_memory" | "memory_card" | "cold_topic" | "workflow_revision" | "communication_profile" | "project_rule" | "user_prompt";
export interface ContextManifestItem { kind: ContextManifestItemKind; sourceId: string; role?: string; selected: boolean; reason: string; estimatedTokens: number; metadata?: Record<string, unknown> }
export interface ContextManifest { id: string; runId: RunId; attempt: number; source: ContextManifestSource; items: ContextManifestItem[]; stats: Record<string, number | string>; manifestHash: string; createdAt: number }

export interface RunContinuation { id: string; runId: RunId; ordinal: number; status: "queued" | "running" | "completed" | "blocked" | "failed" | "cancelled"; reason: string; error: string; createdAt: number; startedAt: number | null; completedAt: number | null; leaseOwner: string; leaseUntil: number | null; heartbeatAt: number | null }
export interface RunEvent { runId: RunId; seq: number; type: string; data: Record<string, unknown>; createdAt: number }

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
