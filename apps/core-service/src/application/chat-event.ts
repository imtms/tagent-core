import type { RunId } from "@tagent/execution/domain";

export interface ChatEvent {
  type: "run.started" | "message.delta" | "message.completed" | "tool.started" | "tool.completed" | "run.completed" | "run.failed" | "run.cancelled" | "run.blocked";
  runId: RunId;
  data: Record<string, unknown>;
}
