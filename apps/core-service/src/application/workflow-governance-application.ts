import type { WorkflowGovernanceApplication } from "@tagent/governance/application";
import type { WorkflowGovernanceReaderRepository } from "@tagent/governance/ports";
import type {
  LearningFeatureControl,
  LearningFeatureState,
} from "@tagent/learning";

import {
  ApprovedWorkflowGovernanceExecutor,
  deterministicGovernanceId,
} from "./approved-workflow-governance-executor.js";

export interface LearningSettingsUpdate {
  memoryEnabled?: boolean;
  learningEnabled?: boolean;
  autoExecutionEnabled?: boolean;
  reason?: string;
}

/**
 * Core-owned compatibility facade for all workflow and feature-policy effects.
 * Learning remains available for queries and proposal/approval preparation only.
 */
export class CoreWorkflowGovernanceApplication {
  private readonly approvals: ApprovedWorkflowGovernanceExecutor;

  constructor(
    private readonly governance: WorkflowGovernanceApplication,
    private readonly reader: WorkflowGovernanceReaderRepository,
    private readonly learningControl?: LearningFeatureControl,
  ) {
    this.approvals = new ApprovedWorkflowGovernanceExecutor(governance, reader);
  }

  activateWorkflow(workflowId: string, revisionId?: string, approvalId?: string) {
    return this.activate(workflowId, revisionId, approvalId);
  }

  activate(workflowId: string, revisionId?: string, approvalId?: string) {
    const approval = this.approvals.requireApproval(approvalId, {
      action: "workflow.activate",
      workflowId,
      revisionId,
      targetKind: "workflow_revision",
      targetId: revisionId,
    });
    return this.approvals.dispatch(approval, approval.decidedBy || "approved_governor").value;
  }

  suspendWorkflow(workflowId: string, reason?: string) {
    return this.suspend(workflowId, reason);
  }

  suspend(workflowId: string, reason = "governance") {
    const state = this.requireState(workflowId);
    return this.governance.suspend({
      commandId: this.ownedCommandId("workflow.suspend", state.version, { workflowId, reason }),
      workflowId,
      scopeId: state.identity.scopeId,
      actorId: "governor",
      reason,
      timestamp: Date.now(),
    }).value;
  }

  rollbackWorkflow(workflowId: string, revisionId: string, approvalId?: string) {
    return this.rollback(workflowId, revisionId, approvalId);
  }

  rollback(workflowId: string, revisionId: string, approvalId?: string) {
    const approval = this.approvals.requireApproval(approvalId, {
      action: "workflow.activate",
      workflowId,
      revisionId,
      targetKind: "workflow_revision",
      targetId: revisionId,
    });
    return this.approvals.dispatch(
      approval,
      approval.decidedBy || "approved_governor",
      "human-approved workflow rollback",
    ).value;
  }

  forgetWorkflow(workflowId: string, reason?: string, gracePeriodMs?: number) {
    return this.forget(workflowId, reason, gracePeriodMs);
  }

  forget(workflowId: string, reason = "user_requested", gracePeriodMs = 2_592_000_000) {
    const state = this.reader.getState(workflowId);
    if (!state) return false;
    const normalizedGracePeriodMs = Math.max(0, gracePeriodMs);
    this.governance.forget({
      commandId: this.ownedCommandId("workflow.forget", state.version, {
        workflowId,
        reason,
        gracePeriodMs: normalizedGracePeriodMs,
      }),
      workflowId,
      scopeId: state.identity.scopeId,
      actorId: "user",
      reason,
      timestamp: Date.now(),
      gracePeriodMs: normalizedGracePeriodMs,
    });
    return true;
  }

  restoreWorkflow(workflowId: string) {
    return this.restore(workflowId);
  }

  restore(workflowId: string) {
    const state = this.requireState(workflowId);
    return this.governance.restore({
      commandId: this.ownedCommandId("workflow.restore", state.version, { workflowId }),
      workflowId,
      scopeId: state.identity.scopeId,
      actorId: "user",
      reason: "restore within grace period",
      timestamp: Date.now(),
    }).value;
  }

  applyWorkflowProposal(proposalId: string, actor: string, approvalId?: string) {
    return this.apply(proposalId, actor, approvalId);
  }

  apply(proposalId: string, actor: string, approvalId?: string) {
    const approval = this.approvals.requireApproval(approvalId, {
      action: "workflow.revision.apply",
      proposalId,
      targetKind: "workflow_proposal",
      targetId: proposalId,
    });
    return this.approvals.dispatch(approval, actor).value;
  }

  promoteWorkflow(
    workflowId: string,
    revisionId: string,
    canaryPercent?: number,
    maxFailureDelta?: number,
    approvalId?: string,
  ) {
    return this.promote(
      workflowId,
      revisionId,
      canaryPercent,
      maxFailureDelta,
      approvalId,
    );
  }

  promote(
    workflowId: string,
    revisionId: string,
    canaryPercent?: number,
    maxFailureDelta?: number,
    approvalId?: string,
  ) {
    const approval = this.approvals.requireApproval(approvalId, {
      action: "workflow.canary.start",
      workflowId,
      revisionId,
      targetKind: "workflow_revision",
      targetId: revisionId,
    });
    const impact = this.approvals.canaryPolicy(approval);
    if (canaryPercent !== undefined && canaryPercent !== impact.canaryPercent) {
      throw new Error("Approval does not authorize this canary percentage");
    }
    if (maxFailureDelta !== undefined && maxFailureDelta !== impact.maxFailureDelta) {
      throw new Error("Approval does not authorize this canary failure threshold");
    }
    return this.approvals.dispatch(approval, approval.decidedBy || "approved_governor").value;
  }

  executeAutonomyApproval(approvalId: string, actor: string) {
    const approval = this.approvals.requireApproval(approvalId);
    const result = this.approvals.dispatch(approval, actor).value;
    return { approval, result };
  }

  async updateLearningSettings(input: LearningSettingsUpdate): Promise<LearningFeatureState> {
    const learningControl = this.learningControl;
    if (!learningControl) throw new Error("Learning feature control is unavailable");
    const current = learningControl.snapshot();
    const policy = this.normalizeLearningPolicy(current, input);
    const reason = input.reason ?? "runtime_feature_update";
    const timestamp = Date.now();
    this.governance.updateFeaturePolicy({
      commandId: deterministicGovernanceId("learning-feature-policy", {
        previousUpdatedAt: current.updatedAt,
        policy,
        reason,
      }),
      target: { kind: "global" },
      actorId: "learning_settings_admin",
      reason,
      timestamp,
      policy: {
        memoryEnabled: policy.memoryEnabled,
        learningEnabled: policy.learningEnabled,
        autoExecutionEnabled: policy.autoExecutionEnabled,
      },
    });
    return learningControl.refresh();
  }

  private requireState(workflowId: string) {
    const state = this.reader.getState(workflowId);
    if (!state) throw new Error("Workflow not found");
    return state;
  }

  private ownedCommandId(action: string, version: number, input: unknown): string {
    return deterministicGovernanceId("workflow-governance", { action, version, input });
  }

  private normalizeLearningPolicy(
    current: LearningFeatureState,
    input: LearningSettingsUpdate,
  ): Pick<LearningFeatureState, "memoryEnabled" | "learningEnabled" | "autoExecutionEnabled"> {
    for (const field of ["memoryEnabled", "learningEnabled", "autoExecutionEnabled"] as const) {
      if (input[field] !== undefined && typeof input[field] !== "boolean") {
        throw new TypeError(`${field} must be boolean`);
      }
    }
    if (input.reason !== undefined && (typeof input.reason !== "string" || !input.reason.trim())) {
      throw new TypeError("Learning settings reason must be a non-empty string");
    }
    if (input.memoryEnabled === true && !current.memoryAvailable) {
      throw new Error("Memory is not configured and cannot be enabled at runtime");
    }
    const memoryEnabled = current.memoryAvailable
      && (input.memoryEnabled ?? current.memoryEnabled);
    const requestedLearning = input.learningEnabled ?? current.learningEnabled;
    const requestedAutoExecution = input.autoExecutionEnabled ?? current.autoExecutionEnabled;
    if (!memoryEnabled && input.learningEnabled === true) {
      throw new Error("Learning requires Memory to be enabled");
    }
    if ((!memoryEnabled || !requestedLearning) && input.autoExecutionEnabled === true) {
      throw new Error("Learning automatic execution requires Memory and Learning to be enabled");
    }
    const learningEnabled = memoryEnabled && requestedLearning;
    return {
      memoryEnabled,
      learningEnabled,
      autoExecutionEnabled: learningEnabled && requestedAutoExecution,
    };
  }
}
