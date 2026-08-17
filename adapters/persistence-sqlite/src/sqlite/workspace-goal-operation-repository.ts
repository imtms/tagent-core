import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { WorkspaceGoalOperationReceipt } from "@tagent/governance/ports";

const now = () => Date.now();

export class SqliteWorkspaceGoalOperationRepository {
  constructor(private readonly db: Database.Database) {}

  claimWorkspaceGoalOperation(input: {
    goalId: string;
    requestId: string;
    operationType: string;
    canonicalPayload: string;
  }): { receipt: WorkspaceGoalOperationReceipt; claimed: boolean } {
    const payloadHash = createHash("sha256").update(input.canonicalPayload).digest("hex");
    return this.db.transaction(() => {
      const existing = this.getWorkspaceGoalOperation(input.goalId, input.requestId);
      if (existing) {
        if (existing.payloadHash !== payloadHash || existing.operationType !== input.operationType) {
          throw new Error("workspace Goal operation idempotency conflict");
        }
        return { receipt: existing, claimed: false };
      }
      const timestamp = now();
      this.db.prepare(`INSERT INTO workspace_goal_operation_receipts
        (goal_id,request_id,operation_type,payload_hash,payload_json,status,result_json,error_json,created_at,updated_at,completed_at)
        VALUES (?,?,?,?,?,'started','','',?,?,NULL)`).run(
        input.goalId,
        input.requestId,
        input.operationType,
        payloadHash,
        input.canonicalPayload,
        timestamp,
        timestamp,
      );
      return { receipt: this.getWorkspaceGoalOperation(input.goalId, input.requestId)!, claimed: true };
    })();
  }

  getWorkspaceGoalOperation(goalId: string, requestId: string): WorkspaceGoalOperationReceipt | undefined {
    const row = this.db.prepare(`SELECT goal_id as goalId,request_id as requestId,operation_type as operationType,payload_hash as payloadHash,
      payload_json as payloadJson,status as state,result_json as resultJson,error_json as errorJson,
      created_at as createdAt,updated_at as updatedAt,completed_at as completedAt
      FROM workspace_goal_operation_receipts WHERE goal_id=? AND request_id=?`).get(goalId, requestId) as
      (Omit<WorkspaceGoalOperationReceipt, "payload" | "result" | "error"> & { payloadJson: string; resultJson: string; errorJson: string }) | undefined;
    if (!row) return undefined;
    const { payloadJson, resultJson, errorJson, ...receipt } = row;
    return {
      ...receipt,
      payload: JSON.parse(payloadJson) as Record<string, unknown>,
      result: resultJson ? JSON.parse(resultJson) as Record<string, unknown> : null,
      error: errorJson ? JSON.parse(errorJson) as Record<string, unknown> : null,
    };
  }

  settleWorkspaceGoalOperation(
    goalId: string,
    requestId: string,
    state: "succeeded" | "failed" | "outcome_unknown",
    result: Record<string, unknown> = {},
    error: Record<string, unknown> = {},
  ): WorkspaceGoalOperationReceipt {
    const timestamp = now();
    this.db.prepare(`UPDATE workspace_goal_operation_receipts SET status=?,result_json=?,error_json=?,updated_at=?,completed_at=?
      WHERE goal_id=? AND request_id=? AND status='started'`).run(
      state,
      Object.keys(result).length ? JSON.stringify(result) : "",
      Object.keys(error).length ? JSON.stringify(error) : "",
      timestamp,
      timestamp,
      goalId,
      requestId,
    );
    const receipt = this.getWorkspaceGoalOperation(goalId, requestId);
    if (!receipt) throw new Error("workspace Goal operation receipt not found");
    return receipt;
  }
}
