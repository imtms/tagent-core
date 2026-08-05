import type Database from "better-sqlite3";

const REQUIRED_COLUMNS = {
  sessions: { model_id: "'gpt-5.6-sol'", reasoning_effort: "'high'" },
  runs: { model_id: "'gpt-5.6-sol'", reasoning_effort: "'high'" },
} as const;

interface ColumnInfo { name: string; type: string; notnull: number; dflt_value: string | null }

function columns(db: Database.Database, table: string): Map<string, ColumnInfo> {
  return new Map((db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[]).map((row) => [row.name, row]));
}

export function assertWorkspaceExecutionProfileV34Schema(db: Database.Database): void {
  for (const [table, expected] of Object.entries(REQUIRED_COLUMNS)) {
    const actual = columns(db, table);
    for (const [column, defaultValue] of Object.entries(expected)) {
      const definition = actual.get(column);
      if (!definition || definition.type !== "TEXT" || definition.notnull !== 1 || definition.dflt_value !== defaultValue) {
        throw new Error(`Workspace execution profile v34 schema has incompatible ${table}.${column}`);
      }
    }
  }
  for (const table of Object.keys(REQUIRED_COLUMNS)) {
    const invalid = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE trim(model_id) = ''`).get() as { count: number };
    if (invalid.count > 0) throw new Error(`Workspace execution profile v34 has ${invalid.count} ${table} row(s) without a concrete model_id`);
  }
}

export function migrateWorkspaceExecutionProfileV34(
  db: Database.Database,
  previousVersion: number,
  defaultModelId = "gpt-5.6-sol",
): void {
  if (previousVersion !== 33 && previousVersion !== 34) {
    throw new Error(`Workspace execution profile v34 migration requires schema version 33 or 34, found ${previousVersion}`);
  }
  if (previousVersion === 34) {
    assertWorkspaceExecutionProfileV34Schema(db);
    return;
  }
  const normalizedDefaultModelId = defaultModelId.trim();
  if (!normalizedDefaultModelId) throw new Error("Workspace execution profile v34 migration requires a default model id");
  const sessionColumns = columns(db, "sessions");
  if (!sessionColumns.has("model_id")) db.exec("ALTER TABLE sessions ADD COLUMN model_id TEXT NOT NULL DEFAULT 'gpt-5.6-sol'");
  if (!sessionColumns.has("reasoning_effort")) db.exec("ALTER TABLE sessions ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'high' CHECK(reasoning_effort IN ('minimal','low','medium','high','xhigh','max'))");
  db.prepare("UPDATE sessions SET model_id=? WHERE trim(model_id) = '' OR model_id='gpt-5.6-sol'").run(normalizedDefaultModelId);

  const runColumns = columns(db, "runs");
  if (!runColumns.has("model_id")) db.exec("ALTER TABLE runs ADD COLUMN model_id TEXT NOT NULL DEFAULT 'gpt-5.6-sol'");
  db.prepare("UPDATE runs SET model_id=? WHERE trim(model_id) = '' OR model_id='gpt-5.6-sol'").run(normalizedDefaultModelId);
  // Existing TaskRuns retain the pre-v34 Pi default. Newly admitted TaskRuns copy
  // the Workspace preference, whose default is high.
  if (!runColumns.has("reasoning_effort")) {
    db.exec("ALTER TABLE runs ADD COLUMN reasoning_effort TEXT NOT NULL DEFAULT 'high' CHECK(reasoning_effort IN ('minimal','low','medium','high','xhigh','max'))");
    db.exec("UPDATE runs SET reasoning_effort='medium'");
  }
  assertWorkspaceExecutionProfileV34Schema(db);
}
