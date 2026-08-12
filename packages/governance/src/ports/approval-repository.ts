import type { ApprovalRequest } from "../domain/index.js";

export interface ApprovalOptions {
  actionType?: ApprovalRequest["actionType"];
  targetType?: ApprovalRequest["targetType"];
  targetId?: string;
  metadata?: Record<string, unknown>;
}

export interface ApprovalRepository {
  ensureApprovalRequest(runId: string, decisionId: string, reason: string, options?: ApprovalOptions): ApprovalRequest;
  getApprovalRequest(id: string): ApprovalRequest | undefined;
  listApprovalRequests(runId: string): ApprovalRequest[];
  resolveApprovalRequest(
    id: string,
    status: "approved" | "rejected",
    resolvedBy?: string,
    resolution?: string,
  ): ApprovalRequest | undefined;
  hasPendingApproval(runId: string): boolean;
  authorizeExternalAction(runId: string, attempt: number): { allowed: boolean; reason: string; approvalId?: string };
}
