import { createHash, createHmac } from "node:crypto";
import type Database from "better-sqlite3";
import {
  buildLegacyWorkflowExecutedReceipt,
  mapLegacyWorkflowApprovalOperation,
} from "./canonical-approval-mapper.js";
import {
  canaryOutcomeDigest,
  stableJson,
  type ApprovedWorkflowGovernanceCommit,
  type MaterializedWorkflowRevision,
  type OwnedWorkflowGovernanceCommit,
  type WorkflowCanaryDecisionEvidence,
  type WorkflowCanaryPromotionCandidateView,
  type WorkflowExecutableApprovalView,
  type WorkflowGovernanceEffectResult,
  type WorkflowGovernanceMutationRepository,
  type WorkflowGovernanceProposalView,
  type WorkflowGovernanceReaderRepository,
  type WorkflowGovernanceReceipt,
  type WorkflowGovernanceRevisionView,
  type WorkflowGovernanceState,
} from "@tagent/governance";

interface WorkflowRow {
  workflowId: string;
  scopeId: string;
  status: WorkflowGovernanceState["status"];
  activeRevisionId: string | null;
  previousStatus: WorkflowGovernanceState["status"] | null;
  deletedAt: number | null;
  purgeAfter: number | null;
  updatedAt: number;
}

interface ApprovalRow {
  id: string;
  scopeId: string;
  actionType: string;
  targetType: string;
  targetId: string;
  workflowId: string | null;
  revisionId: string | null;
  proposalId: string | null;
  bindingId: string | null;
  status: string;
  riskClass: string;
  impactScopeJson: string;
  diffJson: string;
  rollbackJson: string;
  expiresAt: number;
  operationDigest: string | null;
  reuseMode: string | null;
  maxUses: number | null;
  usedCount: number | null;
  decidedBy: string;
  executedAt: number | null;
  executionReceiptJson: string;
}

interface RevisionDraftValue {
  specJson: string;
  specHash: string;
  sourceType: string;
  sourceEvidenceJson: string;
  confidence: number;
  changeSummary: string;
  createdAt: number;
}

function detached<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function proposalPatchHash(patchJson: string): string {
  const patch: unknown = JSON.parse(patchJson || "{}");
  if (!patch || Array.isArray(patch) || typeof patch !== "object" || Object.keys(patch).length === 0) {
    throw new Error("Workflow proposal patch must be a non-empty JSON object");
  }
  return createHash("sha256").update(stableJson(patch)).digest("hex");
}

function executedApprovalMetadata(
  row: ApprovalRow,
  approvalReceipt: WorkflowGovernanceReceipt | undefined,
  action: WorkflowExecutableApprovalView["action"],
): WorkflowExecutableApprovalView["execution"] | undefined {
  if (row.status !== "executed") return null;
  try {
    const value = JSON.parse(row.executionReceiptJson) as {
      actionType?: unknown;
      targetId?: unknown;
      executedBy?: unknown;
      executedAt?: unknown;
      commandId?: unknown;
      governanceReceipt?: unknown;
    };
    const receipt = value.governanceReceipt as WorkflowGovernanceReceipt | undefined;
    if (!receipt
      || stableJson(receipt) !== stableJson(approvalReceipt)
      || receipt.kind !== "approval"
      || receipt.action !== action
      || receipt.workflowId !== row.workflowId
      || receipt.detail.scopeId !== row.scopeId
      || receipt.detail.approvalSource !== "legacy_workflow"
      || receipt.detail.approvalId !== row.id
      || receipt.detail.operationDigest !== row.operationDigest
      || receipt.detail.risk !== row.riskClass
      || value.actionType !== row.actionType
      || value.targetId !== row.targetId
      || typeof value.executedBy !== "string"
      || !value.executedBy
      || value.executedBy !== receipt.actorId
      || !Number.isSafeInteger(value.executedAt)
      || value.executedAt !== row.executedAt
      || value.executedAt !== receipt.committedAt
      || value.executedAt >= row.expiresAt
      || typeof value.commandId !== "string"
      || !value.commandId
      || value.commandId !== receipt.commandId
      || receipt.id !== `workflow-governance:${value.commandId}:approval`
      || typeof receipt.detail.reason !== "string") {
      return undefined;
    }
    return {
      commandId: value.commandId,
      actorId: value.executedBy,
      reason: receipt.detail.reason,
      timestamp: value.executedAt,
    };
  } catch {
    return undefined;
  }
}

function evaluationReceiptSecurity(input: {
  id: string;
  workflowId: string;
  revisionId: string;
  status: string;
  sampleSize: number;
  successRate: number;
  baselineRate: number;
  datasetId: string;
  datasetHash: string;
  baselineRevisionId: string;
  candidateRevisionId: string;
  evaluationRunIds: readonly string[];
  checkResults: readonly WorkflowCanaryDecisionEvidence["checks"][number][];
  createdAt: number;
}): { receiptHash: string; signature: string } {
  const payload = {
    id: input.id,
    workflowId: input.workflowId,
    revisionId: input.revisionId,
    kind: "canary",
    status: input.status,
    sampleSize: input.sampleSize,
    successRate: input.successRate,
    baselineRate: input.baselineRate,
    riskClass: "low",
    evaluatorId: "tagent.canary-governance",
    evaluatorVersion: "1",
    datasetId: input.datasetId,
    datasetHash: input.datasetHash,
    baselineRevisionId: input.baselineRevisionId,
    candidateRevisionId: input.candidateRevisionId,
    evaluationRunIds: input.evaluationRunIds,
    checkResults: input.checkResults,
    createdAt: input.createdAt,
  };
  const receiptHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  const secret = process.env.TAGENT_EVALUATION_RECEIPT_SECRET ?? "";
  const signature = secret
    ? createHmac("sha256", secret).update(receiptHash).digest("hex")
    : receiptHash;
  return { receiptHash, signature };
}

function sortedCanaryOutcomes(evidence: WorkflowCanaryDecisionEvidence) {
  return [...evidence.outcomes].sort((left, right) => left.variant.localeCompare(right.variant)
    || left.runId.localeCompare(right.runId));
}

function sortedCanaryChecks(evidence: WorkflowCanaryDecisionEvidence) {
  return [...evidence.checks].sort((left, right) => left.runId.localeCompare(right.runId)
    || left.checkKey.localeCompare(right.checkKey));
}

function legacyAction(action: ApprovedWorkflowGovernanceCommit["command"]["action"]): string {
  if (action === "workflow.activate") return "activate_workflow";
  if (action === "workflow.revision.apply") return "apply_revision";
  return "start_canary";
}

type GovernanceCommand =
  | ApprovedWorkflowGovernanceCommit["command"]
  | OwnedWorkflowGovernanceCommit["command"];

function expectedReceipt(command: GovernanceCommand, kind: WorkflowGovernanceReceipt["kind"]): WorkflowGovernanceReceipt {
  const featurePolicy = command.action === "learning.feature_policy.update";
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
            : featurePolicy
              ? { target: command.target, policy: command.policy }
              : {};
  return {
    id: `workflow-governance:${command.commandId}:${kind}`,
    kind,
    commandId: command.commandId,
    action: command.action,
    workflowId: featurePolicy ? null : command.workflowId,
    actorId: command.actorId,
    status: "committed",
    detail: {
      scopeId: featurePolicy ? "global" : command.scopeId,
      reason: command.reason,
      ...approval,
      ...effect,
    },
    committedAt: command.timestamp,
  };
}

function requireReceipt(receipt: WorkflowGovernanceReceipt, command: GovernanceCommand, kind: WorkflowGovernanceReceipt["kind"]): void {
  if (stableJson(receipt) !== stableJson(expectedReceipt(command, kind))) {
    throw new Error(`Workflow Governance ${kind} receipt conflicts with its command`);
  }
}

function draftValue(materialized: MaterializedWorkflowRevision): RevisionDraftValue {
  const value = materialized.draft.value;
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Materialized Workflow revision draft is invalid");
  }
  const row = value as Partial<RevisionDraftValue>;
  if (typeof row.specJson !== "string"
    || row.specHash !== materialized.resultSpecHash
    || typeof row.sourceType !== "string"
    || typeof row.sourceEvidenceJson !== "string"
    || typeof row.confidence !== "number"
    || typeof row.changeSummary !== "string"
    || !Number.isSafeInteger(row.createdAt)) {
    throw new Error("Materialized Workflow revision draft fields are invalid");
  }
  return row as RevisionDraftValue;
}

export class SqliteWorkflowGovernanceRepository
implements WorkflowGovernanceReaderRepository, WorkflowGovernanceMutationRepository {
  constructor(private readonly db: Database.Database) {}

  getState(workflowId: string): WorkflowGovernanceState | undefined {
    const row = this.workflowRow(workflowId);
    return row ? this.stateFromRow(row) : undefined;
  }

  getReceipt(receiptId: string): WorkflowGovernanceReceipt | undefined {
    const governance = this.db.prepare(`SELECT metadata_json metadataJson
      FROM workflow_governance_receipts
      WHERE id=? OR json_extract(metadata_json,'$.receipts.approval.id')=?
      LIMIT 1`).get(receiptId, receiptId) as { metadataJson: string } | undefined;
    if (governance) {
      const metadata = JSON.parse(governance.metadataJson) as {
        receipt?: WorkflowGovernanceReceipt;
        receipts?: { approval?: WorkflowGovernanceReceipt };
      };
      const receipt = metadata.receipt?.id === receiptId ? metadata.receipt : metadata.receipts?.approval;
      return receipt ? detached(receipt) : undefined;
    }
    const audit = this.db.prepare(`SELECT metadata_json metadataJson FROM autonomy_audit_events
      WHERE id=? LIMIT 1`).get(receiptId) as { metadataJson: string } | undefined;
    if (!audit) return undefined;
    const metadata = JSON.parse(audit.metadataJson) as { receipt?: WorkflowGovernanceReceipt };
    return metadata.receipt ? detached(metadata.receipt) : undefined;
  }

  getApprovedProposal(proposalId: string): WorkflowGovernanceProposalView | undefined {
    const row = this.db.prepare(`SELECT id proposalId,workflow_id workflowId,base_revision_id baseRevisionId,
      base_spec_hash baseSpecHash,patch_json patchJson,
      evidence_json evidenceJson,reason,status
      FROM workflow_revision_proposals WHERE id=? AND status='approved'`).get(proposalId) as
      Omit<WorkflowGovernanceProposalView, "patchHash"> | undefined;
    if (!row) return undefined;
    return detached({ ...row, patchHash: proposalPatchHash(row.patchJson) });
  }

  getRevision(revisionId: string): WorkflowGovernanceRevisionView | undefined {
    const row = this.db.prepare(`SELECT id revisionId,workflow_id workflowId,revision,spec_hash specHash,
      spec_json specJson,source_type sourceType,source_evidence_json sourceEvidenceJson,confidence
      FROM workflow_revisions WHERE id=?`).get(revisionId) as WorkflowGovernanceRevisionView | undefined;
    return row ? detached(row) : undefined;
  }

  getExecutableApproval(approvalId: string): WorkflowExecutableApprovalView | undefined {
    const row = this.db.prepare(`SELECT id,scope_id scopeId,action_type actionType,target_type targetType,
      target_id targetId,workflow_id workflowId,revision_id revisionId,proposal_id proposalId,status,
      expires_at expiresAt,operation_digest operationDigest,risk_class riskClass,reuse_mode reuseMode,
      max_uses maxUses,used_count usedCount,decided_by decidedBy,impact_scope_json impactJson,
      impact_scope_json impactScopeJson,diff_json diffJson,rollback_json rollbackJson,binding_id bindingId,
      executed_at executedAt,execution_receipt_json executionReceiptJson
      FROM autonomy_approval_requests WHERE id=? AND status IN ('approved','executed')`).get(approvalId) as
      (ApprovalRow & { impactJson: string }) | undefined;
    if (!row || !row.operationDigest || !row.workflowId || !row.reuseMode) return undefined;
    const action = row.actionType === "activate_workflow" ? "workflow.activate"
      : row.actionType === "apply_revision" ? "workflow.revision.apply"
        : row.actionType === "start_canary" ? "workflow.canary.start" : undefined;
    if (!action) return undefined;
    const canonical = mapLegacyWorkflowApprovalOperation(row);
    if (canonical.operationDigest !== row.operationDigest) return undefined;
    if (row.status === "executed"
      && (row.reuseMode !== "one_time" || row.maxUses !== 1 || row.usedCount !== 1)) {
      return undefined;
    }
    let approvalReceiptId = "";
    if (row.status === "executed") {
      try {
        const stored = JSON.parse(row.executionReceiptJson || "{}") as { commandId?: unknown };
        if (typeof stored.commandId !== "string" || !stored.commandId) return undefined;
        approvalReceiptId = `workflow-governance:${stored.commandId}:approval`;
      } catch {
        return undefined;
      }
    }
    const execution = executedApprovalMetadata(
      row,
      approvalReceiptId ? this.getReceipt(approvalReceiptId) : undefined,
      action,
    );
    if (execution === undefined) return undefined;
    return detached({
      ref: { source: "legacy_workflow", id: row.id },
      action,
      status: row.status as WorkflowExecutableApprovalView["status"],
      expiresAt: row.expiresAt,
      target: { kind: row.targetType, id: row.targetId },
      workflowId: row.workflowId,
      revisionId: row.revisionId,
      proposalId: row.proposalId,
      scope: { type: "legacy_workflow_scope", id: row.scopeId },
      operationDigest: row.operationDigest,
      risk: row.riskClass as WorkflowExecutableApprovalView["risk"],
      reuse: {
        mode: row.reuseMode as WorkflowExecutableApprovalView["reuse"]["mode"],
        maxUses: row.maxUses,
        usedCount: row.usedCount ?? 0,
      },
      decidedBy: row.decidedBy,
      impactJson: row.impactJson,
      execution,
    });
  }

  listCanaryDecisionCandidates(limit: number): WorkflowCanaryPromotionCandidateView[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError("Workflow Canary candidate limit must be a positive safe integer");
    }
    const boundedLimit = Math.min(limit, 1_000);
    return detached(this.db.prepare(`SELECT p.id promotionId,p.workflow_id workflowId,w.scope_id scopeId,
      p.revision_id candidateRevisionId,p.previous_revision_id previousRevisionId,
      p.max_failure_delta authorizedMaxFailureDelta,p.status,p.created_at createdAt
      FROM workflow_promotions p JOIN workflow_definitions w ON w.id=p.workflow_id
      WHERE p.status='canary' AND w.status='active' AND w.deleted_at IS NULL
      AND w.active_revision_id=p.previous_revision_id
      AND (SELECT COUNT(DISTINCT baseline.run_id) FROM workflow_canary_bindings baseline
        WHERE baseline.promotion_id=p.id AND baseline.variant='baseline'
        AND baseline.outcome_recorded_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM workflow_canary_bindings newer
          WHERE newer.promotion_id=baseline.promotion_id AND newer.run_id=baseline.run_id
          AND newer.attempt>baseline.attempt))>=5
      AND (SELECT COUNT(DISTINCT candidate.run_id) FROM workflow_canary_bindings candidate
        WHERE candidate.promotion_id=p.id AND candidate.variant='candidate'
        AND candidate.outcome_recorded_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM workflow_canary_bindings newer
          WHERE newer.promotion_id=candidate.promotion_id AND newer.run_id=candidate.run_id
          AND newer.attempt>candidate.attempt))>=5
      ORDER BY p.created_at,p.id LIMIT ?`).all(boundedLimit) as
      WorkflowCanaryPromotionCandidateView[]);
  }

  getCanaryDecisionEvidence(promotionId: string): WorkflowCanaryDecisionEvidence | undefined {
    const promotion = this.db.prepare(`SELECT p.id promotionId,p.workflow_id workflowId,w.scope_id scopeId,
      p.revision_id candidateRevisionId,p.previous_revision_id previousRevisionId,
      p.max_failure_delta authorizedMaxFailureDelta,p.status,p.created_at createdAt
      FROM workflow_promotions p JOIN workflow_definitions w ON w.id=p.workflow_id
      WHERE p.id=? AND p.status='canary'`).get(promotionId) as WorkflowCanaryPromotionCandidateView | undefined;
    if (!promotion) return undefined;
    const outcomes = this.db.prepare(`SELECT run_id runId,variant,outcome_status outcomeStatus,
      success,required_checks requiredChecks,passed_checks passedChecks,outcome_recorded_at recordedAt
      FROM workflow_canary_bindings c
      WHERE c.promotion_id=? AND c.outcome_recorded_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM workflow_canary_bindings newer
        WHERE newer.promotion_id=c.promotion_id AND newer.run_id=c.run_id AND newer.attempt>c.attempt)
      ORDER BY c.outcome_recorded_at,c.id`).all(promotionId)
      .map((row) => ({
        ...(row as Omit<WorkflowCanaryDecisionEvidence["outcomes"][number], "success"> & { success: number }),
        success: Boolean((row as { success: number }).success),
      }));
    const checks = this.db.prepare(`SELECT c.run_id runId,r.check_key checkKey,
      CAST(r.required AS INTEGER) required,r.status,CAST(r.stale AS INTEGER) stale
      FROM workflow_canary_bindings c JOIN run_checks r ON r.run_id=c.run_id
      WHERE c.promotion_id=? AND c.outcome_recorded_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM workflow_canary_bindings newer
        WHERE newer.promotion_id=c.promotion_id AND newer.run_id=c.run_id AND newer.attempt>c.attempt)
      ORDER BY c.run_id,r.check_key`).all(promotionId)
      .map((row) => ({
        ...(row as Omit<WorkflowCanaryDecisionEvidence["checks"][number], "required" | "stale"> & {
          required: number; stale: number;
        }),
        required: Boolean((row as { required: number }).required),
        stale: Boolean((row as { stale: number }).stale),
      }));
    return detached({ promotion, outcomes, checks });
  }

  commitApprovedEffect(input: ApprovedWorkflowGovernanceCommit): WorkflowGovernanceEffectResult {
    if (input.receipts.kind !== "approved") {
      throw new Error("Approved Workflow Governance receipt evidence is invalid");
    }
    requireReceipt(input.receipts.approval, input.command, "approval");
    requireReceipt(input.receipts.governance, input.command, "governance");
    requireReceipt(input.receipts.audit, input.command, "audit");
    const replay = this.exactReplay(input.command.commandId, input.command);
    if (replay) return replay;
    const approval = this.requireApprovedApproval(input);
    const value = this.applyApprovedMutation(input);
    const committedState = this.requireState(input.command.workflowId);
    const state = { ...committedState, version: committedState.version + 1 };
    const result: WorkflowGovernanceEffectResult = {
      commandId: input.command.commandId,
      state,
      receipts: input.receipts,
      value,
    };
    this.consumeApproval(approval, input, result);
    this.insertGovernanceReceipt(input.receipts.governance, input.command, input.receipts, result);
    this.insertAuditReceipt(input.receipts.audit, input.command, result, approval.id);
    return detached(result);
  }

  commitOwnedEffect(input: OwnedWorkflowGovernanceCommit): WorkflowGovernanceEffectResult {
    if (input.command.action === "learning.feature_policy.update") {
      if (input.receipts.kind !== "feature_policy") {
        throw new Error("Feature policy Governance receipt evidence is invalid");
      }
      requireReceipt(input.receipts.audit, input.command, "audit");
    } else {
      if (input.receipts.kind !== "workflow_owned") {
        throw new Error("Owned Workflow Governance receipt evidence is invalid");
      }
      requireReceipt(input.receipts.governance, input.command, "governance");
      requireReceipt(input.receipts.audit, input.command, "audit");
    }
    const replay = this.exactReplay(input.command.commandId, input.command);
    if (replay) return replay;
    const value = this.applyOwnedMutation(input);
    const currentState = input.command.action === "learning.feature_policy.update"
      ? null
      : this.requireState(input.command.workflowId);
    const state = currentState ? { ...currentState, version: currentState.version + 1 } : null;
    const result: WorkflowGovernanceEffectResult = {
      commandId: input.command.commandId,
      state,
      receipts: input.receipts,
      value,
    };
    if (input.receipts.kind === "workflow_owned") {
      this.insertGovernanceReceipt(input.receipts.governance, input.command, input.receipts, result);
    }
    this.insertAuditReceipt(input.receipts.audit, input.command, result, null);
    return detached(result);
  }

  private workflowRow(workflowId: string): WorkflowRow | undefined {
    return this.db.prepare(`SELECT id workflowId,scope_id scopeId,status,active_revision_id activeRevisionId,
      previous_status previousStatus,deleted_at deletedAt,purge_after purgeAfter,updated_at updatedAt
      FROM workflow_definitions WHERE id=?`).get(workflowId) as WorkflowRow | undefined;
  }

  private stateFromRow(row: WorkflowRow): WorkflowGovernanceState {
    const version = Number((this.db.prepare(`SELECT COUNT(*) count FROM workflow_governance_receipts
      WHERE workflow_id=?`).get(row.workflowId) as { count: number }).count) + 1;
    return detached({
      identity: { workflowId: row.workflowId, scopeId: row.scopeId },
      status: row.status,
      activeRevisionId: row.activeRevisionId,
      previousStatus: row.previousStatus,
      version,
      updatedAt: row.updatedAt,
    });
  }

  private requireState(workflowId: string): WorkflowGovernanceState {
    const state = this.getState(workflowId);
    if (!state) throw new Error(`Workflow ${workflowId} was not found`);
    return state;
  }

  private exactReplay(commandId: string, command: unknown): WorkflowGovernanceEffectResult | undefined {
    const governance = this.db.prepare(`SELECT metadata_json metadataJson
      FROM workflow_governance_receipts WHERE id=?`).get(
      `workflow-governance:${commandId}:governance`,
    ) as { metadataJson: string } | undefined;
    const audit = governance ?? this.db.prepare(`SELECT metadata_json metadataJson
      FROM autonomy_audit_events WHERE id=?`).get(
      `workflow-governance:${commandId}:audit`,
    ) as { metadataJson: string } | undefined;
    if (!audit) return undefined;
    const metadata = JSON.parse(audit.metadataJson) as { command?: unknown; effectResult?: WorkflowGovernanceEffectResult };
    if (!metadata.command || stableJson(metadata.command) !== stableJson(command) || !metadata.effectResult) {
      throw new Error(`Workflow Governance command ${commandId} conflicts with a committed effect`);
    }
    return detached(metadata.effectResult);
  }

  private requireApprovedApproval(input: ApprovedWorkflowGovernanceCommit): ApprovalRow {
    const command = input.command;
    const approval = this.db.prepare(`SELECT id,scope_id scopeId,action_type actionType,target_type targetType,
      target_id targetId,workflow_id workflowId,revision_id revisionId,proposal_id proposalId,
      binding_id bindingId,status,risk_class riskClass,impact_scope_json impactScopeJson,diff_json diffJson,
      rollback_json rollbackJson,expires_at expiresAt,operation_digest operationDigest,
      reuse_mode reuseMode,max_uses maxUses,used_count usedCount
      FROM autonomy_approval_requests WHERE id=?`).get(command.approval.ref.id) as ApprovalRow | undefined;
    if (!approval || approval.status !== "approved") {
      throw new Error("Approved Workflow request is required");
    }
    const canonical = mapLegacyWorkflowApprovalOperation(approval);
    const proposalBase = command.action === "workflow.revision.apply"
      ? this.db.prepare(`SELECT base_revision_id baseRevisionId FROM workflow_revision_proposals
        WHERE id=? AND workflow_id=?`).get(command.proposalId, command.workflowId) as
        { baseRevisionId: string } | undefined
      : undefined;
    const expectedRevisionId = command.action === "workflow.revision.apply"
      ? proposalBase?.baseRevisionId
      : command.revisionId;
    const expectedProposalId = command.action === "workflow.revision.apply" ? command.proposalId : null;
    const canaryImpact = command.action === "workflow.canary.start"
      ? JSON.parse(approval.impactScopeJson) as {
          canaryPercent?: number;
          maxFailureDelta?: number;
          baselineRevisionId?: string;
        }
      : null;
    if (approval.actionType !== legacyAction(command.action)
      || approval.workflowId !== command.workflowId
      || approval.scopeId !== command.scopeId
      || approval.revisionId !== expectedRevisionId
      || approval.proposalId !== expectedProposalId
      || approval.riskClass !== command.approval.risk
      || approval.operationDigest !== canonical.operationDigest
      || approval.operationDigest !== command.approval.operationDigest
      || approval.expiresAt <= command.timestamp
      || approval.reuseMode !== "one_time"
      || approval.maxUses !== 1
      || approval.usedCount !== 0
      || command.action === "workflow.canary.start" && (
        canaryImpact?.canaryPercent !== command.canaryPercent
        || canaryImpact.maxFailureDelta !== command.maxFailureDelta
        || canaryImpact.baselineRevisionId !== command.previousRevisionId
      )) {
      throw new Error(`Canonical Workflow approval conflict for ${approval.id}`);
    }
    return approval;
  }

  private applyApprovedMutation(input: ApprovedWorkflowGovernanceCommit): unknown {
    const command = input.command;
    if (command.action === "workflow.activate") {
      this.requireRevision(command.workflowId, command.revisionId);
      const changed = this.db.prepare(`UPDATE workflow_definitions
        SET status='active',active_revision_id=?,updated_at=?
        WHERE id=? AND scope_id=? AND deleted_at IS NULL`).run(
        command.revisionId, command.timestamp, command.workflowId, command.scopeId,
      ).changes;
      if (changed !== 1) throw new Error("Workflow activation target is unavailable");
      return { workflowId: command.workflowId, revisionId: command.revisionId, status: "active" };
    }
    if (command.action === "workflow.revision.apply") {
      const materialized = input.materializedRevision;
      if (!materialized) throw new Error("Workflow revision materialization is required");
      const proposal = this.getApprovedProposal(command.proposalId);
      if (!proposal || proposal.workflowId !== command.workflowId
        || materialized.proposalId !== proposal.proposalId
        || materialized.baseRevisionId !== proposal.baseRevisionId
        || materialized.baseSpecHash !== proposal.baseSpecHash
        || materialized.proposalPatchHash !== proposal.patchHash) {
        throw new Error("Approved Workflow proposal changed before commit");
      }
      const latest = this.db.prepare(`SELECT id FROM workflow_revisions
        WHERE workflow_id=? ORDER BY revision DESC LIMIT 1`).get(command.workflowId) as { id: string } | undefined;
      if (latest?.id !== proposal.baseRevisionId) throw new Error("Workflow proposal base revision is stale");
      const value = draftValue(materialized);
      const proposalHashes = this.db.prepare(`SELECT proposed_spec_hash proposedSpecHash
        FROM workflow_revision_proposals WHERE id=?`).get(command.proposalId) as
        { proposedSpecHash: string } | undefined;
      if (!proposalHashes || proposalHashes.proposedSpecHash !== materialized.resultSpecHash) {
        throw new Error("Approved Workflow proposal result hash changed before commit");
      }
      const ordinal = Number((this.db.prepare(`SELECT COALESCE(MAX(revision),0) revision
        FROM workflow_revisions WHERE workflow_id=?`).get(command.workflowId) as { revision: number }).revision) + 1;
      this.db.prepare(`INSERT INTO workflow_revisions
        (id,workflow_id,revision,spec_json,spec_hash,source_type,source_evidence_json,confidence,change_summary,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
        command.revisionId, command.workflowId, ordinal, value.specJson, value.specHash,
        value.sourceType, value.sourceEvidenceJson, value.confidence, value.changeSummary, value.createdAt,
      );
      const changed = this.db.prepare(`UPDATE workflow_revision_proposals
        SET status='applied',applied_revision_id=?,decided_by=?,decided_at=?
        WHERE id=? AND workflow_id=? AND status='approved' AND applied_revision_id IS NULL`).run(
        command.revisionId, command.actorId, command.timestamp, command.proposalId, command.workflowId,
      ).changes;
      if (changed !== 1) throw new Error("Approved Workflow proposal changed during commit");
      return { workflowId: command.workflowId, proposalId: command.proposalId,
        revisionId: command.revisionId, revision: ordinal };
    }
    this.requireRevision(command.workflowId, command.revisionId);
    this.requireRevision(command.workflowId, command.previousRevisionId);
    const promotionId = `workflow-promotion:${command.commandId}`;
    this.db.prepare(`INSERT INTO workflow_promotions
      (id,workflow_id,revision_id,previous_revision_id,status,canary_percent,max_failure_delta,reason,created_at,updated_at)
      VALUES (?,?,?,?,'canary',?,?,?,?,?)`).run(
      promotionId, command.workflowId, command.revisionId, command.previousRevisionId,
      command.canaryPercent, command.maxFailureDelta, command.reason, command.timestamp, command.timestamp,
    );
    return { id: promotionId, status: "canary", workflowId: command.workflowId, revisionId: command.revisionId };
  }

  private applyOwnedMutation(input: OwnedWorkflowGovernanceCommit): unknown {
    const command = input.command;
    if (command.action === "learning.feature_policy.update") {
      this.db.prepare(`INSERT INTO learning_feature_settings
        (id,memory_enabled,learning_enabled,auto_execution_enabled,updated_at,reason)
        VALUES (1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        memory_enabled=excluded.memory_enabled,learning_enabled=excluded.learning_enabled,
        auto_execution_enabled=excluded.auto_execution_enabled,updated_at=excluded.updated_at,reason=excluded.reason`).run(
        Number(command.policy.memoryEnabled), Number(command.policy.learningEnabled),
        Number(command.policy.autoExecutionEnabled), command.timestamp, command.reason,
      );
      return detached(command.policy);
    }
    const current = this.workflowRow(command.workflowId);
    if (!current || current.scopeId !== command.scopeId) throw new Error("Workflow Governance target was not found");
    if (command.action === "workflow.suspend") {
      this.recordStatusHistory(current, "suspended", command.reason, command.commandId, command.timestamp);
      const changed = this.db.prepare(`UPDATE workflow_definitions SET status='suspended',active_revision_id=NULL,updated_at=?
        WHERE id=? AND scope_id=? AND deleted_at IS NULL`).run(command.timestamp, command.workflowId, command.scopeId);
      if (changed.changes !== 1) throw new Error("Workflow is unavailable for suspension");
      this.db.prepare(`UPDATE workflow_promotions SET status='rejected',reason=?,updated_at=?
        WHERE workflow_id=? AND status='canary'`).run(
        `cancelled by workflow suspension: ${command.reason}`, command.timestamp, command.workflowId,
      );
      return { workflowId: command.workflowId, status: "suspended" };
    }
    if (command.action === "workflow.forget") {
      const changed = this.db.prepare(`UPDATE workflow_definitions SET status='deprecated',active_revision_id=NULL,
        deleted_at=?,purge_after=?,delete_reason=?,previous_status=?,previous_active_revision_id=?,updated_at=?
        WHERE id=? AND scope_id=? AND deleted_at IS NULL`).run(
        command.timestamp, command.timestamp + Math.max(0, command.gracePeriodMs), command.reason,
        current.status, current.activeRevisionId, command.timestamp, command.workflowId, command.scopeId,
      ).changes;
      if (changed !== 1) throw new Error("Workflow is already forgotten");
      this.db.prepare(`UPDATE workflow_promotions SET status='rejected',reason=?,updated_at=?
        WHERE workflow_id=? AND status='canary'`).run(
        `cancelled by workflow forget: ${command.reason}`, command.timestamp, command.workflowId,
      );
      return { workflowId: command.workflowId, status: "deprecated",
        purgeAfter: command.timestamp + Math.max(0, command.gracePeriodMs) };
    }
    if (command.action === "workflow.restore") {
      if (current.deletedAt === null || (current.purgeAfter !== null && current.purgeAfter < command.timestamp)) {
        throw new Error("Workflow is not restorable");
      }
      this.db.prepare(`UPDATE workflow_definitions SET status='suspended',active_revision_id=NULL,
        deleted_at=NULL,purge_after=NULL,delete_reason='',previous_status=NULL,previous_active_revision_id=NULL,updated_at=?
        WHERE id=? AND scope_id=? AND deleted_at IS NOT NULL`).run(
        command.timestamp, command.workflowId, command.scopeId,
      );
      return { workflowId: command.workflowId, status: "suspended" };
    }
    const promotion = this.db.prepare(`SELECT workflow_id workflowId,revision_id revisionId,
      previous_revision_id previousRevisionId,max_failure_delta maxFailureDelta,status
      FROM workflow_promotions WHERE id=?`).get(
      command.promotionId,
    ) as { workflowId: string; revisionId: string; previousRevisionId: string;
      maxFailureDelta: number; status: string } | undefined;
    const expectedRevision = command.outcome === "promoted" ? promotion?.revisionId : promotion?.previousRevisionId;
    const evidence = this.getCanaryDecisionEvidence(command.promotionId);
    const expectedOutcomes = evidence ? sortedCanaryOutcomes(evidence) : [];
    const expectedChecks = evidence ? sortedCanaryChecks(evidence) : [];
    const baseline = expectedOutcomes.filter((outcome) => outcome.variant === "baseline");
    const candidate = expectedOutcomes.filter((outcome) => outcome.variant === "candidate");
    const successRate = (rows: typeof expectedOutcomes) => rows.length
      ? rows.filter((outcome) => outcome.success).length / rows.length
      : 0;
    const baselineRate = successRate(baseline);
    const candidateRate = successRate(candidate);
    const expectedOutcome = candidateRate >= baselineRate - (promotion?.maxFailureDelta ?? 0)
      ? "promoted" : "rolled_back";
    const evaluation = command.evaluationReceipt;
    const durableOutcomesValid = expectedOutcomes.length === new Set(
      expectedOutcomes.map((outcome) => outcome.runId),
    ).size && expectedOutcomes.every((outcome) => Number.isSafeInteger(outcome.recordedAt)
      && outcome.recordedAt >= 0
      && Number.isSafeInteger(outcome.requiredChecks)
      && Number.isSafeInteger(outcome.passedChecks)
      && outcome.requiredChecks >= 0
      && outcome.passedChecks >= 0
      && outcome.passedChecks <= outcome.requiredChecks
      && outcome.success === (outcome.outcomeStatus === "completed"
        && outcome.requiredChecks > 0
        && outcome.passedChecks === outcome.requiredChecks));
    const expectedEvaluatedAt = evidence
      ? Math.max(evidence.promotion.createdAt, ...expectedOutcomes.map((outcome) => outcome.recordedAt))
      : -1;
    if (!promotion || promotion.workflowId !== command.workflowId || promotion.status !== "canary"
      || expectedRevision !== command.activeRevisionId
      || !evidence
      || evidence.promotion.scopeId !== command.scopeId
      || current.status !== "active"
      || current.deletedAt !== null
      || current.activeRevisionId !== promotion.previousRevisionId
      || !durableOutcomesValid
      || baseline.length < 5
      || candidate.length < 5
      || !Number.isFinite(promotion.maxFailureDelta)
      || promotion.maxFailureDelta < 0
      || promotion.maxFailureDelta > 1
      || canaryOutcomeDigest(evidence) !== evaluation.outcomeDigest
      || evaluation.promotionId !== command.promotionId
      || evaluation.outcome !== command.outcome
      || expectedOutcome !== command.outcome
      || evaluation.baselineSampleSize !== baseline.length
      || evaluation.candidateSampleSize !== candidate.length
      || evaluation.baselineSuccessRate !== baselineRate
      || evaluation.candidateSuccessRate !== candidateRate
      || evaluation.authorizedMaxFailureDelta !== promotion.maxFailureDelta
      || evaluation.evaluatedAt !== expectedEvaluatedAt
      || command.timestamp !== expectedEvaluatedAt
      || stableJson(evaluation.outcomes) !== stableJson(expectedOutcomes)
      || stableJson(evaluation.checkResults) !== stableJson(expectedChecks)
      || stableJson(evaluation.evaluationRunIds) !== stableJson(expectedOutcomes.map((item) => item.runId))) {
      throw new Error("Workflow Canary settlement evidence conflicts with the active promotion");
    }
    const evaluationStatus = command.outcome === "promoted" ? "passed" : "rolled_back";
    const evaluationDatasetId = `canary:${command.promotionId}`;
    const security = evaluationReceiptSecurity({
      id: evaluation.id,
      workflowId: command.workflowId,
      revisionId: promotion.revisionId,
      status: evaluationStatus,
      sampleSize: evaluation.candidateSampleSize,
      successRate: evaluation.candidateSuccessRate,
      baselineRate: evaluation.baselineSuccessRate,
      datasetId: evaluationDatasetId,
      datasetHash: evaluation.outcomeDigest,
      baselineRevisionId: promotion.previousRevisionId,
      candidateRevisionId: promotion.revisionId,
      evaluationRunIds: evaluation.evaluationRunIds,
      checkResults: evaluation.checkResults,
      createdAt: evaluation.evaluatedAt,
    });
    const workflowChanged = this.db.prepare(`UPDATE workflow_definitions
      SET status='active',active_revision_id=?,updated_at=?
      WHERE id=? AND scope_id=? AND status='active' AND active_revision_id=? AND deleted_at IS NULL`).run(
      command.activeRevisionId, command.timestamp, command.workflowId, command.scopeId,
      promotion.previousRevisionId,
    ).changes;
    if (workflowChanged !== 1) throw new Error("Workflow Canary baseline changed before settlement");
    const promotionChanged = this.db.prepare(`UPDATE workflow_promotions SET status=?,reason=?,updated_at=?
      WHERE id=? AND workflow_id=? AND status='canary'`).run(
      command.outcome, command.reason, command.timestamp, command.promotionId, command.workflowId,
    ).changes;
    if (promotionChanged !== 1) throw new Error("Workflow Canary promotion changed before settlement");
    this.db.prepare(`INSERT INTO workflow_evaluations
      (id,workflow_id,revision_id,kind,status,sample_size,success_rate,baseline_rate,risk_class,evidence_json,
       evaluator_id,evaluator_version,dataset_id,dataset_hash,baseline_revision_id,candidate_revision_id,
       evaluation_run_ids_json,check_results_json,receipt_hash,signature,created_at)
      VALUES (?,?,?,'canary',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      evaluation.id, command.workflowId, promotion.revisionId,
      evaluationStatus, evaluation.candidateSampleSize,
      evaluation.candidateSuccessRate, evaluation.baselineSuccessRate, "low", stableJson(evaluation),
      "tagent.canary-governance", "1", evaluationDatasetId, evaluation.outcomeDigest,
      promotion.previousRevisionId, promotion.revisionId, JSON.stringify(evaluation.evaluationRunIds),
      JSON.stringify(evaluation.checkResults), security.receiptHash,
      security.signature, evaluation.evaluatedAt,
    );
    return { promotionId: command.promotionId, status: command.outcome,
      activeRevisionId: command.activeRevisionId };
  }

  private requireRevision(workflowId: string, revisionId: string): void {
    const row = this.db.prepare(`SELECT 1 present FROM workflow_revisions
      WHERE id=? AND workflow_id=?`).get(revisionId, workflowId);
    if (!row) throw new Error(`Workflow revision ${revisionId} was not found`);
  }

  private recordStatusHistory(
    current: WorkflowRow,
    status: WorkflowGovernanceState["status"],
    reason: string,
    commandId: string,
    timestamp: number,
  ): void {
    this.db.prepare(`INSERT INTO workflow_status_history
      (id,workflow_id,previous_status,next_status,reason,created_at) VALUES (?,?,?,?,?,?)`).run(
      `workflow-status:${commandId}`, current.workflowId, current.status, status, reason, timestamp,
    );
  }

  private consumeApproval(
    approval: ApprovalRow,
    input: ApprovedWorkflowGovernanceCommit,
    result: WorkflowGovernanceEffectResult,
  ): void {
    const command = input.command;
    const details = stableJson({
      actionType: approval.actionType,
      targetId: approval.targetId,
      result: result.value,
      executedBy: command.actorId,
      executedAt: command.timestamp,
      commandId: command.commandId,
      governanceReceipt: input.receipts.approval,
    });
    const canonical = buildLegacyWorkflowExecutedReceipt({
      approvalId: approval.id,
      actionType: approval.actionType,
      targetId: approval.targetId,
      operationDigest: command.approval.operationDigest,
      executedAt: command.timestamp,
      receiptJson: details,
    });
    const changed = this.db.prepare(`UPDATE autonomy_approval_requests
      SET status='executed',executed_at=?,execution_receipt_json=?,updated_at=?,used_count=1
      WHERE id=? AND status='approved' AND operation_digest=? AND reuse_mode='one_time'
        AND max_uses=1 AND used_count=0`).run(
      command.timestamp, details, command.timestamp, approval.id, command.approval.operationDigest,
    ).changes;
    if (changed !== 1) throw new Error(`Canonical Workflow approval conflict while consuming ${approval.id}`);
    this.db.prepare(`INSERT INTO approval_receipts
      (id,approval_source,approval_id,operation_id,operation_digest,outcome,actor_id,details_json,created_at)
      VALUES (@id,@approval_source,@approval_id,@operation_id,@operation_digest,@outcome,@actor_id,@details_json,@created_at)`)
      .run(canonical);
  }

  private insertGovernanceReceipt(
    receipt: WorkflowGovernanceReceipt,
    command: unknown,
    receipts: unknown,
    effectResult: WorkflowGovernanceEffectResult,
  ): void {
    if (!receipt.workflowId) throw new Error("Workflow Governance receipt requires workflowId");
    this.db.prepare(`INSERT INTO workflow_governance_receipts
      (id,workflow_id,action,actor,reason,metadata_json,created_at) VALUES (?,?,?,?,?,?,?)`).run(
      receipt.id, receipt.workflowId, receipt.action, receipt.actorId,
      String(receipt.detail.reason ?? ""), stableJson({ receipt, receipts, command, effectResult }), receipt.committedAt,
    );
  }

  private insertAuditReceipt(
    receipt: WorkflowGovernanceReceipt,
    command: ApprovedWorkflowGovernanceCommit["command"] | OwnedWorkflowGovernanceCommit["command"],
    effectResult: WorkflowGovernanceEffectResult,
    approvalId: string | null,
  ): void {
    const revisionId = "revisionId" in command ? command.revisionId
      : command.action === "workflow.canary.settle" ? command.activeRevisionId : null;
    const featurePolicy = command.action === "learning.feature_policy.update";
    this.db.prepare(`INSERT INTO autonomy_audit_events
      (id,scope_id,category,action,actor,source_run_id,workflow_id,revision_id,approval_id,
       evidence_json,metadata_json,receipt_hash,created_at)
      VALUES (?,?,?,?,?,NULL,?,?,?,?,?,?,?)`).run(
      receipt.id, featurePolicy ? "global" : command.scopeId,
      "execute", command.action,
      command.actorId, featurePolicy ? null : command.workflowId, revisionId, approvalId, "[]",
      stableJson({ receipt, command, effectResult }), sha256(receipt), receipt.committedAt,
    );
  }
}
