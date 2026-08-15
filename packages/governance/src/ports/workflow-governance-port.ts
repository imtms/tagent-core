import type {
  ApprovedWorkflowGovernanceCommand,
  MaterializedWorkflowRevision,
  OwnedWorkflowGovernanceCommand,
  ApprovedWorkflowGovernanceReceiptEvidence,
  FeaturePolicyGovernanceReceiptEvidence,
  WorkflowGovernanceProposalView,
  WorkflowGovernanceRevisionView,
  WorkflowCanaryDecisionEvidence,
  WorkflowCanaryPromotionCandidateView,
  WorkflowExecutableApprovalView,
  WorkflowGovernanceEffectResult,
  WorkflowGovernanceReceipt,
  WorkflowOwnedGovernanceReceiptEvidence,
  WorkflowGovernanceState,
} from "../domain/workflow-governance.js";

type SynchronousWorkflowGovernanceResult<T> = T extends PromiseLike<unknown> ? never : T;

export interface WorkflowGovernanceUnitOfWork {
  /** Must use the same writer-fenced connection as both repositories below. */
  run<T>(work: () => T & SynchronousWorkflowGovernanceResult<T>): T;
}

export interface WorkflowGovernanceReaderRepository {
  /** Returned views must be detached, immutable snapshots from the current UOW. */
  getState(workflowId: string): WorkflowGovernanceState | undefined;
  getReceipt(receiptId: string): WorkflowGovernanceReceipt | undefined;
  getApprovedProposal(proposalId: string): WorkflowGovernanceProposalView | undefined;
  getRevision(revisionId: string): WorkflowGovernanceRevisionView | undefined;
  getExecutableApproval(approvalId: string): WorkflowExecutableApprovalView | undefined;
  listCanaryDecisionCandidates(limit: number): WorkflowCanaryPromotionCandidateView[];
  getCanaryDecisionEvidence(promotionId: string): WorkflowCanaryDecisionEvidence | undefined;
}

export interface MaterializeWorkflowRevisionInput {
  proposal: WorkflowGovernanceProposalView;
  baseRevision: WorkflowGovernanceRevisionView;
  revisionId: string;
  timestamp: number;
}

/** Converts the opaque draft without making Governance depend on Learning's schema. */
export interface WorkflowRevisionMaterializerPort {
  materialize(input: MaterializeWorkflowRevisionInput): MaterializedWorkflowRevision;
}

export interface ApprovedWorkflowGovernanceCommit {
  command: ApprovedWorkflowGovernanceCommand;
  materializedRevision: MaterializedWorkflowRevision | null;
  receipts: ApprovedWorkflowGovernanceReceiptEvidence;
}

export interface OwnedWorkflowGovernanceCommit {
  command: OwnedWorkflowGovernanceCommand;
  receipts: WorkflowOwnedGovernanceReceiptEvidence | FeaturePolicyGovernanceReceiptEvidence;
}

export interface WorkflowGovernanceMutationRepository {
  /**
   * Atomically validates and consumes the approval, mutates the workflow,
   * and records approval, governance, and audit receipts. Exact command replay
   * must be idempotent; any mismatch must fail closed with zero writes.
   */
  commitApprovedEffect(input: ApprovedWorkflowGovernanceCommit): WorkflowGovernanceEffectResult;

  /**
   * Atomically performs the Governance-owned mutation and records all receipts.
   * Exact command replay must return the original result; a commandId payload
   * mismatch must fail closed with zero writes.
   */
  commitOwnedEffect(input: OwnedWorkflowGovernanceCommit): WorkflowGovernanceEffectResult;
}

export interface WorkflowGovernancePersistencePort {
  unitOfWork: WorkflowGovernanceUnitOfWork;
  reader: WorkflowGovernanceReaderRepository;
  mutations: WorkflowGovernanceMutationRepository;
}
