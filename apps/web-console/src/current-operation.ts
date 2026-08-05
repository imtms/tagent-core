import type { TaskRun } from "./api";

export type OperationState = "running" | "waiting" | "stalled" | "interrupted" | "completed" | "blocked" | "failed";

export interface CurrentOperation {
  state: OperationState;
  toolName: string;
  startedAt: number;
  lastActivityAt: number;
}

const STALLED_AFTER_MS = 120_000;
const WAITING_AFTER_MS = 15_000;

export function deriveCurrentOperation(run: TaskRun, now = Date.now()): CurrentOperation {
  const checkpoint = run.checkpoint;
  const tool = checkpoint?.currentTool;
  const terminalAt = run.completedAt ?? run.updatedAt ?? run.createdAt;
  const terminal = (state: OperationState): CurrentOperation => ({
    state,
    toolName: "",
    startedAt: run.createdAt,
    lastActivityAt: terminalAt,
  });

  if (run.status === "completed") return terminal("completed");
  if (run.status === "failed") return terminal("failed");
  if (run.status === "blocked") return terminal("blocked");
  if (run.status === "interrupted" || run.status === "cancelled") return terminal("interrupted");

  const startedAt = tool?.startedAt ?? checkpoint?.updatedAt ?? run.updatedAt ?? run.createdAt;
  const lastActivityAt = tool?.lastActivityAt ?? checkpoint?.updatedAt ?? run.updatedAt ?? run.createdAt;
  const inactiveFor = Math.max(0, now - lastActivityAt);
  const elapsed = Math.max(0, now - startedAt);
  const waiting = elapsed >= WAITING_AFTER_MS && inactiveFor >= WAITING_AFTER_MS;

  return {
    state: inactiveFor >= STALLED_AFTER_MS ? "stalled" : waiting ? "waiting" : "running",
    toolName: tool?.toolName?.trim() || "",
    startedAt,
    lastActivityAt,
  };
}
