export type SessionId = string;
export type RunId = string;

export type RunStatus = "running" | "completed" | "blocked" | "interrupted" | "cancelled" | "failed";
export type RunPhase = "discover" | "plan" | "implement" | "verify" | "review" | "done" | "blocked";
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

export type SupervisorAction = "observe" | "steer" | "follow_up" | "request_evidence" | "pause_for_approval" | "wait_for_runtime" | "start_continuation" | "complete_taskrun" | "block_taskrun" | "spawn_taskrun";
export interface GateFailure { kind: string; key: string; reason: string; disposition: "auto_fixable" | "needs_user_input" | "needs_approval" | "external_dependency" | "runtime_transient" | "budget_exhausted" | "non_recoverable" }
export interface GateEvaluation { id: string; runId: RunId; attempt: number; checkpointSeq: number; gateType: "progress" | "evidence" | "completion" | "continuation" | "spawn"; passed: boolean; failures: GateFailure[]; inputManifestHash: string; createdAt: number }
export interface ProgressSnapshot { runId: RunId; attempt: number; checkpointSeq: number; meaningfulChanges: number; consecutiveFailures: number; repeatedOperations: number; lastProgressAt: number; lastDecisionId: string; updatedAt: number }
export interface SupervisorDecision { id: string; runId: RunId; attempt: number; checkpointSeq: number; trigger: "checkpoint" | "settled" | "attempt_terminal" | "taskrun_terminal" | "manual"; action: SupervisorAction; reasonCode: string; rationale: string; confidence: number; instruction: string; candidateResponseHash: string; status: "proposed" | "executed" | "superseded" | "failed"; error: string; createdAt: number; executedAt: number | null }
export interface SpawnProposal { id: string; runId: RunId; goal: string; acceptanceCriteria: string[]; relation: "depends_on" | "follow_up" | "parallel" | "derived"; status: "proposed" | "approved" | "spawned" | "rejected"; spawnedRunId: string; createdAt: number; updatedAt: number }
export interface TaskRunEdge { fromRunId: RunId; toRunId: RunId; relation: SpawnProposal["relation"] | "blocks" | "supersedes"; reason: string; createdAt: number }

export interface SessionInboxItem {
  id: string;
  sessionId: SessionId;
  requestId: string;
  content: string;
  status: "queued" | "claimed" | "started" | "deleted" | "failed";
  decision: "pending" | "start_taskrun" | "defer" | "merge" | "delete";
  runId: RunId | null;
  error: string;
  position: number;
  createdAt: number;
  updatedAt: number;
  claimedAt: number | null;
  startedAt: number | null;
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
  supervision: { latestDecision: SupervisorDecision | null; latestGates: GateEvaluation[]; progress: ProgressSnapshot | null; spawnProposals: SpawnProposal[] };
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
