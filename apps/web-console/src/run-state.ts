import type { TaskRun, TaskRunSummary } from "./api";

const activeRunStatuses = new Set<TaskRun["status"]>(["running", "waiting_input", "blocked"]);

export function formatRunValue(value: string): string {
  const words = value.replaceAll("_", " ").trim();
  return words ? `${words[0].toUpperCase()}${words.slice(1)}` : "";
}

export function formatRunStatus(status: string | null | undefined): string {
  if (!status) return "";
  if (status === "waiting_input") return "Needs input";
  return formatRunValue(status);
}

export function runStatusNotice(
  status: TaskRun["status"],
  reason: string | null | undefined,
): { text: string; tone: "warning" | "danger" } | null {
  const text = reason?.trim();
  if (!text) return null;
  if (status === "waiting_input" || status === "blocked") return { text, tone: "warning" };
  if (status === "failed" || status === "cancelled" || status === "interrupted") return { text, tone: "danger" };
  return null;
}

export function isRedundantRunPhase(status: string | null | undefined, phase: string | null | undefined): boolean {
  if (!status || !phase) return false;
  return status === phase
    || (status === "completed" && phase === "done")
    || (status === "waiting_input" && phase === "waiting_input");
}

export function isActiveRunStatus(status: TaskRun["status"]): boolean {
  return activeRunStatuses.has(status);
}

export function findActiveRun<T extends TaskRun | TaskRunSummary>(runs: T[]): T | null {
  return runs.find((run) => isActiveRunStatus(run.status)) ?? null;
}

export function canResumeRun(selectedRun: TaskRun | null, activeRun: TaskRun | null): selectedRun is TaskRun {
  return Boolean(
    selectedRun?.resumable
      && (!activeRun || activeRun.id === selectedRun.id)
      && !selectedRun.supervision.approvalRequests.some((request) => request.status === "pending"),
  );
}
