import {
  RUN_APPROVAL_SCOPE_TYPE,
  canonicalApprovalActionForSource,
  operationDigest,
  stableJson,
  type CanonicalJsonValue,
  type CanonicalApprovalAction,
  type CanonicalOperationInput,
} from "@tagent/governance";

export type ApprovalOperation = CanonicalOperationInput & {
  action: CanonicalApprovalAction;
};

export interface RunApprovalSemanticInput {
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

class ApprovalOperationMappingError extends Error {
  constructor(message: string) {
    super(`Canonical approval mapping ${message}`);
    this.name = "ApprovalOperationMappingError";
  }
}

function mappingFailure(message: string): never {
  throw new ApprovalOperationMappingError(message);
}

function canonicalJsonObject(
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
    if (error instanceof ApprovalOperationMappingError) throw error;
    return mappingFailure(`cannot parse canonical ${field} for ${id}`);
  }
}

function optionalCanonicalString(
  record: Record<string, CanonicalJsonValue>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function mapRunApprovalOperation(input: RunApprovalSemanticInput): {
  operation: ApprovalOperation;
  operationDigest: string;
  metadata: Record<string, CanonicalJsonValue>;
} {
  const metadata = canonicalJsonObject(input.metadata, "metadata_json", input.id);
  const action = canonicalApprovalActionForSource("run", input.actionType);
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
  const operation: ApprovalOperation = {
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
