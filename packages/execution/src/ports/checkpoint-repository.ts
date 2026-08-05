import type { RunCheckpoint, RunId } from "../domain/task-run.js";

export interface CheckpointRepository {
  getCheckpoint(runId: RunId): RunCheckpoint | null;
  upsertCheckpoint(checkpoint: Omit<RunCheckpoint, "updatedAt"> & { updatedAt?: number }): RunCheckpoint;
}
