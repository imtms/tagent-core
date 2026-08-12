import {
  LEGACY_WORKFLOW_APPROVAL_SCOPE_TYPE,
  RUN_APPROVAL_SCOPE_TYPE,
  canonicalApprovalActionForSource,
  operationDigest,
  stableJson,
  type CanonicalJsonValue,
  type CanonicalApprovalAction,
  type CanonicalOperationInput,
} from "@tagent/governance";

export type LegacyCanonicalOperation = CanonicalOperationInput & {
  action: CanonicalApprovalAction;
};

export interface LegacyRunApprovalSemanticInput {
  id: string;
  runId: string;
  decisionId: string;
  actionType: string;
  targetType: string;
  targetId: string;
  metadata: string | Record<string, unknown>;
  runSessionId: string | null;
  enforceScopeConsistency?: boolean;
}

export interface LegacyWorkflowApprovalSemanticInput {
  id: string;
  scopeId: string;
  actionType: string;
  targetType: string;
  targetId: string;
  workflowId: string | null;
  revisionId: string | null;
  proposalId: string | null;
  bindingId: string | null;
  impactScopeJson: string;
  diffJson: string;
  rollbackJson: string;
}

export interface LegacyWorkflowExecutionReceiptInput {
  approvalId: string;
  actionType: string;
  targetId: string;
  operationDigest: string;
  executedAt: number;
  receiptJson: string;
}

export interface LegacyWorkflowExecutedReceiptRow {
  id: string;
  approval_source: "legacy_workflow";
  approval_id: string;
  operation_id: string;
  operation_digest: string;
  outcome: "executed";
  actor_id: string;
  details_json: string;
  created_at: number;
}

export class CanonicalApprovalMappingError extends Error {
  constructor(message: string) {
    super(`Canonical approval mapping ${message}`);
    this.name = "CanonicalApprovalMappingError";
  }
}

function mappingFailure(message: string): never {
  throw new CanonicalApprovalMappingError(message);
}

export function canonicalJsonObject(
  source: string | Record<string, unknown>,
  field: string,
  id: string,
): Record<string, CanonicalJsonValue> {
  try {
    const parsed: unknown = typeof source === "string" ? JSON.parse(source) : source;
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
      return mappingFailure(`cannot use non-object ${field} for ${id}`);
    }
    stableJson(parsed);
    return parsed as Record<string, CanonicalJsonValue>;
  } catch (error) {
    if (error instanceof CanonicalApprovalMappingError) throw error;
    return mappingFailure(`cannot parse canonical ${field} for ${id}`);
  }
}

export function optionalCanonicalString(
  record: Record<string, CanonicalJsonValue>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function mapLegacyRunApprovalOperation(input: LegacyRunApprovalSemanticInput): {
  operation: LegacyCanonicalOperation;
  operationDigest: string;
  metadata: Record<string, CanonicalJsonValue>;
} {
  const metadata = canonicalJsonObject(input.metadata, "metadata_json", input.id);
  const action = canonicalApprovalActionForSource("legacy_run", input.actionType);
  if (!action) return mappingFailure(`found unknown Run action for ${input.id}`);
  if (!input.runId || !input.decisionId) return mappingFailure(`found missing Run subject for ${input.id}`);
  if (!input.targetType || !input.targetId) return mappingFailure(`found missing Run target for ${input.id}`);
  const metadataSessionId = optionalCanonicalString(metadata, "sessionId");
  if (input.enforceScopeConsistency && metadataSessionId && input.runSessionId
    && metadataSessionId !== input.runSessionId) {
    return mappingFailure(`found conflicting Run scope for ${input.id}`);
  }
  const scopeId = metadataSessionId ?? input.runSessionId ?? undefined;
  if (!scopeId) return mappingFailure(`found missing Run scope for ${input.id}`);
  if (action === "task_run.resume" && (input.targetType !== "taskrun" || input.targetId !== input.runId)) {
    return mappingFailure(`found conflicting resume target for ${input.id}`);
  }
  const payload: Record<string, CanonicalJsonValue> = { decisionId: input.decisionId };
  if (action === "task_run.start_parallel") {
    const parentRunId = optionalCanonicalString(metadata, "parentRunId") ?? input.runId;
    const inboxItemId = optionalCanonicalString(metadata, "inboxItemId") ?? input.targetId;
    if (input.targetType !== "session_inbox_item"
      || parentRunId !== input.runId
      || inboxItemId !== input.targetId) {
      return mappingFailure(`found conflicting parallel target for ${input.id}`);
    }
    payload.parentRunId = parentRunId;
    payload.inboxItemId = inboxItemId;
  }
  if (action === "task_run.execute_external") {
    const approvedAttempt = metadata.approvedAttempt;
    if (input.targetType !== "taskrun" || input.targetId !== input.runId
      || typeof approvedAttempt !== "number" || !Number.isSafeInteger(approvedAttempt) || approvedAttempt < 1) {
      return mappingFailure(`found conflicting external-action target for ${input.id}`);
    }
    payload.approvedAttempt = approvedAttempt;
  }
  const operation: LegacyCanonicalOperation = {
    subject: { kind: "task_run", id: input.runId },
    action,
    target: {
      kind: input.targetType === "taskrun" ? "task_run" : input.targetType,
      id: input.targetId,
    },
    scope: { type: RUN_APPROVAL_SCOPE_TYPE, id: scopeId },
    payload,
  };
  return { operation, operationDigest: operationDigest(operation), metadata };
}

export function workflowTargetMatches(input: Pick<LegacyWorkflowApprovalSemanticInput,
"actionType" | "targetType" | "targetId" | "revisionId" | "proposalId">): boolean {
  if (input.actionType === "activate_workflow" || input.actionType === "start_canary") {
    return input.targetType === "workflow_revision"
      && Boolean(input.revisionId)
      && input.targetId === input.revisionId;
  }
  if (input.actionType === "apply_revision") {
    return input.targetType === "workflow_proposal"
      && Boolean(input.proposalId)
      && input.targetId === input.proposalId;
  }
  return Boolean(input.targetType && input.targetId);
}

export function mapLegacyWorkflowApprovalOperation(input: LegacyWorkflowApprovalSemanticInput): {
  operation: LegacyCanonicalOperation;
  operationDigest: string;
  payload: Record<string, CanonicalJsonValue>;
} {
  const action = canonicalApprovalActionForSource("legacy_workflow", input.actionType);
  if (!action) return mappingFailure(`found unknown Workflow action for ${input.id}`);
  if (!input.scopeId) return mappingFailure(`found missing Workflow scope for ${input.id}`);
  if (!input.workflowId) return mappingFailure(`found missing Workflow subject for ${input.id}`);
  if (!input.targetType || !input.targetId || !workflowTargetMatches(input)) {
    return mappingFailure(`found conflicting Workflow target for ${input.id}`);
  }
  const payload: Record<string, CanonicalJsonValue> = {
    workflowId: input.workflowId,
    impactScope: canonicalJsonObject(input.impactScopeJson, "impact_scope_json", input.id),
    diff: canonicalJsonObject(input.diffJson, "diff_json", input.id),
    rollback: canonicalJsonObject(input.rollbackJson, "rollback_json", input.id),
  };
  if (input.revisionId) payload.revisionId = input.revisionId;
  if (input.proposalId) payload.proposalId = input.proposalId;
  if (input.bindingId) payload.bindingId = input.bindingId;
  const operation: LegacyCanonicalOperation = {
    subject: { kind: "workflow", id: input.workflowId },
    action,
    target: { kind: input.targetType, id: input.targetId },
    scope: { type: LEGACY_WORKFLOW_APPROVAL_SCOPE_TYPE, id: input.scopeId },
    payload,
  };
  return { operation, operationDigest: operationDigest(operation), payload };
}

export function buildLegacyWorkflowExecutedReceipt(
  input: LegacyWorkflowExecutionReceiptInput,
): LegacyWorkflowExecutedReceiptRow {
  if (!Number.isSafeInteger(input.executedAt)) {
    return mappingFailure(`found missing execution timestamp for ${input.approvalId}`);
  }
  const details = canonicalJsonObject(input.receiptJson, "execution_receipt_json", input.approvalId);
  const actorId = optionalCanonicalString(details, "executedBy");
  const actionType = optionalCanonicalString(details, "actionType");
  const targetId = optionalCanonicalString(details, "targetId");
  if (!actorId
    || actionType !== input.actionType
    || targetId !== input.targetId
    || details.executedAt !== input.executedAt) {
    return mappingFailure(`found mismatched execution receipt for ${input.approvalId}`);
  }
  return {
    id: `approval-receipt:legacy_workflow:${input.approvalId}:executed`,
    approval_source: "legacy_workflow",
    approval_id: input.approvalId,
    operation_id: `legacy-workflow-approval:${input.approvalId}`,
    operation_digest: input.operationDigest,
    outcome: "executed",
    actor_id: actorId,
    details_json: stableJson(details),
    created_at: input.executedAt,
  };
}
