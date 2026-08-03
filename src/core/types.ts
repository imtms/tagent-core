export type SessionId = string;
export type RunId = string;

export type RunStatus = "running" | "waiting_input" | "completed" | "blocked" | "interrupted" | "cancelled" | "failed";
export type RunPhase = "discover" | "plan" | "implement" | "verify" | "review" | "waiting_input" | "done" | "blocked";
export type PlanStatus = "pending" | "in_progress" | "done" | "blocked" | "skipped";
export type CheckStatus = "pending" | "running" | "passed" | "failed" | "blocked" | "skipped";

export interface Session {
  id: SessionId;
  title: string;
  createdAt: number;
  updatedAt: number;
  latestRunStatus: RunStatus | null;
  latestRunPhase: RunPhase | null;
}

export interface RunCheckpoint {
  runId: RunId;
  attempt: number;
  active: boolean;
  assistantPartial: string;
  currentTool: {
    toolCallId: string;
    toolName: string;
    startedAt?: number;
    lastActivityAt?: number;
  } | null;
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

export type SupervisorAction = "observe" | "steer" | "follow_up" | "request_evidence" | "pause_for_approval" | "wait_for_runtime" | "start_continuation" | "complete_taskrun" | "block_taskrun";
export interface GateFailure { kind: string; key: string; reason: string; disposition: "auto_fixable" | "needs_user_input" | "needs_approval" | "external_dependency" | "runtime_transient" | "non_recoverable" }
export interface CriterionCoverage { criterion: string; status: "covered" | "unsupported" | "contradicted" | "blocked"; evidenceRefs: string[]; reason: string }
export interface GateEvaluation { id: string; runId: RunId; attempt: number; checkpointSeq: number; gateType: "progress" | "evidence" | "contract" | "completion" | "continuation" | "spawn"; evaluator: "llm" | "system"; evaluatorModel: string; summary: string; passed: boolean; failures: GateFailure[]; criterionCoverage?: CriterionCoverage[]; inputManifestHash: string; createdAt: number }
export interface ProgressSnapshot { runId: RunId; attempt: number; checkpointSeq: number; meaningfulChanges: number; consecutiveFailures: number; repeatedOperations: number; lastProgressAt: number; lastDecisionId: string; updatedAt: number }
export interface SupervisorDecision { id: string; runId: RunId; evaluator: "llm" | "system"; evaluatorModel: string; attempt: number; checkpointSeq: number; trigger: "checkpoint" | "settled" | "attempt_terminal" | "taskrun_terminal" | "manual"; action: SupervisorAction; reasonCode: string; rationale: string; confidence: number; instruction: string; candidateResponseHash: string; status: "proposed" | "executed" | "superseded" | "failed"; error: string; createdAt: number; executedAt: number | null }
export type TaskRunRelation = "depends_on" | "follow_up" | "parallel" | "derived" | "blocks" | "supersedes";
export interface TaskRunEdge { fromRunId: RunId; toRunId: RunId; relation: TaskRunRelation; reason: string; createdAt: number }
export interface ApprovalRequest { id: string; runId: RunId; decisionId: string; actionType: "resume_taskrun" | "start_parallel_taskrun"; targetType: "taskrun" | "session_inbox_item"; targetId: string; reason: string; metadata: Record<string, unknown>; status: "pending" | "approved" | "rejected" | "superseded"; requestedAt: number; resolvedAt: number | null; resolvedBy: string; resolution: string }
export interface UserInputField { key: string; label: string; description: string; inputType: "text" | "textarea"; required: boolean; placeholder: string }
export interface UserInputRequest { id: string; runId: RunId; attempt: number; prompt: string; fields: UserInputField[]; status: "pending" | "submitted" | "cancelled" | "superseded"; response: Record<string, string>; requestedAt: number; submittedAt: number | null }

export type ContextManifestSource = "session" | "transcript";
export type ContextManifestItemKind = "system_prompt" | "taskrun_contract" | "session_message" | "transcript_message" | "core_memory" | "memory_card" | "cold_topic" | "workflow_revision" | "communication_profile" | "user_prompt";
export interface ContextManifestItem {
  kind: ContextManifestItemKind;
  sourceId: string;
  role?: string;
  selected: boolean;
  reason: string;
  estimatedTokens: number;
  metadata?: Record<string, unknown>;
}
export interface ContextManifest {
  id: string; runId: RunId; attempt: number; source: ContextManifestSource;
  items: ContextManifestItem[]; stats: Record<string, number | string>;
  manifestHash: string; createdAt: number;
}

export type SessionInputIntent = "steer_active" | "follow_up_active" | "update_active_context" | "new_task" | "parallel_task" | "merge_candidate" | "discussion" | "clarification" | "defer";
export interface TaskObjective { id: string; summary: string; timing: "current" | "follow_up" | "parallel"; kind: "change" | "investigate" | "verify" | "document" | "release" | "answer" | "other" }
export interface SessionInputAnalysis {
  summary: string;
  objectives: TaskObjective[];
  intent: SessionInputIntent;
  targetRunId: RunId | null;
  priority: number;
  urgency: "low" | "normal" | "high" | "critical";
  relation: "same_goal" | "correction" | "constraint" | "follow_up" | "parallel" | "derived" | "depends_on" | "independent";
  acceptanceCriteria: string[];
  scope: string;
  nonGoals: string[];
  confidence: number;
  reason: string;
  routerVersion: string;
}
export interface TaskRunContract {
  sourceInput: string;
  summary: string;
  objectives: TaskObjective[];
  acceptanceCriteria: string[];
  scope: string;
  nonGoals: string[];
  sourceInboxIds: string[];
  parentRunId: RunId | null;
  relation: SessionInputAnalysis["relation"];
  intent: SessionInputIntent;
  decisionReason: string;
  routerVersion: string;
}

export interface SessionInboxItem {
  id: string;
  sessionId: SessionId;
  requestId: string;
  content: string;
  status: "queued" | "claimed" | "started" | "routed" | "deleted" | "failed";
  decision: "pending" | "start_taskrun" | "steer" | "follow_up" | "discussion" | "defer" | "merge" | "delete";
  runId: RunId | null;
  error: string;
  position: number;
  createdAt: number;
  updatedAt: number;
  claimedAt: number | null;
  startedAt: number | null;
  analysis: SessionInputAnalysis;
  manualOrder: boolean;
}

export interface Message {
  id: number;
  sessionId: SessionId;
  role: "user" | "assistant" | "tool";
  content: string;
  createdAt: number;
}

export interface PlanItem {
  key: string;
  title: string;
  status: PlanStatus;
  required: boolean;
  position: number;
}

export interface RunCheck {
  key: string;
  title: string;
  status: CheckStatus;
  required: boolean;
  command: string;
  evidence: string;
  stale: boolean;
}

export interface Artifact {
  id: string;
  runId: RunId;
  kind: string;
  title: string;
  content: string;
  uri: string;
  createdAt: number;
}

export interface RunContinuation {
  id: string;
  runId: RunId;
  ordinal: number;
  status: "queued" | "running" | "completed" | "blocked" | "failed" | "cancelled";
  reason: string;
  error: string;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  leaseOwner: string;
  leaseUntil: number | null;
  heartbeatAt: number | null;
}

export interface TaskRun {
  id: RunId;
  sessionId: SessionId;
  requestId: string;
  status: RunStatus;
  phase: RunPhase;
  goal: string;
  contract: TaskRunContract | null;
  gateRequired: boolean;
  blockedReason: string;
  lastEventSeq: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  attempt: number;
  resumedAt: number | null;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: number;
  };
  transcriptCount: number;
  checkpoint: RunCheckpoint | null;
  continuations: RunContinuation[];
  plan: PlanItem[];
  checks: RunCheck[];
  artifacts: Artifact[];
  completionGate: CompletionGate;
  supervision: { latestDecision: SupervisorDecision | null; latestGates: GateEvaluation[]; progress: ProgressSnapshot | null; approvalRequests: ApprovalRequest[]; latestContextManifest: ContextManifest | null };
  userInputRequests: UserInputRequest[];
  pendingUserInput: UserInputRequest | null;
  launchRetryable: boolean;
  resumable: boolean;
}

export interface CompletionGate {
  passed: boolean;
  failures: Array<{ kind: string; key: string; reason: string }>;
}

export interface RunEvent {
  runId: RunId;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface ChatEvent {
  type: "run.started" | "message.delta" | "message.completed" | "tool.started" | "tool.completed" | "run.completed" | "run.failed" | "run.cancelled" | "run.blocked";
  runId: RunId;
  data: Record<string, unknown>;
}
