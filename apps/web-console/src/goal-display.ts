import type { WorkspaceGoal } from "./api";

export type GoalStatusTone = "warning" | "info" | "success" | "danger";

export function goalStatusTone(status: WorkspaceGoal["status"]): GoalStatusTone {
  switch (status) {
    case "draft":
    case "ready_to_close":
    case "paused": return "warning";
    case "active": return "info";
    case "completed": return "success";
    case "cancelled": return "danger";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}
