export type SupervisorAction =
  | "observe"
  | "steer"
  | "follow_up"
  | "request_evidence"
  | "pause_for_approval"
  | "wait_for_runtime"
  | "start_continuation"
  | "complete_taskrun"
  | "block_taskrun";

export interface GateFailure {
  kind: string;
  key: string;
  reason: string;
  disposition:
    | "auto_fixable"
    | "needs_user_input"
    | "needs_approval"
    | "external_dependency"
    | "runtime_transient"
    | "non_recoverable";
}

export interface CriterionCoverage {
  criterion: string;
  status: "covered" | "unsupported" | "contradicted" | "blocked";
  evidenceRefs: string[];
  reason: string;
}

export interface GateEvaluation {
  id: string;
  runId: string;
  attempt: number;
  checkpointSeq: number;
  gateType: "progress" | "evidence" | "contract" | "completion" | "continuation" | "spawn";
  evaluator: "llm" | "system";
  evaluatorModel: string;
  summary: string;
  passed: boolean;
  failures: GateFailure[];
  criterionCoverage?: CriterionCoverage[];
  inputManifestHash: string;
  createdAt: number;
}

export interface ProgressSnapshot {
  runId: string;
  attempt: number;
  checkpointSeq: number;
  meaningfulChanges: number;
  consecutiveFailures: number;
  repeatedOperations: number;
  lastProgressAt: number;
  lastDecisionId: string;
  updatedAt: number;
}

export interface SupervisorDecision {
  id: string;
  runId: string;
  evaluator: "llm" | "system";
  evaluatorModel: string;
  attempt: number;
  checkpointSeq: number;
  trigger: "checkpoint" | "settled" | "attempt_terminal" | "taskrun_terminal" | "manual";
  action: SupervisorAction;
  reasonCode: string;
  rationale: string;
  confidence: number;
  instruction: string;
  candidateResponseHash: string;
  status: "proposed" | "executed" | "superseded" | "failed";
  error: string;
  createdAt: number;
  executedAt: number | null;
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  decisionId: string;
  attempt?: number;
  actionType: "resume_taskrun" | "start_parallel_taskrun";
  targetType: "taskrun" | "session_inbox_item";
  targetId: string;
  reason: string;
  metadata: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "superseded";
  requestedAt: number;
  resolvedAt: number | null;
  resolvedBy: string;
  resolution: string;
}

export interface PlanItem {
  key: string;
  title: string;
  status: "pending" | "in_progress" | "done" | "blocked" | "skipped";
  required: boolean;
  position: number;
}

export interface RunCheck {
  key: string;
  title: string;
  status: "pending" | "running" | "passed" | "failed" | "blocked" | "skipped";
  required: boolean;
  command: string;
  evidence: string;
  stale: boolean;
  /** System-issued operation receipt that produced this check result. */
  sourceOperationId?: string | null;
  /** Completion time copied from the source receipt, never supplied by the Agent. */
  observedAt?: number | null;
}

export interface Artifact {
  id: string;
  runId: string;
  kind: string;
  title: string;
  content: string;
  uri: string;
  createdAt: number;
}

export interface CompletionGate {
  passed: boolean;
  failures: Array<{ kind: string; key: string; reason: string }>;
}
