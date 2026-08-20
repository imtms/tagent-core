import type { WorkspaceGoal } from "./api";
import type { UiTone } from "./run-state";

export function goalStatusTone(status: WorkspaceGoal["status"]): UiTone {
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
