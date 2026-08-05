import { createHash } from "node:crypto";
import type { ApprovalRef, ApprovalRisk } from "./approval.js";
import { stableJson } from "./operation-digest.js";

const CANARY_OUTCOME_DIGEST_PREFIX = "TAGENT_WORKFLOW_CANARY_OUTCOME\0v1\0";

export interface WorkflowGovernanceIdentity {
  workflowId: string;
  scopeId: string;
}

export type WorkflowGovernanceLifecycleState =
  | "candidate"
  | "active"
  | "suspended"
  | "deprecated";

export interface WorkflowGovernanceState {
  identity: WorkflowGovernanceIdentity;
  status: WorkflowGovernanceLifecycleState;
  activeRevisionId: string | null;
  previousStatus: WorkflowGovernanceLifecycleState | null;
  version: number;
  updatedAt: number;
}

export type ApprovedWorkflowGovernanceAction =
  | "workflow.activate"
  | "workflow.revision.apply"
  | "workflow.canary.start";

export type OwnedWorkflowGovernanceAction =
  | "workflow.suspend"
  | "workflow.forget"
  | "workflow.restore"
  | "workflow.canary.settle"
  | "learning.feature_policy.update";

export type WorkflowGovernanceAction =
  | ApprovedWorkflowGovernanceAction
  | OwnedWorkflowGovernanceAction;

export type WorkflowGovernanceRisk = ApprovalRisk;

export interface WorkflowGovernanceApproval<
  Action extends ApprovedWorkflowGovernanceAction = ApprovedWorkflowGovernanceAction,
> {
  ref: ApprovalRef;
  action: Action;
  operationDigest: string;
  risk: WorkflowGovernanceRisk;
}

const workflowRevisionDraftBrand: unique symbol = Symbol("WorkflowRevisionDraft");

/** Governance transports this value but never interprets Learning's revision schema. */
export interface WorkflowRevisionDraft {
  readonly workflowId: string;
  readonly proposalId: string;
  readonly baseRevisionId: string;
  readonly baseSpecHash: string;
  readonly proposalPatchHash: string;
  readonly resultSpecHash: string;
  readonly value: unknown;
  readonly [workflowRevisionDraftBrand]: true;
}

export function createWorkflowRevisionDraft(
  input: Omit<WorkflowRevisionDraft, typeof workflowRevisionDraftBrand>,
): WorkflowRevisionDraft {
  return Object.freeze({
    ...input,
    value: structuredClone(input.value),
    [workflowRevisionDraftBrand]: true as const,
  });
}

export interface MaterializedWorkflowRevision {
  revisionId: string;
  workflowId: string;
  proposalId: string;
  baseRevisionId: string;
  baseSpecHash: string;
  proposalPatchHash: string;
  resultSpecHash: string;
  draft: WorkflowRevisionDraft;
}

export interface WorkflowGovernanceProposalView {
  readonly proposalId: string;
  readonly workflowId: string;
  readonly baseRevisionId: string;
  readonly baseSpecHash: string;
  readonly patchHash: string;
  readonly patchJson: string;
  readonly evidenceJson: string;
  readonly reason: string;
  readonly status: "approved";
}

export interface WorkflowGovernanceRevisionView {
  readonly revisionId: string;
  readonly workflowId: string;
  readonly revision: number;
  readonly specHash: string;
  readonly specJson: string;
  readonly sourceType: string;
  readonly sourceEvidenceJson: string;
  readonly confidence: number;
}

export interface WorkflowExecutableApprovalView {
  readonly ref: ApprovalRef;
  readonly action: ApprovedWorkflowGovernanceAction;
  readonly status: "approved" | "executed";
  readonly expiresAt: number | null;
  readonly target: { readonly kind: string; readonly id: string };
  readonly workflowId: string;
  readonly revisionId: string | null;
  readonly proposalId: string | null;
  readonly scope: { readonly type: string; readonly id: string };
  readonly operationDigest: string;
  readonly risk: WorkflowGovernanceRisk;
  readonly reuse: {
    readonly mode: "one_time" | "reusable";
    readonly maxUses: number | null;
    readonly usedCount: number;
  };
  readonly decidedBy: string;
  readonly impactJson: string;
  /** Original command metadata required to reach the exact replay path. */
  readonly execution: {
    readonly commandId: string;
    readonly actorId: string;
    readonly reason: string;
    readonly timestamp: number;
  } | null;
}

export interface WorkflowCanaryPromotionCandidateView {
  readonly promotionId: string;
  readonly workflowId: string;
  readonly scopeId: string;
  readonly candidateRevisionId: string;
  readonly previousRevisionId: string;
  readonly authorizedMaxFailureDelta: number;
  readonly status: "canary";
  readonly createdAt: number;
}

export interface WorkflowCanaryOutcomeView {
  readonly runId: string;
  readonly variant: "baseline" | "candidate";
  readonly outcomeStatus: string;
  /** Immutable decision fact captured when the outcome was recorded. */
  readonly success: boolean;
  readonly requiredChecks: number;
  readonly passedChecks: number;
  readonly recordedAt: number;
}

export interface WorkflowCanaryCheckEvidenceView {
  readonly runId: string;
  readonly checkKey: string;
  readonly required: boolean;
  readonly status: string;
  readonly stale: boolean;
}

export interface WorkflowCanaryDecisionEvidence {
  readonly promotion: WorkflowCanaryPromotionCandidateView;
  readonly outcomes: readonly WorkflowCanaryOutcomeView[];
  readonly checks: readonly WorkflowCanaryCheckEvidenceView[];
}

/** Canonical identity of the exact promotion/evidence snapshot evaluated at settlement. */
export function canaryOutcomeDigest(evidence: WorkflowCanaryDecisionEvidence): string {
  const outcomes = [...evidence.outcomes].sort((left, right) => left.variant.localeCompare(right.variant)
    || left.runId.localeCompare(right.runId));
  const checks = [...evidence.checks].sort((left, right) => left.runId.localeCompare(right.runId)
    || left.checkKey.localeCompare(right.checkKey));
  return createHash("sha256")
    .update(CANARY_OUTCOME_DIGEST_PREFIX, "utf8")
    .update(stableJson({ promotion: evidence.promotion, outcomes, checks }), "utf8")
    .digest("hex");
}

export interface WorkflowCanaryEvaluationReceipt {
  readonly id: string;
  readonly promotionId: string;
  readonly outcomeDigest: string;
  readonly outcome: "promoted" | "rolled_back";
  readonly baselineSampleSize: number;
  readonly candidateSampleSize: number;
  readonly baselineSuccessRate: number;
  readonly candidateSuccessRate: number;
  readonly authorizedMaxFailureDelta: number;
  readonly evaluationRunIds: readonly string[];
  readonly outcomes: readonly WorkflowCanaryOutcomeView[];
  readonly checkResults: readonly WorkflowCanaryCheckEvidenceView[];
  readonly evaluatedAt: number;
}

interface WorkflowGovernanceCommandMetadata {
  commandId: string;
  actorId: string;
  reason: string;
  timestamp: number;
}

interface WorkflowGovernanceCommandContext
extends WorkflowGovernanceCommandMetadata, WorkflowGovernanceIdentity {}

export interface ActivateWorkflowGovernanceCommand
extends WorkflowGovernanceCommandContext {
  action: "workflow.activate";
  revisionId: string;
  approval: WorkflowGovernanceApproval<"workflow.activate">;
}

export interface ApplyWorkflowRevisionGovernanceCommand
extends WorkflowGovernanceCommandContext {
  action: "workflow.revision.apply";
  proposalId: string;
  revisionId: string;
  approval: WorkflowGovernanceApproval<"workflow.revision.apply">;
}

export interface StartWorkflowCanaryGovernanceCommand
extends WorkflowGovernanceCommandContext {
  action: "workflow.canary.start";
  revisionId: string;
  previousRevisionId: string;
  canaryPercent: number;
  maxFailureDelta: number;
  approval: WorkflowGovernanceApproval<"workflow.canary.start">;
}

export type ApprovedWorkflowGovernanceCommand =
  | ActivateWorkflowGovernanceCommand
  | ApplyWorkflowRevisionGovernanceCommand
  | StartWorkflowCanaryGovernanceCommand;

export interface SuspendWorkflowGovernanceCommand
extends WorkflowGovernanceCommandContext {
  action: "workflow.suspend";
}

export interface ForgetWorkflowGovernanceCommand
extends WorkflowGovernanceCommandContext {
  action: "workflow.forget";
  gracePeriodMs: number;
}

export interface RestoreWorkflowGovernanceCommand
extends WorkflowGovernanceCommandContext {
  action: "workflow.restore";
}

export interface SettleWorkflowCanaryGovernanceCommand
extends WorkflowGovernanceCommandContext {
  action: "workflow.canary.settle";
  promotionId: string;
  outcome: "promoted" | "rolled_back";
  activeRevisionId: string;
  evaluationReceipt: WorkflowCanaryEvaluationReceipt;
}

export interface UpdateWorkflowFeaturePolicyGovernanceCommand
extends WorkflowGovernanceCommandMetadata {
  action: "learning.feature_policy.update";
  target: { readonly kind: "global" };
  policy: {
    learningEnabled: boolean;
    memoryEnabled: boolean;
    autoExecutionEnabled: boolean;
  };
}

export type OwnedWorkflowGovernanceCommand =
  | SuspendWorkflowGovernanceCommand
  | ForgetWorkflowGovernanceCommand
  | RestoreWorkflowGovernanceCommand
  | SettleWorkflowCanaryGovernanceCommand
  | UpdateWorkflowFeaturePolicyGovernanceCommand;

export type WorkflowGovernanceCommand =
  | ApprovedWorkflowGovernanceCommand
  | OwnedWorkflowGovernanceCommand;

export type WorkflowGovernanceReceiptKind = "approval" | "governance" | "audit";

export interface WorkflowGovernanceReceipt {
  id: string;
  kind: WorkflowGovernanceReceiptKind;
  commandId: string;
  action: WorkflowGovernanceAction;
  workflowId: string | null;
  actorId: string;
  status: "committed";
  detail: Readonly<Record<string, unknown>>;
  committedAt: number;
}

export interface ApprovedWorkflowGovernanceReceiptEvidence {
  kind: "approved";
  approval: WorkflowGovernanceReceipt & { kind: "approval" };
  governance: WorkflowGovernanceReceipt & { kind: "governance" };
  audit: WorkflowGovernanceReceipt & { kind: "audit" };
}

export interface WorkflowOwnedGovernanceReceiptEvidence {
  kind: "workflow_owned";
  governance: WorkflowGovernanceReceipt & { kind: "governance" };
  audit: WorkflowGovernanceReceipt & { kind: "audit" };
}

export interface FeaturePolicyGovernanceReceiptEvidence {
  kind: "feature_policy";
  audit: WorkflowGovernanceReceipt & { kind: "audit" };
}

export type WorkflowGovernanceReceiptEvidence =
  | ApprovedWorkflowGovernanceReceiptEvidence
  | WorkflowOwnedGovernanceReceiptEvidence
  | FeaturePolicyGovernanceReceiptEvidence;

export interface WorkflowGovernanceEffectResult {
  commandId: string;
  state: WorkflowGovernanceState | null;
  receipts: WorkflowGovernanceReceiptEvidence;
  value: unknown;
}
