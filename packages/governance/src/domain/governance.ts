export type SupervisorAction =
  | "observe"
  | "steer"
  | "follow_up"
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

/** One Core-owned action algebra shared by deterministic and model-backed audits. */
export function deriveSupervisorAction(failures: GateFailure[]): SupervisorAction {
  if (!failures.length) return "complete_taskrun";
  if (failures.some((failure) => failure.disposition === "needs_approval")) return "pause_for_approval";
  if (failures.some((failure) => ["needs_user_input", "external_dependency", "non_recoverable"].includes(failure.disposition))) return "block_taskrun";
  return "start_continuation";
}

export interface CriterionCoverage {
  criterion: string;
  status: "covered" | "unsupported" | "contradicted" | "blocked";
  evidenceRefs: string[];
  /** Core-verified excerpts from immutable evidence sources. */
  evidenceQuotes?: EvidenceQuote[];
  /** Durable operator decision accepting honest residual uncertainty for this criterion. */
  acceptedUncertaintyId?: string;
  reason: string;
}

export type EvidenceQuoteSelector =
  | { kind: "text_quote"; exact: string; occurrence?: number }
  | { kind: "line_range"; startLine: number; endLine: number }
  | { kind: "byte_range"; startByte: number; endByte: number }
  | { kind: "json_pointer"; pointer: string };

export interface EvidenceQuote {
  sourceRef: string;
  sourceRevision: string;
  sourceHash: string;
  selector: EvidenceQuoteSelector;
  quote: string;
}

export interface EvidenceSource {
  sourceRef: string;
  kind: "artifact" | "operation" | "transcript" | "memory";
  sourceRevision: string;
  sourceHash: string;
  content: string;
}

export interface AcceptedUncertainty {
  id: string;
  runId: string;
  criterionId: string;
  criterion: string;
  contractHash: string;
  actorId: string;
  rationale: string;
  scope: string;
  evidenceRefs: string[];
  expiresAt: number | null;
  createdAt: number;
}

export interface UnresolvedUncertainty {
  criterionId: string;
  criterion: string;
  status: "unsupported" | "blocked";
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
  /** Structured epistemic provenance; confidence remains for legacy readers. */
  epistemicStatus?: "deterministic" | "model_assessed" | "degraded";
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
  actionType: "resume_taskrun" | "start_parallel_taskrun" | "execute_external_action";
  targetType: "taskrun" | "session_inbox_item";
  targetId: string;
  reason: string;
  metadata: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "superseded" | "consumed";
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
  /** Present for criterion-aware plans; absent rows retain legacy compatibility. */
  schemaVersion?: 2;
  objectiveIds?: string[];
  criterionIds?: string[];
  dependencies?: string[];
  createdAttempt?: number;
  updatedAttempt?: number;
  replanReason?: string;
  completionEvidenceRefs?: string[];
}

/** Immutable audit snapshot for one material criterion-aware Plan mutation. */
export interface PlanItemRevision {
  id: number;
  runId: string;
  itemKey: string;
  revision: number;
  snapshot: PlanItem;
  snapshotHash: string;
  attempt: number;
  reason: string;
  createdAt: number;
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
