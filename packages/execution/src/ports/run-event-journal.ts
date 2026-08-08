import type { RunEvent, RunId } from "../domain/task-run.js";

export interface RunEventJournal {
  appendEvent(runId: RunId, type: string, data: Record<string, unknown>): RunEvent;
  listEvents(runId: RunId, after?: number, limit?: number): RunEvent[];
}
