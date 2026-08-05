import type Database from "better-sqlite3";
import type { AutonomyApprovalRequest } from "@tagent/learning/domain";
import {
  LEGACY_WORKFLOW_APPROVAL_SCOPE_TYPE,
  LEGACY_RUN_APPROVAL_DEFAULTS,
  RUN_APPROVAL_SCOPE_TYPE,
  canonicalApprovalActionForSource,
  canonicalApprovalStatus,
  stableJson,
  type Approval,
  type ApprovalProjection,
  type ApprovalProjectionReason,
  type ApprovalReadQuery,
  type ApprovalRef,
  type ApprovalShadowComparison,
  type ApprovalShadowExpectation,
  type ApprovalUnresolvedPageQuery,
  type ApprovalUnresolvedSummary,
  type CanonicalApprovalReadPort,
  type CanonicalApprovalShadowPort,
  type CanonicalJsonValue,
} from "@tagent/governance";
import type { ApprovalRequest } from "@tagent/governance/domain";
import {
  buildLegacyWorkflowExecutedReceipt,
  mapLegacyRunApprovalOperation,
  mapLegacyWorkflowApprovalOperation,
  type LegacyWorkflowExecutedReceiptRow,
} from "./canonical-approval-mapper.js";
import { LegacyWorkflowRepository } from "./legacy-workflow-repository.js";

interface RunApprovalRow extends Omit<ApprovalRequest, "metadata"> {
  metadataJson: string;
  sessionId: string | null;
  scopeType: string | null;
  scopeId: string | null;
  operationDigest: string | null;
  riskClass: string | null;
  expiresAt: number | null;
  reuseMode: string | null;
  maxUses: number | null;
  usedCount: number | null;
}

interface WorkflowCanonicalColumns {
  operationDigest: string | null;
  reuseMode: string | null;
  maxUses: number | null;
  usedCount: number | null;
}

const UNRESOLVED_SCAN_BATCH_SIZE = 1_000;

function plainJsonObject(source: string): Record<string, CanonicalJsonValue> | undefined {
  try {
    const parsed: unknown = JSON.parse(source);
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") return undefined;
    stableJson(parsed);
    return parsed as Record<string, CanonicalJsonValue>;
  } catch {
    return undefined;
  }
}

function optionalString(record: Record<string, CanonicalJsonValue>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function workflowPayload(row: AutonomyApprovalRequest): Record<string, CanonicalJsonValue> | undefined {
  const impactScope = plainJsonObject(row.impactScopeJson);
  const diff = plainJsonObject(row.diffJson);
  const rollback = plainJsonObject(row.rollbackJson);
  if (!impactScope || !diff || !rollback) return undefined;
  const payload: Record<string, CanonicalJsonValue> = {
    workflowId: row.workflowId!,
    impactScope,
    diff,
    rollback,
  };
  if (row.revisionId) payload.revisionId = row.revisionId;
  if (row.proposalId) payload.proposalId = row.proposalId;
  if (row.bindingId) payload.bindingId = row.bindingId;
  return payload;
}

function workflowTargetMatches(row: AutonomyApprovalRequest): boolean {
  if (row.actionType === "activate_workflow" || row.actionType === "start_canary") {
    return row.targetType === "workflow_revision" && Boolean(row.revisionId) && row.targetId === row.revisionId;
  }
  if (row.actionType === "apply_revision") {
    return row.targetType === "workflow_proposal" && Boolean(row.proposalId) && row.targetId === row.proposalId;
  }
  return Boolean(row.targetType && row.targetId);
}

export class SqliteCanonicalApprovalShadowRepository
implements CanonicalApprovalReadPort, CanonicalApprovalShadowPort {
  private readonly workflows: LegacyWorkflowRepository;
  private readonly readTimestamp: () => number;

  constructor(private readonly db: Database.Database, options: { readTimestamp?: () => number } = {}) {
    this.workflows = new LegacyWorkflowRepository(db);
    this.readTimestamp = options.readTimestamp ?? Date.now;
  }

  get(ref: ApprovalRef): ApprovalProjection | undefined {
    if (ref.source === "legacy_run") {
      const row = this.runRow(ref.id);
      return row ? this.projectRun(row) : undefined;
    }
    const row = this.workflows.getApproval(ref.id);
    return row ? this.projectWorkflow(row) : undefined;
  }

  resolveLegacyId(id: string) {
    const run = Boolean(this.db.prepare("SELECT 1 FROM approval_requests WHERE id=?").get(id));
    const workflow = Boolean(this.db.prepare("SELECT 1 FROM autonomy_approval_requests WHERE id=?").get(id));
    if (!run && !workflow) return { state: "not_found" as const, id };
    const runRef = { source: "legacy_run" as const, id };
    const workflowRef = { source: "legacy_workflow" as const, id };
    if (run && workflow) return { state: "conflict" as const, id, refs: [runRef, workflowRef] as [ApprovalRef, ApprovalRef] };
    return { state: "resolved" as const, ref: run ? runRef : workflowRef };
  }

  list(query: ApprovalReadQuery): ApprovalProjection[] {
    const limit = Math.max(1, Math.min(query.limit ?? 200, 1_000));
    let refs: ApprovalRef[];
    if (query.source === "legacy_run") {
      if (query.scope && query.scope.type !== RUN_APPROVAL_SCOPE_TYPE) return [];
      const rows = query.scope
        ? this.db.prepare(`SELECT approval.id FROM approval_requests approval
            JOIN runs run ON run.id=approval.run_id WHERE run.session_id=?
            ORDER BY approval.requested_at DESC,approval.id LIMIT ?`).all(query.scope.id, limit)
        : this.db.prepare("SELECT id FROM approval_requests ORDER BY requested_at DESC,id LIMIT ?").all(limit);
      refs = (rows as Array<{ id: string }>).map(({ id }) => ({ source: "legacy_run", id }));
    } else {
      if (query.scope && query.scope.type !== LEGACY_WORKFLOW_APPROVAL_SCOPE_TYPE) return [];
      const rows = query.scope
        ? this.workflows.listApprovals(query.scope.id, limit)
        : this.db.prepare("SELECT id FROM autonomy_approval_requests ORDER BY created_at DESC,id LIMIT ?").all(limit);
      refs = (rows as Array<{ id: string }>).map(({ id }) => ({ source: "legacy_workflow", id }));
    }
    return refs.flatMap((ref) => {
      const projection = this.get(ref);
      if (!projection) return [];
      if (query.status && (projection.state !== "resolved" || projection.approval.status !== query.status)) return [];
      return [projection];
    });
  }

  compare(expectation: ApprovalShadowExpectation): ApprovalShadowComparison | undefined {
    const projection = this.get(expectation.ref);
    if (!projection || projection.state === "unresolved") return projection;
    const mismatches: Array<"operation_digest" | "status"> = [];
    if (projection.approval.operationDigest !== expectation.operationDigest) mismatches.push("operation_digest");
    if (projection.approval.status !== expectation.status) mismatches.push("status");
    return mismatches.length > 0
      ? { state: "mismatch", approval: projection.approval, mismatches }
      : { state: "match", approval: projection.approval };
  }

  listUnresolvedPage(query: ApprovalUnresolvedPageQuery) {
    const pageSize = Math.max(1, Math.min(query.pageSize ?? 200, 1_000));
    if (query.cursor && (query.cursor.source !== query.source || query.cursor.id.length === 0)) {
      throw new TypeError("approval unresolved cursor must belong to the requested source and contain an id");
    }
    const matches: Array<Extract<ApprovalProjection, { state: "unresolved" }>> = [];
    let afterId = query.cursor?.id ?? "";
    while (matches.length <= pageSize) {
      const refs = this.listRefsAfter(query, afterId, UNRESOLVED_SCAN_BATCH_SIZE);
      if (refs.length === 0) break;
      for (const ref of refs) {
        afterId = ref.id;
        const projection = this.get(ref);
        if (projection?.state === "unresolved" && (!query.activeOnly || projection.active)) {
          matches.push(projection);
          if (matches.length > pageSize) break;
        }
      }
      if (matches.length > pageSize || refs.length < UNRESOLVED_SCAN_BATCH_SIZE) break;
    }
    const hasMore = matches.length > pageSize;
    const items = matches.slice(0, pageSize);
    return {
      items,
      nextCursor: hasMore ? { source: query.source, id: items.at(-1)!.ref.id } : null,
      hasMore,
    };
  }

  summarizeAllUnresolved(): ApprovalUnresolvedSummary {
    const summary: ApprovalUnresolvedSummary = {
      total: 0,
      active: 0,
      bySource: { legacy_run: 0, legacy_workflow: 0 },
      activeBySource: { legacy_run: 0, legacy_workflow: 0 },
      byReason: {},
    };
    for (const source of ["legacy_run", "legacy_workflow"] as const) {
      let cursor: { source: typeof source; id: string } | undefined;
      do {
        const page = this.listUnresolvedPage({ source, cursor, pageSize: 1_000 });
        for (const projection of page.items) {
          summary.total += 1;
          summary.bySource[source] += 1;
          if (projection.active) {
            summary.active += 1;
            summary.activeBySource[source] += 1;
          }
          for (const reason of projection.reasonCodes) {
            summary.byReason[reason] = (summary.byReason[reason] ?? 0) + 1;
          }
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
    return summary;
  }

  summarizeComparisons(expectations: ApprovalShadowExpectation[]) {
    const comparisons = expectations.flatMap((expectation) => {
      const comparison = this.compare(expectation);
      return comparison ? [comparison] : [];
    });
    return {
      total: expectations.length,
      match: comparisons.filter((comparison) => comparison.state === "match").length,
      mismatch: comparisons.filter((comparison) => comparison.state === "mismatch").length,
      unresolved: comparisons.filter((comparison) => comparison.state === "unresolved").length,
      activeUnresolved: comparisons.filter((comparison) => comparison.state === "unresolved" && comparison.active).length,
      missing: expectations.length - comparisons.length,
      comparisons,
    };
  }

  private listRefsAfter(
    query: Pick<ApprovalUnresolvedPageQuery, "source" | "scope">,
    afterId: string,
    limit: number,
  ): ApprovalRef[] {
    if (query.source === "legacy_run") {
      if (query.scope && query.scope.type !== RUN_APPROVAL_SCOPE_TYPE) return [];
      const rows = query.scope
        ? this.db.prepare(`SELECT approval.id FROM approval_requests approval
            JOIN runs run ON run.id=approval.run_id
            WHERE run.session_id=? AND approval.id>? ORDER BY approval.id LIMIT ?`)
          .all(query.scope.id, afterId, limit)
        : this.db.prepare("SELECT id FROM approval_requests WHERE id>? ORDER BY id LIMIT ?").all(afterId, limit);
      return (rows as Array<{ id: string }>).map(({ id }) => ({ source: "legacy_run", id }));
    }
    if (query.scope && query.scope.type !== LEGACY_WORKFLOW_APPROVAL_SCOPE_TYPE) return [];
    const rows = query.scope
      ? this.db.prepare(`SELECT id FROM autonomy_approval_requests
          WHERE scope_id=? AND id>? ORDER BY id LIMIT ?`).all(query.scope.id, afterId, limit)
      : this.db.prepare("SELECT id FROM autonomy_approval_requests WHERE id>? ORDER BY id LIMIT ?")
        .all(afterId, limit);
    return (rows as Array<{ id: string }>).map(({ id }) => ({ source: "legacy_workflow", id }));
  }

  private runRow(id: string): RunApprovalRow | undefined {
    return this.db.prepare(`SELECT approval.id,approval.run_id as runId,approval.decision_id as decisionId,
      approval.action_type as actionType,approval.target_type as targetType,approval.target_id as targetId,
      approval.reason,approval.metadata_json as metadataJson,approval.status,
      approval.requested_at as requestedAt,approval.resolved_at as resolvedAt,
      approval.resolved_by as resolvedBy,approval.resolution,run.session_id as sessionId,
      approval.scope_type as scopeType,approval.scope_id as scopeId,
      approval.operation_digest as operationDigest,approval.risk_class as riskClass,
      approval.expires_at as expiresAt,approval.reuse_mode as reuseMode,
      approval.max_uses as maxUses,approval.used_count as usedCount
      FROM approval_requests approval LEFT JOIN runs run ON run.id=approval.run_id WHERE approval.id=?`)
      .get(id) as RunApprovalRow | undefined;
  }

  private projectRun(row: RunApprovalRow): ApprovalProjection {
    const ref = { source: "legacy_run" as const, id: row.id };
    const reasonCodes: ApprovalProjectionReason[] = [];
    const metadata = plainJsonObject(row.metadataJson);
    if (!metadata) reasonCodes.push("invalid_json");
    const action = canonicalApprovalActionForSource("legacy_run", row.actionType);
    const status = canonicalApprovalStatus("legacy_run", row.status);
    if (!action) reasonCodes.push("unknown_action");
    if (!status) reasonCodes.push("unknown_status");
    if (!row.runId) reasonCodes.push("missing_subject");
    if (!row.targetId) reasonCodes.push("missing_target");
    const metadataSessionId = metadata ? optionalString(metadata, "sessionId") : undefined;
    if (metadataSessionId && row.sessionId && metadataSessionId !== row.sessionId) reasonCodes.push("legacy_field_conflict");
    const scopeId = metadataSessionId ?? row.sessionId ?? undefined;
    if (!scopeId) reasonCodes.push("missing_scope");
    if (action === "task_run.resume" && (row.targetType !== "taskrun" || row.targetId !== row.runId)) {
      reasonCodes.push("legacy_field_conflict");
    }
    if (action === "task_run.start_parallel") {
      const parentRunId = metadata ? optionalString(metadata, "parentRunId") : undefined;
      const inboxItemId = metadata ? optionalString(metadata, "inboxItemId") : undefined;
      if (row.targetType !== "session_inbox_item"
        || parentRunId && parentRunId !== row.runId
        || inboxItemId && inboxItemId !== row.targetId) {
        reasonCodes.push("legacy_field_conflict");
      }
    }
    let canonical: ReturnType<typeof mapLegacyRunApprovalOperation> | undefined;
    if (reasonCodes.length === 0 && metadata && action && status && scopeId) {
      try {
        canonical = mapLegacyRunApprovalOperation({
          id: row.id,
          runId: row.runId,
          decisionId: row.decisionId,
          actionType: row.actionType,
          targetType: row.targetType,
          targetId: row.targetId,
          metadata,
          runSessionId: row.sessionId,
          enforceScopeConsistency: true,
        });
      } catch {
        reasonCodes.push("legacy_field_conflict");
      }
    }
    if (canonical && (row.scopeType !== canonical.operation.scope.type
      || row.scopeId !== canonical.operation.scope.id
      || row.operationDigest !== canonical.operationDigest
      || row.riskClass !== LEGACY_RUN_APPROVAL_DEFAULTS.risk
      || row.expiresAt !== LEGACY_RUN_APPROVAL_DEFAULTS.expiresAt
      || row.reuseMode !== LEGACY_RUN_APPROVAL_DEFAULTS.reuse.mode
      || row.maxUses !== LEGACY_RUN_APPROVAL_DEFAULTS.reuse.maxUses)) {
      reasonCodes.push("legacy_field_conflict");
    }
    if (row.status === "approved" && row.usedCount === null) {
      reasonCodes.push("run_approved_without_receipt");
    } else if (row.usedCount !== LEGACY_RUN_APPROVAL_DEFAULTS.reuse.usedCount) {
      reasonCodes.push("reuse_status_conflict");
    }
    if (reasonCodes.length > 0 || !metadata || !action || !status || !scopeId || !canonical) {
      return {
        state: "unresolved",
        ref,
        legacyStatus: row.status,
        active: row.status === "pending" || row.status === "approved",
        reasonCodes: [...new Set(reasonCodes)],
      };
    }
    const approval: Approval = {
      ref,
      ...canonical.operation,
      operationDigest: canonical.operationDigest,
      risk: LEGACY_RUN_APPROVAL_DEFAULTS.risk,
      reuse: { ...LEGACY_RUN_APPROVAL_DEFAULTS.reuse, usedCount: row.usedCount! },
      status,
      expiresAt: LEGACY_RUN_APPROVAL_DEFAULTS.expiresAt,
      requestedBy: optionalString(metadata, "requestedBy") ?? "legacy_system",
      decidedBy: row.resolvedBy || null,
      reason: row.reason,
      decisionReason: row.resolution,
      requestedAt: row.requestedAt,
      decidedAt: row.resolvedAt,
    };
    return { state: "resolved", approval };
  }

  private projectWorkflow(row: AutonomyApprovalRequest): ApprovalProjection {
    const ref = { source: "legacy_workflow" as const, id: row.id };
    const reasonCodes: ApprovalProjectionReason[] = [];
    const action = canonicalApprovalActionForSource("legacy_workflow", row.actionType);
    const effectiveStatus = (row.status === "pending" || row.status === "approved")
      && row.expiresAt <= this.readTimestamp() ? "expired" : row.status;
    const status = canonicalApprovalStatus("legacy_workflow", effectiveStatus, {
      maxUses: 1,
      usedCount: row.status === "executed" ? 1 : 0,
    });
    const payload = workflowPayload(row);
    if (!action) reasonCodes.push("unknown_action");
    if (!status) reasonCodes.push("unknown_status");
    if (!["low", "medium", "high"].includes(row.riskClass)) reasonCodes.push("unknown_risk");
    if (!row.workflowId) reasonCodes.push("missing_subject");
    if (!row.targetType || !row.targetId) reasonCodes.push("missing_target");
    else if (!workflowTargetMatches(row)) reasonCodes.push("legacy_field_conflict");
    if (!row.scopeId) reasonCodes.push("missing_scope");
    if (!payload) reasonCodes.push("invalid_json");
    const canonicalColumns = this.db.prepare(`SELECT operation_digest as operationDigest,
      reuse_mode as reuseMode,max_uses as maxUses,used_count as usedCount
      FROM autonomy_approval_requests WHERE id=?`).get(row.id) as WorkflowCanonicalColumns | undefined;
    let canonical: ReturnType<typeof mapLegacyWorkflowApprovalOperation> | undefined;
    if (reasonCodes.length === 0 && action && status && payload && row.workflowId) {
      try {
        canonical = mapLegacyWorkflowApprovalOperation(row);
      } catch {
        reasonCodes.push("legacy_field_conflict");
      }
    }
    const expectedUsedCount = row.status === "executed" ? 1 : 0;
    if (!canonicalColumns || canonical && (
      canonicalColumns.operationDigest !== canonical.operationDigest
      || canonicalColumns.reuseMode !== "one_time"
      || canonicalColumns.maxUses !== 1)) {
      reasonCodes.push("legacy_field_conflict");
    }
    if (canonicalColumns?.usedCount !== expectedUsedCount) {
      reasonCodes.push("reuse_status_conflict");
    }
    if (row.status === "executed") {
      const receipt = plainJsonObject(row.executionReceiptJson);
      if (!receipt) reasonCodes.push("workflow_receipt_missing");
      else if (receipt.actionType !== row.actionType || receipt.targetId !== row.targetId) {
        reasonCodes.push("workflow_receipt_mismatch");
      }
      if (canonical) {
        try {
          const expectedReceipt = buildLegacyWorkflowExecutedReceipt({
            approvalId: row.id,
            actionType: row.actionType,
            targetId: row.targetId,
            operationDigest: canonical.operationDigest,
            executedAt: row.executedAt!,
            receiptJson: row.executionReceiptJson,
          });
          const storedReceipt = this.db.prepare("SELECT * FROM approval_receipts WHERE id=?")
            .get(expectedReceipt.id) as LegacyWorkflowExecutedReceiptRow | undefined;
          if (!storedReceipt) reasonCodes.push("workflow_receipt_missing");
          else if (stableJson(storedReceipt) !== stableJson(expectedReceipt)) {
            reasonCodes.push("workflow_receipt_mismatch");
          }
        } catch {
          reasonCodes.push("workflow_receipt_mismatch");
        }
      }
    }
    if (reasonCodes.length > 0 || !action || !status || !payload || !row.workflowId || !canonical) {
      return {
        state: "unresolved",
        ref,
        legacyStatus: row.status,
        active: effectiveStatus === "pending" || effectiveStatus === "approved",
        reasonCodes: [...new Set(reasonCodes)],
      };
    }
    const approval: Approval = {
      ref,
      ...canonical.operation,
      operationDigest: canonical.operationDigest,
      risk: row.riskClass,
      reuse: { mode: "one_time", maxUses: 1, usedCount: row.status === "executed" ? 1 : 0 },
      status,
      expiresAt: row.expiresAt,
      requestedBy: row.requestedBy,
      decidedBy: row.decidedBy || null,
      reason: row.requestReason,
      decisionReason: row.decisionReason,
      requestedAt: row.createdAt,
      decidedAt: row.decidedAt,
    };
    return { state: "resolved", approval };
  }
}
