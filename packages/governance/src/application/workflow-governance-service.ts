import type {
  ActivateWorkflowGovernanceCommand,
  ApplyWorkflowRevisionGovernanceCommand,
  ApprovedWorkflowGovernanceCommand,
  ApprovedWorkflowGovernanceReceiptEvidence,
  FeaturePolicyGovernanceReceiptEvidence,
  ForgetWorkflowGovernanceCommand,
  OwnedWorkflowGovernanceCommand,
  RestoreWorkflowGovernanceCommand,
  SettleWorkflowCanaryGovernanceCommand,
  StartWorkflowCanaryGovernanceCommand,
  SuspendWorkflowGovernanceCommand,
  UpdateWorkflowFeaturePolicyGovernanceCommand,
  WorkflowGovernanceEffectResult,
  WorkflowGovernanceProposalView,
  WorkflowGovernanceReceipt,
  WorkflowGovernanceRevisionView,
  WorkflowOwnedGovernanceReceiptEvidence,
} from "../domain/workflow-governance.js";
import type {
  WorkflowGovernancePersistencePort,
  WorkflowRevisionMaterializerPort,
} from "../ports/workflow-governance-port.js";

export type ActivateWorkflowInput = Omit<ActivateWorkflowGovernanceCommand, "action">;
export type ApplyWorkflowRevisionInput = Omit<ApplyWorkflowRevisionGovernanceCommand, "action">;
export type StartWorkflowCanaryInput = Omit<StartWorkflowCanaryGovernanceCommand, "action">;
export type SuspendWorkflowInput = Omit<SuspendWorkflowGovernanceCommand, "action">;
export type ForgetWorkflowInput = Omit<ForgetWorkflowGovernanceCommand, "action">;
export type RestoreWorkflowInput = Omit<RestoreWorkflowGovernanceCommand, "action">;
export type SettleWorkflowCanaryInput = Omit<SettleWorkflowCanaryGovernanceCommand, "action">;
export type UpdateWorkflowFeaturePolicyInput = Omit<UpdateWorkflowFeaturePolicyGovernanceCommand, "action">;

function requireText(value: string, field: string): void {
  if (!value.trim()) throw new TypeError(`${field} is required`);
}

function validateCommand(command: ApprovedWorkflowGovernanceCommand | OwnedWorkflowGovernanceCommand): void {
  requireText(command.commandId, "Workflow Governance commandId");
  requireText(command.actorId, "Workflow Governance actorId");
  if (!Number.isSafeInteger(command.timestamp) || command.timestamp < 0) {
    throw new TypeError("Workflow Governance timestamp is invalid");
  }
  if (command.action === "learning.feature_policy.update") {
    if (command.target.kind !== "global") {
      throw new TypeError("Learning feature policy target is invalid");
    }
    if (typeof command.policy.memoryEnabled !== "boolean"
      || typeof command.policy.learningEnabled !== "boolean"
      || typeof command.policy.autoExecutionEnabled !== "boolean") {
      throw new TypeError("Learning feature policy values must be boolean");
    }
    if (command.policy.learningEnabled && !command.policy.memoryEnabled) {
      throw new TypeError("Learning feature policy requires Memory before Learning");
    }
    if (command.policy.autoExecutionEnabled && !command.policy.learningEnabled) {
      throw new TypeError("Learning feature policy requires Learning before automatic execution");
    }
    return;
  }
  requireText(command.workflowId, "Workflow Governance workflowId");
  requireText(command.scopeId, "Workflow Governance scopeId");
}

function validateApprovedCommand(command: ApprovedWorkflowGovernanceCommand): void {
  validateCommand(command);
  if (command.approval.ref.source !== "workflow") {
    throw new Error("Workflow Governance preserves workflow approval authority");
  }
  if (command.approval.action !== command.action) {
    throw new Error(`Workflow approval does not authorize ${command.action}`);
  }
  requireText(command.approval.ref.id, "Workflow approval id");
  requireText(command.approval.operationDigest, "Workflow approval operationDigest");
  if (command.action === "workflow.canary.start"
    && (!Number.isFinite(command.canaryPercent)
      || command.canaryPercent <= 0
      || command.canaryPercent > 25
      || !Number.isFinite(command.maxFailureDelta)
      || command.maxFailureDelta < 0
      || command.maxFailureDelta > 1)) {
    throw new TypeError("Workflow canary policy is invalid");
  }
}

function receipt(
  command: ApprovedWorkflowGovernanceCommand | OwnedWorkflowGovernanceCommand,
  kind: WorkflowGovernanceReceipt["kind"],
): WorkflowGovernanceReceipt {
  const scopeId = command.action === "learning.feature_policy.update" ? "global" : command.scopeId;
  const approval = "approval" in command
    ? {
        approvalSource: command.approval.ref.source,
        approvalId: command.approval.ref.id,
        operationDigest: command.approval.operationDigest,
        risk: command.approval.risk,
      }
    : { authority: "governance" };
  const effect = command.action === "workflow.activate"
    ? { revisionId: command.revisionId }
    : command.action === "workflow.revision.apply"
      ? { proposalId: command.proposalId, revisionId: command.revisionId }
      : command.action === "workflow.canary.start"
        ? {
            revisionId: command.revisionId,
            previousRevisionId: command.previousRevisionId,
            canaryPercent: command.canaryPercent,
            maxFailureDelta: command.maxFailureDelta,
          }
        : command.action === "workflow.forget"
          ? { gracePeriodMs: command.gracePeriodMs }
          : command.action === "workflow.canary.settle"
            ? {
                promotionId: command.promotionId,
                outcome: command.outcome,
                activeRevisionId: command.activeRevisionId,
                evaluationReceipt: command.evaluationReceipt,
              }
            : command.action === "learning.feature_policy.update"
              ? { target: command.target, policy: command.policy }
              : {};
  return {
    id: `workflow-governance:${command.commandId}:${kind}`,
    kind,
    commandId: command.commandId,
    action: command.action,
    workflowId: command.action === "learning.feature_policy.update" ? null : command.workflowId,
    actorId: command.actorId,
    status: "committed",
    detail: Object.freeze({ scopeId, reason: command.reason, ...approval, ...effect }),
    committedAt: command.timestamp,
  };
}

function approvedReceiptEvidence(
  command: ApprovedWorkflowGovernanceCommand,
): ApprovedWorkflowGovernanceReceiptEvidence {
  return {
    kind: "approved",
    approval: receipt(command, "approval") as ApprovedWorkflowGovernanceReceiptEvidence["approval"],
    governance: receipt(command, "governance") as ApprovedWorkflowGovernanceReceiptEvidence["governance"],
    audit: receipt(command, "audit") as ApprovedWorkflowGovernanceReceiptEvidence["audit"],
  };
}

function ownedReceiptEvidence(
  command: OwnedWorkflowGovernanceCommand,
): WorkflowOwnedGovernanceReceiptEvidence | FeaturePolicyGovernanceReceiptEvidence {
  if (command.action === "learning.feature_policy.update") {
    return {
      kind: "feature_policy",
      audit: receipt(command, "audit") as FeaturePolicyGovernanceReceiptEvidence["audit"],
    };
  }
  return {
    kind: "workflow_owned",
    governance: receipt(command, "governance") as WorkflowOwnedGovernanceReceiptEvidence["governance"],
    audit: receipt(command, "audit") as WorkflowOwnedGovernanceReceiptEvidence["audit"],
  };
}

function validateMaterialization(
  command: ApplyWorkflowRevisionGovernanceCommand,
  proposal: WorkflowGovernanceProposalView,
  baseRevision: WorkflowGovernanceRevisionView,
  materialized: ReturnType<WorkflowRevisionMaterializerPort["materialize"]>,
): void {
  if (proposal.workflowId !== command.workflowId
    || baseRevision.workflowId !== command.workflowId
    || proposal.baseRevisionId !== baseRevision.revisionId
    || proposal.baseSpecHash !== baseRevision.specHash
    || materialized.workflowId !== command.workflowId
    || materialized.proposalId !== command.proposalId
    || materialized.baseRevisionId !== baseRevision.revisionId
    || materialized.baseSpecHash !== baseRevision.specHash
    || materialized.proposalPatchHash !== proposal.patchHash
    || materialized.revisionId !== command.revisionId
    || !materialized.resultSpecHash
    || materialized.draft.workflowId !== command.workflowId
    || materialized.draft.proposalId !== command.proposalId
    || materialized.draft.baseRevisionId !== baseRevision.revisionId
    || materialized.draft.baseSpecHash !== baseRevision.specHash
    || materialized.draft.proposalPatchHash !== proposal.patchHash
    || materialized.draft.resultSpecHash !== materialized.resultSpecHash) {
    throw new Error("Workflow revision materialization identity/hash mismatch");
  }
}

/** Governance owns authorization dispatch; persistence owns the atomic mutation. */
export class WorkflowGovernanceService {
  constructor(
    private readonly persistence: WorkflowGovernancePersistencePort,
    private readonly materializer: WorkflowRevisionMaterializerPort,
  ) {}

  getState(workflowId: string) {
    return this.persistence.reader.getState(workflowId);
  }

  getReceipt(receiptId: string) {
    return this.persistence.reader.getReceipt(receiptId);
  }

  dispatchApproved(command: ApprovedWorkflowGovernanceCommand): WorkflowGovernanceEffectResult {
    validateApprovedCommand(command);
    return this.persistence.unitOfWork.run(() => {
      const receipts = approvedReceiptEvidence(command);
      const isReplay = command.action === "workflow.revision.apply"
        && this.persistence.reader.getReceipt(receipts.governance.id) !== undefined;
      const materializedRevision = command.action === "workflow.revision.apply" && !isReplay
        ? this.materializeApprovedRevision(command)
        : null;
      return this.persistence.mutations.commitApprovedEffect({
        command,
        materializedRevision,
        receipts,
      });
    });
  }

  dispatchOwned(command: OwnedWorkflowGovernanceCommand): WorkflowGovernanceEffectResult {
    validateCommand(command);
    return this.persistence.unitOfWork.run(() => this.persistence.mutations.commitOwnedEffect({
      command,
      receipts: ownedReceiptEvidence(command),
    }));
  }

  activateWorkflow(input: ActivateWorkflowInput) {
    return this.dispatchApproved({ ...input, action: "workflow.activate" });
  }

  activate(input: ActivateWorkflowInput) {
    return this.activateWorkflow(input);
  }

  applyProposalRevision(input: ApplyWorkflowRevisionInput) {
    return this.dispatchApproved({ ...input, action: "workflow.revision.apply" });
  }

  applyProposal(input: ApplyWorkflowRevisionInput) {
    return this.applyProposalRevision(input);
  }

  startCanary(input: StartWorkflowCanaryInput) {
    return this.dispatchApproved({ ...input, action: "workflow.canary.start" });
  }

  promote(input: StartWorkflowCanaryInput) {
    return this.startCanary(input);
  }

  suspendWorkflow(input: SuspendWorkflowInput) {
    return this.dispatchOwned({ ...input, action: "workflow.suspend" });
  }

  suspend(input: SuspendWorkflowInput) {
    return this.suspendWorkflow(input);
  }

  forgetWorkflow(input: ForgetWorkflowInput) {
    return this.dispatchOwned({ ...input, action: "workflow.forget" });
  }

  forget(input: ForgetWorkflowInput) {
    return this.forgetWorkflow(input);
  }

  restoreWorkflow(input: RestoreWorkflowInput) {
    return this.dispatchOwned({ ...input, action: "workflow.restore" });
  }

  restore(input: RestoreWorkflowInput) {
    return this.restoreWorkflow(input);
  }

  settleCanary(input: SettleWorkflowCanaryInput) {
    return this.dispatchOwned({ ...input, action: "workflow.canary.settle" });
  }

  updateFeaturePolicy(input: UpdateWorkflowFeaturePolicyInput) {
    return this.dispatchOwned({ ...input, action: "learning.feature_policy.update" });
  }

  private materializeApprovedRevision(command: ApplyWorkflowRevisionGovernanceCommand) {
    const proposal = this.persistence.reader.getApprovedProposal(command.proposalId);
    if (!proposal || proposal.workflowId !== command.workflowId) {
      throw new Error("Approved workflow proposal was not found");
    }
    const baseRevision = this.persistence.reader.getRevision(proposal.baseRevisionId);
    if (!baseRevision) throw new Error("Workflow proposal base revision was not found");
    const materialized = this.materializer.materialize({
      proposal,
      baseRevision,
      revisionId: command.revisionId,
      timestamp: command.timestamp,
    });
    validateMaterialization(command, proposal, baseRevision, materialized);
    return materialized;
  }
}

/** Stable application name for composition roots; all behavior remains service-owned. */
export class WorkflowGovernanceApplication extends WorkflowGovernanceService {}
