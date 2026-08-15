import type {
  AutonomyApprovalRequest,
  AutonomyApprovalStatus,
  WorkflowApplicationStatus,
  WorkflowDefinition,
  WorkflowFeedbackSignal,
  WorkflowSourceType,
} from "../domain/workflow-types.js";

export type RunLearningPolicy = "allow" | "metadata_only" | "deny";

export interface RunLearningPolicyRecord {
  runId: string;
  policy: RunLearningPolicy;
  reason: string;
  updatedAt: number;
}

export interface ExperienceObservationWrite {
  id: string;
  scopeId: string;
  runId: string | null;
  attempt: number | null;
  lifecycle: string;
  outcome: string;
  eventSeq: number;
  sourceType: WorkflowSourceType;
  taskSignature: string;
  procedureSummary: string;
  checksPassedJson: string;
  checksFailedJson: string;
  sourceRefsJson: string;
  learnPolicy: RunLearningPolicy;
  observationHash: string;
  createdAt: number;
}

export interface ExperienceObservationRecord {
  id: string;
  runId: string;
  sourceType: WorkflowSourceType;
  taskSignature: string;
  procedureSummary: string;
  checksPassedJson: string;
  checksFailedJson: string;
  createdAt: number;
}

export interface WorkflowRevisionRecord {
  id: string;
  workflowId: string;
  revision: number;
  specJson: string;
  sourceType: WorkflowSourceType;
  sourceEvidenceJson: string;
  confidence: number;
  changeSummary: string;
  createdAt: number;
}

export interface WorkflowRevisionWrite extends Omit<WorkflowRevisionRecord, "revision"> {
  specHash: string;
}

export interface WorkflowDefinitionWrite {
  id: string;
  scopeId: string;
  status: "candidate";
  activeRevisionId: null;
  createdAt: number;
  updatedAt: number;
}

export interface WorkflowGovernanceReceiptWrite {
  id: string;
  workflowId: string;
  action: string;
  actor: string;
  reason: string;
  metadataJson: string;
  createdAt: number;
}

export interface AutonomyAuditWrite {
  id: string;
  scopeId: string;
  category: "observe" | "learn" | "distill" | "evolve" | "approval" | "execute";
  action: string;
  actor: string;
  sourceRunId: string | null;
  workflowId: string | null;
  revisionId: string | null;
  approvalId: string | null;
  evidenceJson: string;
  metadataJson: string;
  receiptHash: string;
  createdAt: number;
}

export interface DistillationJobRecord extends Record<string, unknown> {
  id: string;
  scope_id: string;
  task_signature: string;
  lease_token: string;
  fence: number;
  attempts: number;
  checkpoint_json: string;
}

export interface WorkflowProposalRecord {
  workflowId: string;
  baseRevisionId: string;
  patchJson: string;
  baseSpecHash: string;
  proposedSpecHash: string;
  changedPathsJson: string;
  reason: string;
  evidenceJson: string;
  status: string;
}

export interface WorkflowEvaluationWrite {
  id: string;
  workflowId: string;
  revisionId: string;
  kind: "shadow" | "offline_replay" | "canary";
  status: string;
  sampleSize: number;
  successRate: number;
  baselineRate: number;
  riskClass: string;
  evidenceJson: string;
  evaluatorId: string;
  evaluatorVersion: string;
  datasetId: string;
  datasetHash: string;
  baselineRevisionId: string;
  candidateRevisionId: string;
  evaluationRunIdsJson: string;
  checkResultsJson: string;
  receiptHash: string;
  signature: string;
  createdAt: number;
}

interface WorkflowLearningStorageContract {
  upsertRunLearningPolicy(record: RunLearningPolicyRecord): RunLearningPolicyRecord;
  getRunLearningPolicy(runId: string): RunLearningPolicyRecord | undefined;
  recordExperienceObservation(record: ExperienceObservationWrite): { id: string };

  enqueueDistillationJob(input: { id: string; scopeId: string; taskSignature: string; signatureTermsJson: string; timestamp: number }): unknown;
  claimDistillationJob(input: { owner: string; token: string; timestamp: number; leaseUntil: number }): DistillationJobRecord | undefined;
  renewDistillationLease(input: { id: string; owner: string; token: string; fence: number; timestamp: number; leaseUntil: number }): boolean;
  checkpointDistillationJob(input: { id: string; owner: string; token: string; fence: number; checkpointJson: string; timestamp: number; leaseUntil: number }): boolean;
  updateDistillationCheckpoint(id: string, checkpointJson: string, timestamp: number): void;
  getDistillationCheckpoint(id: string): string;
  completeDistillationJob(input: { id: string; owner: string; token: string; fence: number; workflowId: string | null; checkpointJson: string; timestamp: number }): boolean;
  failDistillationJob(input: { id: string; owner: string; token: string; fence: number; status: "queued" | "dead_letter"; checkpointJson: string; error: string; timestamp: number }): void;
  listExperienceCandidates(scopeId: string, limit?: number): ExperienceObservationRecord[];
  findDistilledWorkflow(evidenceSetHash: string): { workflowId: string } | undefined;
  recordDistillationConflict(input: { id: string; jobId: string; scopeId: string; candidateSignature: string; workflowId: string; revisionId: string; kind: "duplicate" | "conflict"; similarity: number; reasonsJson: string; createdAt: number }): void;
  createWorkflow(
    definition: WorkflowDefinitionWrite,
    revision: WorkflowRevisionWrite,
    distillation?: { evidenceSetHash: string; createdAt: number },
  ): void;
  createWorkflowRevision(revision: WorkflowRevisionWrite): number;
  listWorkflowDefinitions(scopeId: string, includeDeleted: boolean): WorkflowDefinition[];
  getWorkflowDefinition(id: string, includeDeleted: boolean): WorkflowDefinition | undefined;
  listWorkflowRevisionIds(workflowId: string): string[];
  getWorkflowRevision(id: string): WorkflowRevisionRecord | undefined;
  findActiveApprovalByHash(requestHash: string): { id: string; status: AutonomyApprovalStatus } | undefined;
  createApproval(input: { approval: Omit<AutonomyApprovalRequest, "decidedAt" | "executedAt"> & { decidedAt?: number | null; executedAt?: number | null }; audit: AutonomyAuditWrite }): void;
  getApproval(id: string): AutonomyApprovalRequest | undefined;
  listApprovals(scopeId: string, limit: number): AutonomyApprovalRequest[];
  listApprovalsPage(scopeId: string, query: {
    snapshotCreatedAt?: number;
    after?: { createdAt: number; id: string };
    limit: number;
  }): { items: AutonomyApprovalRequest[]; snapshotCreatedAt: number };
  decideApproval(input: { id: string; decision: "approved" | "rejected"; actor: string; reason: string; timestamp: number; audit: AutonomyAuditWrite }): void;
  revokeApproval(input: { id: string; actor: string; reason: string; timestamp: number; audit: AutonomyAuditWrite }): void;
  expireApprovals(
    timestamp: number,
    createAudits: (rows: Array<{ id: string; scopeId: string; workflowId: string | null; revisionId: string | null }>) => AutonomyAuditWrite[],
  ): Array<{ id: string; scopeId: string; workflowId: string | null; revisionId: string | null }>;

  recordApplication(input: { id: string; bindingId: string; status: WorkflowApplicationStatus; mode: string; executedStepIdsJson: string; skippedStepsJson: string; correctionObserved: number; repeatedToolCalls: number; continuationCount: number; verificationMappingJson: string; attributionLevel: string; createdAt: number }): unknown;
  getApplicationReceipt(bindingId: string): Record<string, unknown> | undefined;
  listRunBindings(runId: string, attempt: number): Array<{ id: string; workflowId: string; revisionId: string; applicationMode: string }>;
  recordRunApplication(input: { id: string; bindingId: string; runId: string; attempt: number; taskOutcome: string; applicationStatus: WorkflowApplicationStatus; passed: number; failed: number; attributionLevel: string; createdAt: number }): void;
  recordFeedback(input: { id: string; workflowId: string; revisionId: string; runId: string; attempt: number; signal: WorkflowFeedbackSignal; weight: number; adopted: number; verified: number; idempotencyKey: string; note: string; createdAt: number }): { receipt: Record<string, unknown>; inserted: boolean };
  workflowQuality(revisionId: string): { samples: number; weight: number };
  recordSelectorReceipt(input: { id: string; runId: string; attempt: number; workflowId: string; revisionId: string; decision: "selected" | "excluded"; reasonsJson: string; score: number | null; createdAt: number }): void;
  getCanaryPromotion(workflowId: string): { id: string; revisionId: string; previousRevisionId: string; canaryPercent: number } | undefined;
  recordCanaryAssignment(input: { id: string; promotionId: string; workflowId: string; runId: string; attempt: number; scopeId: string; assignmentKey: string; assignmentHash: string; bucket: number; variant: string; revisionId: string; receiptHash: string; createdAt: number }): void;
  recordWorkflowBinding(input: { id: string; runId: string; attempt: number; workflowId: string; revisionId: string; score: number; reasonsJson: string; createdAt: number }): string;

  listBindings(scopeId: string, limit: number): unknown[];
  listFeedback(scopeId: string, limit: number): unknown[];
  createProposal(input: { id: string; workflowId: string; baseRevisionId: string; reason: string; evidenceJson: string; patchJson: string; baseSpecHash: string; proposedSpecHash: string; changedPathsJson: string; createdAt: number }): unknown;
  listProposals(scopeId: string): unknown[];
  getProposal(id: string): WorkflowProposalRecord | undefined;
  decideProposal(input: { id: string; decision: "approved" | "rejected"; actor: string; reason: string; timestamp: number; receipt: WorkflowGovernanceReceiptWrite }): unknown;

  listDistillationJobs(scopeId: string): unknown[];
  listRunLearningPolicies(scopeId: string): unknown[];
  listWorkflowQuality(scopeId: string): Array<{ workflowId: string; revisionId?: string; samples: number; weight: number }>;
  listEvaluations(scopeId: string): unknown[];
  listCanaryBindings(scopeId: string, limit: number): unknown[];
  getDistillationMetrics(scopeId: string | undefined, timestamp: number): unknown;
  listAutonomyAudit(scopeId: string, limit: number): unknown[];
  recordAutonomyAudit(audit: AutonomyAuditWrite): void;

  getEvaluationReceipt(id: string): Record<string, unknown> | undefined;
  recordEvaluationReceipt(input: WorkflowEvaluationWrite): void;
  hasWorkflowBinding(runId: string, workflowId: string, revisionId: string): boolean;
  listPassedEvaluations(workflowId: string, revisionId: string): Array<{ id: string; kind: string; receiptHash: string }>;
  listPendingCanaryBindings(runId: string, attempt: number): Array<{ id: string; promotionId: string }>;
  recordCanaryOutcome(input: { id: string; outcomeStatus: string; success: number; requiredChecks: number; passedChecks: number; timestamp: number }): void;
  retryDistillationJob(input: { id: string; checkpointJson: string; taskSignature?: string; timestamp: number }): unknown;
  listDeadLetterJobs(limit: number): unknown[];
}

export type WorkflowObservationRepository = Pick<WorkflowLearningStorageContract,
  | "upsertRunLearningPolicy"
  | "getRunLearningPolicy"
  | "recordExperienceObservation"
  | "enqueueDistillationJob"
  | "claimDistillationJob"
  | "renewDistillationLease"
  | "checkpointDistillationJob"
  | "updateDistillationCheckpoint"
  | "getDistillationCheckpoint"
  | "completeDistillationJob"
  | "failDistillationJob"
  | "listExperienceCandidates"
  | "findDistilledWorkflow"
  | "recordDistillationConflict"
  | "retryDistillationJob"
  | "listDeadLetterJobs">;

export type WorkflowCandidateRepository = Pick<WorkflowLearningStorageContract,
  | "createWorkflow"
  | "createWorkflowRevision"
  | "listWorkflowDefinitions"
  | "getWorkflowDefinition"
  | "listWorkflowRevisionIds"
  | "getWorkflowRevision"
  | "createProposal"
  | "listProposals"
  | "getProposal"
  | "decideProposal">;

export type WorkflowApprovalRepository = Pick<WorkflowLearningStorageContract,
  | "findActiveApprovalByHash"
  | "createApproval"
  | "getApproval"
  | "listApprovals"
  | "listApprovalsPage"
  | "decideApproval"
  | "revokeApproval"
  | "expireApprovals">;

export type WorkflowLearningReceiptRepository = Pick<WorkflowLearningStorageContract,
  | "recordApplication"
  | "getApplicationReceipt"
  | "listRunBindings"
  | "recordRunApplication"
  | "recordFeedback"
  | "workflowQuality"
  | "recordSelectorReceipt"
  | "getCanaryPromotion"
  | "recordCanaryAssignment"
  | "recordWorkflowBinding"
  | "recordAutonomyAudit"
  | "getEvaluationReceipt"
  | "recordEvaluationReceipt"
  | "hasWorkflowBinding"
  | "listPassedEvaluations"
  | "listPendingCanaryBindings"
  | "recordCanaryOutcome">;

export type WorkflowLearningQueryRepository = Pick<WorkflowLearningStorageContract,
  | "listBindings"
  | "listFeedback"
  | "listDistillationJobs"
  | "listRunLearningPolicies"
  | "listWorkflowQuality"
  | "listEvaluations"
  | "listCanaryBindings"
  | "getDistillationMetrics"
  | "listAutonomyAudit">;

export type WorkflowLearningRepository =
  & WorkflowObservationRepository
  & WorkflowCandidateRepository
  & WorkflowApprovalRepository
  & WorkflowLearningReceiptRepository
  & WorkflowLearningQueryRepository;
