import type { RunEvent, RunEventMap, RunEventType, RunId } from "../domain/task-run.js";

export interface RunEventJournal {
  appendEvent<TType extends RunEventType>(runId: RunId, type: TType, data: RunEventMap[TType]): RunEvent<TType>;
  listEvents(runId: RunId, after?: number, limit?: number): RunEvent[];
}
