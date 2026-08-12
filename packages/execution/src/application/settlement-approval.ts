import type { TaskRun } from "../domain/task-run.js";
import type { ApprovalRequest } from "@tagent/governance/domain";
import type { ApprovalOptions } from "@tagent/governance/ports";
import { effectiveTaskExecutionPolicy } from "@tagent/governance/domain";

export function ensureSettlementApproval(
  approvals: { ensureApprovalRequest(runId: string, decisionId: string, reason: string, options?: ApprovalOptions): ApprovalRequest },
  run: TaskRun,
  decisionId: string,
  reason: string,
) {
  const externalAction = effectiveTaskExecutionPolicy(run.contract).mode === "external_action";
  return approvals.ensureApprovalRequest(run.id, decisionId, reason, externalAction ? {
    actionType: "execute_external_action",
    targetType: "taskrun",
    targetId: run.id,
    metadata: { sessionId: run.sessionId, approvedAttempt: run.attempt + 1 },
  } : undefined);
}
