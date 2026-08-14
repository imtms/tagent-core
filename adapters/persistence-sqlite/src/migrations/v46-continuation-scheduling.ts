import type Database from "better-sqlite3";

function indexColumns(db: Database.Database, name: string): string[] {
  return (db.prepare(`PRAGMA index_info("${name}")`).all() as Array<{ name: string }>).map((row) => row.name);
}

export function assertContinuationSchedulingV46Schema(db: Database.Database): void {
  const column = (db.prepare("PRAGMA table_info(run_continuations)").all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
  }>).find((candidate) => candidate.name === "not_before");
  if (!column || column.type !== "INTEGER" || column.notnull !== 1 || column.dflt_value !== "0") {
    throw new Error("Continuation scheduling v46 schema has incompatible run_continuations.not_before");
  }
  const index = (db.prepare("PRAGMA index_list(run_continuations)").all() as Array<{
    name: string;
    unique: number;
    partial: number;
  }>).find(
    (candidate) => candidate.name === "idx_continuations_due",
  );
  if (!index || index.unique !== 0 || index.partial !== 0
    || JSON.stringify(indexColumns(db, index.name)) !== JSON.stringify(["status", "not_before", "lease_until", "created_at"])) {
    throw new Error("Continuation scheduling v46 schema has invalid idx_continuations_due");
  }
}

export function migrateContinuationSchedulingV46(db: Database.Database, previousVersion: number): void {
  if (previousVersion !== 45 && previousVersion !== 46) {
    throw new Error(`Continuation scheduling v46 migration requires schema version 45 or 46, found ${previousVersion}`);
  }
  if (previousVersion === 45) {
    const hasColumn = (db.prepare("PRAGMA table_info(run_continuations)").all() as Array<{ name: string }>).some(
      (column) => column.name === "not_before",
    );
    if (!hasColumn) db.exec("ALTER TABLE run_continuations ADD COLUMN not_before INTEGER NOT NULL DEFAULT 0");
    db.exec("CREATE INDEX IF NOT EXISTS idx_continuations_due ON run_continuations(status, not_before, lease_until, created_at)");
  }
  assertContinuationSchedulingV46Schema(db);
}
