import type { Attempt, RunId, TaskRun } from "../domain/index.js";
import { effectiveTaskExecutionPolicy } from "@tagent/governance/domain";
import type { ExecutionStateView } from "./execution-state.js";
import type {
  ExternalActionApprovalBoundaryPort,
  RunResumeOptions,
} from "./collaboration-ports.js";

type ExternalActionResumeState = ExecutionStateView<
  "persistence",
  "approvals" | "attempts" | "taskRuns"
>;

export type PreparedResumeBoundary =
  | { kind: "continue"; sourceAttempt: Attempt }
  | { kind: "handled"; run: TaskRun };

export function prepareExternalActionResumeBoundary(
  state: ExternalActionResumeState,
  approvalBoundary: ExternalActionApprovalBoundaryPort,
  runId: RunId,
  options: RunResumeOptions,
): PreparedResumeBoundary {
  const sourceRun = state.persistence.taskRuns.getRun(runId);
  if (!sourceRun) throw new Error(`TaskRun ${runId} does not exist`);
  const sourceAttempt = state.persistence.attempts.getAttemptForRun(runId, sourceRun.attempt);
  if (!sourceAttempt) throw new Error(`TaskRun ${runId} has no source Attempt ${sourceRun.attempt}`);
  const externalAction = effectiveTaskExecutionPolicy(sourceRun.contract).mode === "external_action"
    || sourceRun.supervision.approvalRequests.some((approval) => approval.actionType === "execute_external_action");
  const pendingApproval = sourceRun.supervision.approvalRequests.find((approval) => approval.status === "pending");
  if (pendingApproval) {
    const approvedAttempt = Number((pendingApproval.metadata as { approvedAttempt?: unknown }).approvedAttempt);
    if (externalAction && pendingApproval.actionType === "execute_external_action"
      && approvedAttempt === sourceRun.attempt + 1) {
      if (sourceRun.status !== "blocked") {
        approvalBoundary.requestForResume({
          runId,
          attemptId: sourceAttempt.id,
          attempt: sourceRun.attempt,
          expectedVersion: sourceAttempt.version,
          actorId: options.approvalId ? "approval-recovery" : options.actorId ?? "user",
          reason: options.approvalId ? "Recover external-action approval boundary" : options.reason ?? "Manual resume requested",
        });
        return { kind: "handled", run: state.persistence.taskRuns.getRun(runId)! };
      }
      return { kind: "handled", run: sourceRun };
    }
    throw new Error("Run requires an approval decision before resume");
  }
  if (externalAction && options.approvalId) {
    const approval = state.persistence.approvals.getApprovalRequest(options.approvalId);
    const approvedAttempt = Number((approval?.metadata as { approvedAttempt?: unknown } | undefined)?.approvedAttempt);
    if (!approval || approval.runId !== runId || approval.actionType !== "execute_external_action"
      || approvedAttempt !== sourceRun.attempt + 1) {
      throw new Error("External-action TaskRun requires approval bound to its next Attempt");
    }
  }
  if (!externalAction || options.approvalId) return { kind: "continue", sourceAttempt };
  if (options.inputRequest) {
    throw new Error("External-action user input requires its Core-owned approval boundary before resume");
  }
  approvalBoundary.requestForResume({
    runId,
    attemptId: sourceAttempt.id,
    attempt: sourceRun.attempt,
    expectedVersion: sourceAttempt.version,
    actorId: options.actorId ?? "user",
    reason: options.reason ?? "Manual resume requested",
  });
  return { kind: "handled", run: state.persistence.taskRuns.getRun(runId)! };
}
