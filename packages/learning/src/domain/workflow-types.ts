import type { ContextManifestItem } from "@tagent/execution/domain";

export type WorkflowStatus = "candidate" | "active" | "suspended" | "deprecated";
export type WorkflowApplicationStatus = "exposed" | "adopted" | "partial" | "rejected";
export interface WorkflowSkippedStep { stepId: string; reason: string }
export interface WorkflowVerificationMapping { verificationCheck: string; runCheckKey: string }
export type WorkflowSourceType = "explicit_user" | "task_experience" | "task_failure" | "user_correction";
export type WorkflowFeedbackSignal = "successful" | "failed" | "corrected" | "harmful" | "helpful";
export type AutonomyActionType = "activate_workflow" | "apply_revision" | "start_canary" | "execute_workflow";
export type AutonomyApprovalStatus = "pending" | "approved" | "rejected" | "revoked" | "expired" | "executed";

export interface WorkflowStep { stepId: string; instruction: string; required: boolean; expectedArtifact?: string; failureHandling?: string }
export interface WorkflowVerification { check: string; required: boolean; successCondition: string }
export interface WorkflowValueContract { name: string; description: string; required: boolean; schema?: string }
export interface WorkflowSpec {
  name: string;
  intent: string;
  cueTerms: string[];
  applicability: string[];
  nonApplicability: string[];
  preconditions: string[];
  inputContract: WorkflowValueContract[];
  outputContract: WorkflowValueContract[];
  steps: WorkflowStep[];
  verification: WorkflowVerification[];
  requiredCapabilities: string[];
  riskClass: "low" | "medium" | "high";
}
export interface WorkflowRevision extends WorkflowSpec {
  id: string; workflowId: string; revision: number; sourceType: WorkflowSourceType;
  sourceEvidenceIds: string[]; counterexampleIds: string[]; confidence: number; changeSummary: string; createdAt: number;
}
export interface WorkflowDefinition {
  id: string; scopeId: string; status: WorkflowStatus; activeRevisionId: string | null;
  deletedAt?: number | null; purgeAfter?: number | null; deleteReason?: string; previousStatus?: WorkflowStatus | null; previousActiveRevisionId?: string | null;
  createdAt: number; updatedAt: number; revision?: WorkflowRevision;
}
export interface WorkflowRecall {
  promptSection: string;
  contextItems: ContextManifestItem[];
  workflows: Array<{ definition: WorkflowDefinition; revision: WorkflowRevision; score: number; reasons: string[]; bindingId: string }>;
}
export interface WorkflowEvaluationCheckResult { runId: string; checkKey: string; required: boolean; status: string; stale: boolean }
export interface TrustedEvaluationInput {
  workflowId: string; kind: "shadow" | "offline_replay" | "canary"; evaluatorId: string; evaluatorVersion: string;
  datasetId: string; datasetHash: string; baselineRevisionId: string; candidateRevisionId: string;
  evaluationRunIds: string[]; checkResults: WorkflowEvaluationCheckResult[]; signature?: string;
}
export interface AutonomyApprovalRequest {
  id: string; scopeId: string; actionType: AutonomyActionType; targetType: string; targetId: string;
  workflowId: string | null; revisionId: string | null; proposalId: string | null; bindingId: string | null;
  status: AutonomyApprovalStatus; riskClass: "low" | "medium" | "high"; impactScopeJson: string;
  evidenceJson: string; diffJson: string; rollbackJson: string; requestedBy: string; requestReason: string;
  expiresAt: number; decidedBy: string; decisionReason: string; decidedAt: number | null; executedAt: number | null;
  executionReceiptJson: string; requestHash: string; createdAt: number; updatedAt: number;
}
