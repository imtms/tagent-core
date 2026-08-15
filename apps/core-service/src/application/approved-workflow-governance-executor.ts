import { createHash } from "node:crypto";
import type { WorkflowGovernanceApplication } from "@tagent/governance/application";
import type {
  WorkflowExecutableApprovalView,
  WorkflowGovernanceEffectResult,
} from "@tagent/governance/domain";
import type { WorkflowGovernanceReaderRepository } from "@tagent/governance/ports";

type ApprovedAction = WorkflowExecutableApprovalView["action"];

export interface ApprovalExpectation {
  action: ApprovedAction;
  workflowId?: string;
  revisionId?: string;
  proposalId?: string;
  targetKind: "workflow_revision" | "workflow_proposal";
  targetId?: string;
}

export function deterministicGovernanceId(prefix: string, value: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
  return `${prefix}:${digest}`;
}

function requiredText(value: string | null, field: string): string {
  if (!value?.trim()) throw new Error(`${field} is required`);
  return value;
}

function approvalImpact(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // The approval is rejected below with one stable application-boundary error.
  }
  throw new Error("Workflow approval impact is invalid");
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} is invalid`);
  }
  return value;
}

/** Reads canonical approvals and is the sole translator into approved Governance commands. */
export class ApprovedWorkflowGovernanceExecutor {
  constructor(
    private readonly governance: WorkflowGovernanceApplication,
    private readonly reader: WorkflowGovernanceReaderRepository,
  ) {}

  requireApproval(
    approvalId: string | undefined,
    expectation?: ApprovalExpectation,
  ): WorkflowExecutableApprovalView {
    if (!approvalId?.trim()) {
      throw new Error("Human approval is required before workflow governance execution");
    }
    const approval = this.reader.getExecutableApproval(approvalId);
    if (!approval || (approval.status !== "approved" && approval.status !== "executed")) {
      throw new Error("Approved request is required before execution");
    }
    if (approval.status === "approved" && approval.expiresAt !== null && approval.expiresAt <= Date.now()) {
      throw new Error("Approval request has expired");
    }
    if (approval.ref.source !== "workflow") {
      throw new Error("Workflow Governance preserves workflow approval authority");
    }
    const exhausted = approval.status === "approved" && (approval.reuse.usedCount < 0
      || (approval.reuse.mode === "one_time" && approval.reuse.usedCount > 0)
      || (approval.reuse.maxUses !== null
        && approval.reuse.usedCount >= approval.reuse.maxUses));
    if (exhausted) throw new Error("Approval reuse has been exhausted");
    if (approval.status === "executed" && !approval.execution) {
      throw new Error("Executed approval is missing its committed replay identity");
    }
    this.validateTarget(approval, expectation ?? {
      action: approval.action,
      workflowId: approval.workflowId,
      revisionId: approval.revisionId ?? undefined,
      proposalId: approval.proposalId ?? undefined,
      targetKind: approval.action === "workflow.revision.apply"
        ? "workflow_proposal"
        : "workflow_revision",
      targetId: approval.action === "workflow.revision.apply"
        ? approval.proposalId ?? undefined
        : approval.revisionId ?? undefined,
    });
    return approval;
  }

  dispatch(
    approval: WorkflowExecutableApprovalView,
    actorId: string,
    reason = `execute approved ${approval.action}`,
  ): WorkflowGovernanceEffectResult {
    const deterministicCommandId = deterministicGovernanceId("workflow-governance", {
      source: approval.ref.source,
      approvalId: approval.ref.id,
      operationDigest: approval.operationDigest,
      action: approval.action,
    });
    const replay = approval.execution;
    if (replay && replay.commandId !== deterministicCommandId) {
      throw new Error("Executed approval command identity is invalid");
    }
    const common = {
      commandId: replay?.commandId ?? deterministicCommandId,
      workflowId: approval.workflowId,
      scopeId: approval.scope.id,
      actorId: replay?.actorId ?? requiredText(actorId, "Workflow Governance actor"),
      reason: replay?.reason ?? reason,
      timestamp: replay?.timestamp ?? Date.now(),
      approval: {
        ref: approval.ref,
        action: approval.action,
        operationDigest: approval.operationDigest,
        risk: approval.risk,
      },
    };
    switch (approval.action) {
      case "workflow.activate":
        return this.governance.activate({
          ...common,
          approval: { ...common.approval, action: "workflow.activate" },
          revisionId: requiredText(approval.revisionId, "Workflow approval revisionId"),
        });
      case "workflow.revision.apply":
        return this.governance.applyProposal({
          ...common,
          approval: { ...common.approval, action: "workflow.revision.apply" },
          proposalId: requiredText(approval.proposalId, "Workflow approval proposalId"),
          revisionId: deterministicGovernanceId("workflow-revision", {
            approvalId: approval.ref.id,
            operationDigest: approval.operationDigest,
            proposalId: approval.proposalId,
          }),
        });
      case "workflow.canary.start": {
        const impact = this.canaryPolicy(approval);
        return this.governance.promote({
          ...common,
          approval: { ...common.approval, action: "workflow.canary.start" },
          revisionId: requiredText(approval.revisionId, "Workflow approval revisionId"),
          previousRevisionId: impact.previousRevisionId,
          canaryPercent: impact.canaryPercent,
          maxFailureDelta: impact.maxFailureDelta,
        });
      }
    }
  }

  canaryPolicy(approval: WorkflowExecutableApprovalView) {
    const impact = approvalImpact(approval.impactJson);
    const state = this.reader.getState(approval.workflowId);
    if (!state) throw new Error("Workflow not found");
    const previousRevisionId = requiredText(
      typeof impact.baselineRevisionId === "string"
        ? impact.baselineRevisionId
        : state.activeRevisionId,
      "Workflow canary baseline revisionId",
    );
    if (approval.status !== "executed" && state.activeRevisionId !== previousRevisionId) {
      throw new Error("Workflow canary baseline revision is stale");
    }
    return {
      previousRevisionId,
      canaryPercent: requiredNumber(impact.canaryPercent, "Workflow canary percentage"),
      maxFailureDelta: requiredNumber(impact.maxFailureDelta, "Workflow canary failure threshold"),
    };
  }

  private validateTarget(
    approval: WorkflowExecutableApprovalView,
    expectation: ApprovalExpectation,
  ): void {
    const targetId = expectation.targetId
      ?? (expectation.action === "workflow.revision.apply"
        ? approval.proposalId
        : approval.revisionId);
    if (approval.action !== expectation.action
      || (expectation.workflowId !== undefined && approval.workflowId !== expectation.workflowId)
      || (expectation.revisionId !== undefined && approval.revisionId !== expectation.revisionId)
      || (expectation.proposalId !== undefined && approval.proposalId !== expectation.proposalId)
      || approval.target.kind !== expectation.targetKind
      || !targetId
      || approval.target.id !== targetId) {
      throw new Error("Approval action or target does not match the requested workflow effect");
    }
  }
}
