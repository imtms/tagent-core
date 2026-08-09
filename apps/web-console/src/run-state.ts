import type { TaskRun, TaskRunSummary } from "./api";

const activeRunStatuses = new Set<TaskRun["status"]>(["running", "waiting_input", "blocked"]);

export function isActiveRunStatus(status: TaskRun["status"]): boolean {
  return activeRunStatuses.has(status);
}

export function findActiveRun<T extends TaskRun | TaskRunSummary>(runs: T[]): T | null {
  return runs.find((run) => isActiveRunStatus(run.status)) ?? null;
}

export function canResumeRun(selectedRun: TaskRun | null, activeRun: TaskRun | null): selectedRun is TaskRun {
  return Boolean(
    selectedRun?.resumable
      && !activeRun
      && !selectedRun.supervision.approvalRequests.some((request) => request.status === "pending"),
  );
}
