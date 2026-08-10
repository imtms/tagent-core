import type Database from "better-sqlite3";

const EXPECTED_INDEXES = [
  { name: "idx_sessions_operator_created", table: "sessions", columns: ["created_at", "id"] },
  { name: "idx_runs_operator_session_created", table: "runs", columns: ["session_id", "created_at", "id"] },
  { name: "idx_runs_operator_session_updated", table: "runs", columns: ["session_id", "updated_at", "id"] },
] as const;

export function assertOperatorReadV41Schema(db: Database.Database): void {
  for (const expected of EXPECTED_INDEXES) {
    const index = db.prepare("SELECT tbl_name as tableName FROM sqlite_master WHERE type='index' AND name=?")
      .get(expected.name) as { tableName: string } | undefined;
    if (!index || index.tableName !== expected.table) {
      throw new Error(`Operator Read v41 schema is missing ${expected.name}`);
    }
    const columns = (db.prepare(`PRAGMA index_info(${expected.name})`).all() as Array<{ name: string }>).map((row) => row.name);
    if (columns.join("\u0000") !== expected.columns.join("\u0000")) {
      throw new Error(`Operator Read v41 schema has invalid ${expected.name} columns`);
    }
  }
}

export function migrateOperatorReadV41(db: Database.Database, previousVersion: number): void {
  if (previousVersion !== 40 && previousVersion !== 41) {
    throw new Error(`Operator Read v41 migration requires schema version 40 or 41, found ${previousVersion}`);
  }
  if (previousVersion === 41) return assertOperatorReadV41Schema(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_operator_created
      ON sessions(created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_operator_session_created
      ON runs(session_id,created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS idx_runs_operator_session_updated
      ON runs(session_id,updated_at DESC,id DESC);
  `);
  assertOperatorReadV41Schema(db);
}
