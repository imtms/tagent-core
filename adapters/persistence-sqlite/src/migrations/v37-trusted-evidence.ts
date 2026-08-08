import type Database from "better-sqlite3";

interface ColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null }

function columns(db: Database.Database, table: string): Map<string, ColumnInfo> {
  return new Map((db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[]).map((row) => [row.name, row]));
}

export function assertTrustedEvidenceV37Schema(db: Database.Database): void {
  const payload = columns(db, "operations").get("payload_json");
  if (!payload || payload.type !== "TEXT" || payload.notnull !== 1 || payload.dflt_value !== "''") {
    throw new Error("Trusted evidence v37 schema has incompatible operations.payload_json");
  }
  const checkColumns = columns(db, "run_checks");
  const sourceOperation = checkColumns.get("source_operation_id");
  if (!sourceOperation || sourceOperation.type !== "TEXT" || sourceOperation.notnull !== 0) {
    throw new Error("Trusted evidence v37 schema has incompatible run_checks.source_operation_id");
  }
  const observedAt = checkColumns.get("observed_at");
  if (!observedAt || observedAt.type !== "INTEGER" || observedAt.notnull !== 0) {
    throw new Error("Trusted evidence v37 schema has incompatible run_checks.observed_at");
  }
  const index = (db.prepare("PRAGMA index_list(run_checks)").all() as Array<{ name: string; unique: number; partial: number }>)
    .find((item) => item.name === "idx_run_checks_source_operation");
  const indexColumns = index
    ? (db.prepare("PRAGMA index_info(idx_run_checks_source_operation)").all() as Array<{ name: string }>).map((item) => item.name)
    : [];
  if (!index || index.unique !== 0 || index.partial !== 1
    || indexColumns.join(",") !== "run_id,source_operation_id") {
    throw new Error("Trusted evidence v37 schema has incompatible idx_run_checks_source_operation");
  }
}

export function migrateTrustedEvidenceV37(db: Database.Database, previousVersion: number): void {
  if (previousVersion !== 36 && previousVersion !== 37) {
    throw new Error(`Trusted evidence v37 migration requires schema version 36 or 37, found ${previousVersion}`);
  }
  if (previousVersion === 37) return assertTrustedEvidenceV37Schema(db);
  const operationColumns = columns(db, "operations");
  if (!operationColumns.has("payload_json")) db.exec("ALTER TABLE operations ADD COLUMN payload_json TEXT NOT NULL DEFAULT ''");
  const checkColumns = columns(db, "run_checks");
  if (!checkColumns.has("source_operation_id")) db.exec("ALTER TABLE run_checks ADD COLUMN source_operation_id TEXT");
  if (!checkColumns.has("observed_at")) db.exec("ALTER TABLE run_checks ADD COLUMN observed_at INTEGER");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_run_checks_source_operation
    ON run_checks(run_id, source_operation_id) WHERE source_operation_id IS NOT NULL`);
  assertTrustedEvidenceV37Schema(db);
}
