import type Database from "better-sqlite3";

export interface FinalizeAttemptProjectionCheckpointInput {
  runId: string;
  attemptId: string;
  attemptOrdinal: number;
  eventSeq: number;
  timestamp: number;
}

/** Finalizes the durable TaskRun checkpoint after a terminal Attempt projection. */
export function finalizeAttemptProjectionCheckpoint(
  db: Database.Database,
  input: FinalizeAttemptProjectionCheckpointInput,
): void {
  if (!db.inTransaction) {
    throw new Error("Attempt projection checkpoint requires a writer-fenced transaction");
  }
  const result = db.prepare(`INSERT INTO run_checkpoints
    (run_id,attempt,attempt_id,active,assistant_partial,current_tool_json,last_event_seq,
     last_transcript_seq,updated_at)
    VALUES (?,?,?,0,'','',?,COALESCE((SELECT MAX(seq) FROM run_transcript WHERE run_id=?),0),?)
    ON CONFLICT(run_id) DO UPDATE SET
      attempt=excluded.attempt,
      attempt_id=excluded.attempt_id,
      active=0,
      assistant_partial='',
      current_tool_json='',
      last_event_seq=MAX(run_checkpoints.last_event_seq,excluded.last_event_seq),
      last_transcript_seq=MAX(run_checkpoints.last_transcript_seq,excluded.last_transcript_seq),
      updated_at=excluded.updated_at
    WHERE excluded.attempt>=run_checkpoints.attempt`).run(
    input.runId,
    input.attemptOrdinal,
    input.attemptId,
    input.eventSeq,
    input.runId,
    input.timestamp,
  );
  if (result.changes !== 1) {
    throw new Error(`TaskRun checkpoint changed during Attempt projection for ${input.attemptId}`);
  }
}
