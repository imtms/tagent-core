import type { TaskRun } from "./api";

export type OperationState = "running" | "waiting" | "stalled" | "interrupted" | "completed" | "blocked" | "failed";
export type OperationKind = "gitlab" | "tests" | "deploy" | "external" | "tool" | "agent";

export interface CurrentOperation {
  state: OperationState;
  kind: OperationKind;
  toolName: string;
  summary: string;
  progressSummary: string;
  startedAt: number;
  lastActivityAt: number;
}

const STALLED_AFTER_MS = 120_000;
const WAITING_AFTER_MS = 15_000;

function operationKind(text: string): OperationKind {
  const value = text.toLowerCase();
  if (/gitlab|pipeline|\bci\b/.test(value)) return "gitlab";
  if (/npm (run )?test|vitest|jest|pytest|playwright|running tests?|测试/.test(value)) return "tests";
  if (/deploy|deployment|kubectl|helm|发布|部署/.test(value)) return "deploy";
  if (/curl|wget|poll|wait|health|service|external|轮询|等待|外部服务/.test(value)) return "external";
  return "tool";
}

export function deriveCurrentOperation(run: TaskRun, now = Date.now()): CurrentOperation {
  const checkpoint = run.checkpoint;
  const tool = checkpoint?.currentTool;
  const terminalAt = run.completedAt ?? run.updatedAt ?? run.createdAt;
  const terminal = (state: OperationState): CurrentOperation => ({
    state,
    kind: "agent",
    toolName: "",
    summary: "",
    progressSummary: "",
    startedAt: run.createdAt,
    lastActivityAt: terminalAt,
  });

  if (run.status === "completed") return terminal("completed");
  if (run.status === "failed") return terminal("failed");
  if (run.status === "blocked") return terminal("blocked");
  if (run.status === "interrupted" || run.status === "cancelled") return terminal("interrupted");

  const startedAt = tool?.startedAt ?? checkpoint?.updatedAt ?? run.updatedAt ?? run.createdAt;
  const lastActivityAt = tool?.lastActivityAt ?? checkpoint?.updatedAt ?? run.updatedAt ?? run.createdAt;
  const summary = tool?.summary?.trim() ?? "";
  const progressSummary = tool?.progressSummary?.trim() ?? "";
  const kind = tool ? operationKind(`${tool.toolName} ${summary} ${progressSummary}`) : "agent";
  const inactiveFor = Math.max(0, now - lastActivityAt);
  const elapsed = Math.max(0, now - startedAt);
  const waiting = elapsed >= WAITING_AFTER_MS && inactiveFor >= WAITING_AFTER_MS;

  return {
    state: inactiveFor >= STALLED_AFTER_MS ? "stalled" : waiting ? "waiting" : "running",
    kind,
    toolName: tool?.toolName?.trim() || "",
    summary,
    progressSummary,
    startedAt,
    lastActivityAt,
  };
}
