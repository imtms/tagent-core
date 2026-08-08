import type Database from "better-sqlite3";

const REQUIRED_TABLES = [
  "session_create_receipts",
  "task_run_command_receipts",
  "workspace_goal_operation_receipts",
] as const;

function columns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
}

export function assertGatewayContractsV39Schema(db: Database.Database): void {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
  for (const table of REQUIRED_TABLES) if (!tables.has(table)) throw new Error(`Gateway contracts v39 schema is missing ${table}`);
  const cursorColumns = columns(db, "event_consumers");
  for (const column of ["settled_acked_seq", "final_acked_seq"]) {
    if (!cursorColumns.has(column)) throw new Error(`Gateway contracts v39 schema is missing event_consumers.${column}`);
  }
  const commandIndexes = new Set((db.prepare("PRAGMA index_list(task_run_command_receipts)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!commandIndexes.has("idx_task_run_command_status")) throw new Error("Gateway contracts v39 schema is missing command status index");
}

export function migrateGatewayContractsV39(db: Database.Database, previousVersion: number): void {
  if (previousVersion !== 38 && previousVersion !== 39) throw new Error(`Gateway contracts v39 migration requires schema version 38 or 39, found ${previousVersion}`);
  if (previousVersion === 39) return assertGatewayContractsV39Schema(db);
  const cursorColumns = columns(db, "event_consumers");
  if (!cursorColumns.has("settled_acked_seq")) db.exec("ALTER TABLE event_consumers ADD COLUMN settled_acked_seq INTEGER");
  if (!cursorColumns.has("final_acked_seq")) db.exec("ALTER TABLE event_consumers ADD COLUMN final_acked_seq INTEGER");
  db.exec(`
    UPDATE event_consumers SET settled_acked_seq=terminal_acked_seq
      WHERE settled_acked_seq IS NULL AND terminal_acked_seq IS NOT NULL;
    CREATE TABLE IF NOT EXISTS session_create_receipts (
      principal_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      canonical_payload_json TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      provenance_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(principal_id,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_session_create_receipts_session
      ON session_create_receipts(session_id,created_at);
    CREATE TABLE IF NOT EXISTS task_run_command_receipts (
      principal_id TEXT NOT NULL,
      task_run_id TEXT NOT NULL REFERENCES runs(id),
      command_id TEXT NOT NULL,
      command_type TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      target_attempt_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('started','succeeded','failed','outcome_unknown')),
      result_json TEXT NOT NULL DEFAULT '',
      error_json TEXT NOT NULL DEFAULT '',
      provenance_json TEXT NOT NULL DEFAULT '{}',
      request_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY(principal_id,task_run_id,command_id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_command_status
      ON task_run_command_receipts(status,updated_at);
    CREATE INDEX IF NOT EXISTS idx_task_run_command_run
      ON task_run_command_receipts(task_run_id,created_at);
    CREATE TABLE IF NOT EXISTS workspace_goal_operation_receipts (
      goal_id TEXT NOT NULL REFERENCES workspace_goals(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('started','succeeded','failed','outcome_unknown')),
      result_json TEXT NOT NULL DEFAULT '',
      error_json TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY(goal_id,request_id)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_goal_operation_status
      ON workspace_goal_operation_receipts(status,updated_at);
  `);
  assertGatewayContractsV39Schema(db);
}
