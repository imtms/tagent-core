import type Database from "better-sqlite3";

const REQUIRED_TABLES = [
  "session_create_receipts",
  "task_run_command_receipts",
  "workspace_goal_operation_receipts",
] as const;

interface ColumnShape {
  name: string;
  type: string;
  notnull: 0 | 1;
  dflt_value: string | null;
  pk: number;
}

const RECEIPT_COLUMNS: Record<typeof REQUIRED_TABLES[number], readonly ColumnShape[]> = {
  session_create_receipts: [
    { name: "principal_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
    { name: "idempotency_key", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
    { name: "payload_hash", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "canonical_payload_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "session_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "provenance_json", type: "TEXT", notnull: 1, dflt_value: "'{}'", pk: 0 },
    { name: "created_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    { name: "updated_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
  ],
  task_run_command_receipts: [
    { name: "principal_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
    { name: "task_run_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
    { name: "command_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 3 },
    { name: "command_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "payload_hash", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "payload_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "target_attempt_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "status", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "result_json", type: "TEXT", notnull: 1, dflt_value: "''", pk: 0 },
    { name: "error_json", type: "TEXT", notnull: 1, dflt_value: "''", pk: 0 },
    { name: "provenance_json", type: "TEXT", notnull: 1, dflt_value: "'{}'", pk: 0 },
    { name: "request_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "created_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    { name: "updated_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    { name: "completed_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
  ],
  workspace_goal_operation_receipts: [
    { name: "goal_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
    { name: "request_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
    { name: "operation_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "payload_hash", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "payload_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "status", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "result_json", type: "TEXT", notnull: 1, dflt_value: "''", pk: 0 },
    { name: "error_json", type: "TEXT", notnull: 1, dflt_value: "''", pk: 0 },
    { name: "created_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    { name: "updated_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    { name: "completed_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
  ],
};

const REQUIRED_INDEXES = {
  idx_session_create_receipts_session: ["session_id", "created_at"],
  idx_task_run_command_status: ["status", "updated_at"],
  idx_task_run_command_run: ["task_run_id", "created_at"],
  idx_workspace_goal_operation_status: ["status", "updated_at"],
} as const;

function columns(db: Database.Database, table: string): ColumnShape[] {
  return db.prepare(`PRAGMA table_info(${table})`).all() as ColumnShape[];
}

function assertColumns(db: Database.Database, table: typeof REQUIRED_TABLES[number]): void {
  const actual = columns(db, table);
  const expected = RECEIPT_COLUMNS[table];
  if (actual.length !== expected.length) throw new Error(`Gateway contracts v39 schema has an invalid ${table} column count`);
  for (const [index, shape] of expected.entries()) {
    const column = actual[index];
    if (!column
      || column.name !== shape.name
      || column.type.toUpperCase() !== shape.type
      || column.notnull !== shape.notnull
      || column.dflt_value !== shape.dflt_value
      || column.pk !== shape.pk) {
      throw new Error(`Gateway contracts v39 schema has an invalid ${table}.${shape.name} column shape`);
    }
  }
}

function assertIndex(db: Database.Database, name: keyof typeof REQUIRED_INDEXES): void {
  const index = db.prepare("SELECT tbl_name as tableName FROM sqlite_master WHERE type='index' AND name=?").get(name) as { tableName: string } | undefined;
  if (!index) throw new Error(`Gateway contracts v39 schema is missing ${name}`);
  const columns = (db.prepare(`PRAGMA index_info(${name})`).all() as Array<{ name: string }>).map((row) => row.name);
  if (columns.join("\u0000") !== REQUIRED_INDEXES[name].join("\u0000")) {
    throw new Error(`Gateway contracts v39 schema has invalid ${name} columns`);
  }
}

function assertForeignKey(
  db: Database.Database,
  table: typeof REQUIRED_TABLES[number],
  expected: { from: string; targetTable: string; to: string; onDelete: string },
): void {
  const foreignKeys = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
    from: string; table: string; to: string; on_delete: string;
  }>;
  const matches = foreignKeys.filter((row) => row.from === expected.from
    && row.table === expected.targetTable
    && row.to === expected.to
    && row.on_delete === expected.onDelete);
  if (foreignKeys.length !== 1 || matches.length !== 1) {
    throw new Error(`Gateway contracts v39 schema has an invalid ${table}.${expected.from} foreign key`);
  }
}

function assertStatusConstraint(db: Database.Database, table: "task_run_command_receipts" | "workspace_goal_operation_receipts"): void {
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").pluck().get(table);
  const normalized = String(sql ?? "").replace(/\s+/g, "").toLowerCase();
  if (!normalized.includes("check(statusin('started','succeeded','failed','outcome_unknown'))")) {
    throw new Error(`Gateway contracts v39 schema is missing the ${table}.status constraint`);
  }
}

export function assertGatewayContractsV39Schema(db: Database.Database): void {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((row) => row.name));
  for (const table of REQUIRED_TABLES) {
    if (!tables.has(table)) throw new Error(`Gateway contracts v39 schema is missing ${table}`);
    assertColumns(db, table);
  }
  assertForeignKey(db, "session_create_receipts", { from: "session_id", targetTable: "sessions", to: "id", onDelete: "NO ACTION" });
  assertForeignKey(db, "task_run_command_receipts", { from: "task_run_id", targetTable: "runs", to: "id", onDelete: "NO ACTION" });
  assertForeignKey(db, "workspace_goal_operation_receipts", { from: "goal_id", targetTable: "workspace_goals", to: "id", onDelete: "CASCADE" });
  assertStatusConstraint(db, "task_run_command_receipts");
  assertStatusConstraint(db, "workspace_goal_operation_receipts");
  for (const name of Object.keys(REQUIRED_INDEXES) as Array<keyof typeof REQUIRED_INDEXES>) assertIndex(db, name);
  const cursorColumns = new Map(columns(db, "event_consumers").map((column) => [column.name, column]));
  for (const column of ["settled_acked_seq", "final_acked_seq"]) {
    const shape = cursorColumns.get(column);
    if (!shape) throw new Error(`Gateway contracts v39 schema is missing event_consumers.${column}`);
    if (shape.type.toUpperCase() !== "INTEGER" || shape.notnull !== 0 || shape.dflt_value !== null || shape.pk !== 0) {
      throw new Error(`Gateway contracts v39 schema has an invalid event_consumers.${column} column shape`);
    }
  }
}

export function migrateGatewayContractsV39(db: Database.Database, previousVersion: number): void {
  if (previousVersion !== 38 && previousVersion !== 39) throw new Error(`Gateway contracts v39 migration requires schema version 38 or 39, found ${previousVersion}`);
  if (previousVersion === 39) return assertGatewayContractsV39Schema(db);
  const cursorColumns = new Set(columns(db, "event_consumers").map((column) => column.name));
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
