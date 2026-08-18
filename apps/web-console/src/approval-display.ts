import type { TaskRun } from "./api";

type RunApprovalAction = TaskRun["supervision"]["approvalRequests"][number]["actionType"];

export function approvalResolutionNotice(actionType: RunApprovalAction, decision: "approved" | "rejected"): string {
  if (decision === "rejected") return actionType === "start_parallel_taskrun"
    ? "Approval rejected. Parallel TaskRun was not started."
    : "Approval rejected. TaskRun remains paused.";
  if (actionType === "start_parallel_taskrun") return "Approval recorded. Parallel TaskRun started.";
  if (actionType === "execute_external_action") return "Approval recorded. External action authorized and TaskRun resumed.";
  return "Approval recorded. TaskRun resumed.";
}
