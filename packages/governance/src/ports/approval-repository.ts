import type { ApprovalRequest } from "../domain/index.js";

export interface ApprovalOptions {
  actionType?: ApprovalRequest["actionType"];
  targetType?: ApprovalRequest["targetType"];
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export interface ExternalActionAuthorizationActivation {
  operationId: string;
  toolCallId: string;
  toolName: string;
  argsHash: string;
}

export interface ExternalActionAuthorizationResult {
  allowed: boolean;
  reason: string;
  approvalId?: string;
}

export interface ApprovalRepository {
  ensureApprovalRequest(runId: string, decisionId: string, reason: string, options?: ApprovalOptions): ApprovalRequest;
  getApprovalRequest(id: string): ApprovalRequest | undefined;
  resolveApprovalRequest(
    id: string,
    status: "approved" | "rejected",
    resolvedBy?: string,
    resolution?: string,
  ): ApprovalRequest | undefined;
  hasPendingApproval(runId: string): boolean;
  inspectExternalActionAuthorization(runId: string, attempt: number): ExternalActionAuthorizationResult;
  activateExternalActionAuthorization(
    runId: string,
    attempt: number,
    activation: ExternalActionAuthorizationActivation,
  ): ExternalActionAuthorizationResult;
}
