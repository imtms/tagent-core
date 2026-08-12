import type Database from "better-sqlite3";

export function assertExecutionPolicyV42Schema(db: Database.Database): void {
  const column = (db.prepare("PRAGMA table_info(session_supervisor_inbox)").all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>).find((item) => item.name === "execution_policy_json");
  if (!column || column.type !== "TEXT" || column.notnull !== 1 || column.dflt_value !== "''" || column.pk !== 0) {
    throw new Error("Execution policy v42 schema has incompatible session_supervisor_inbox.execution_policy_json");
  }
}

export function migrateExecutionPolicyV42(db: Database.Database, previousVersion: number): void {
  if (previousVersion !== 41 && previousVersion !== 42) throw new Error(`Execution policy v42 migration requires schema version 41 or 42, found ${previousVersion}`);
  const exists = (db.prepare("PRAGMA table_info(session_supervisor_inbox)").all() as Array<{ name: string }>).some((item) => item.name === "execution_policy_json");
  if (previousVersion === 41 && !exists) db.exec("ALTER TABLE session_supervisor_inbox ADD COLUMN execution_policy_json TEXT NOT NULL DEFAULT ''");
  assertExecutionPolicyV42Schema(db);
}
