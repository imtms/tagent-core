import type Database from "better-sqlite3";

interface ColumnShape {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

const COLUMNS = [
  { name: "session_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
  { name: "skill_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
  { name: "bound_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
] as const satisfies readonly ColumnShape[];

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function assertSkillCenterV44Schema(db: Database.Database): void {
  const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='workspace_skill_bindings'").get() as { sql: string } | undefined;
  if (!definition) throw new Error("Skill center v44 schema is missing workspace_skill_bindings");
  const columns = db.prepare("PRAGMA table_info(workspace_skill_bindings)").all() as ColumnShape[];
  const compatible = columns.length === COLUMNS.length && columns.every((column, index) => {
    const expected = COLUMNS[index];
    return column.name === expected.name && column.type === expected.type && column.notnull === expected.notnull
      && column.dflt_value === expected.dflt_value && column.pk === expected.pk;
  });
  if (!compatible) {
    throw new Error("Skill center v44 schema has incompatible workspace_skill_bindings columns");
  }
  const index = db.prepare("SELECT tbl_name AS tableName FROM sqlite_master WHERE type='index' AND name='idx_workspace_skill_skill'").get() as { tableName: string } | undefined;
  if (!index || index.tableName !== "workspace_skill_bindings") {
    throw new Error("Skill center v44 schema is missing idx_workspace_skill_skill");
  }
  const indexColumns = (db.prepare(`PRAGMA index_info(${quotedIdentifier("idx_workspace_skill_skill")})`).all() as Array<{ name: string }>).map((row) => row.name);
  if (JSON.stringify(indexColumns) !== JSON.stringify(["skill_id"])) {
    throw new Error("Skill center v44 schema has invalid idx_workspace_skill_skill columns");
  }
  const foreignKeys = (db.prepare("PRAGMA foreign_key_list(workspace_skill_bindings)").all() as Array<{ from: string; table: string; to: string }>)
    .map(({ from, table, to }) => ({ from, table, to })).sort((left, right) => left.from.localeCompare(right.from));
  const expected = [
    { from: "session_id", table: "sessions", to: "id" },
    { from: "skill_id", table: "skills", to: "id" },
  ];
  if (JSON.stringify(foreignKeys) !== JSON.stringify(expected)) {
    throw new Error("Skill center v44 schema has invalid workspace_skill_bindings foreign keys");
  }
  const violations = db.prepare("PRAGMA foreign_key_check(workspace_skill_bindings)").all();
  if (violations.length) throw new Error(`Skill center v44 schema has ${violations.length} workspace_skill_bindings foreign key violation(s)`);
}

export function migrateSkillCenterV44(db: Database.Database, previousVersion: number): void {
  if (previousVersion !== 43 && previousVersion !== 44) {
    throw new Error(`Skill center v44 migration requires schema version 43 or 44, found ${previousVersion}`);
  }
  if (previousVersion === 44) return assertSkillCenterV44Schema(db);
  const workspaceTableExists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='workspace_skill_bindings'").get());
  if (workspaceTableExists) assertSkillCenterV44Schema(db);
  const legacyTableExists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_skill_bindings'").get());
  if (!legacyTableExists) {
    if (!workspaceTableExists) throw new Error("Skill center v44 migration is missing session_skill_bindings");
    return;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_skill_bindings (
      session_id TEXT NOT NULL REFERENCES sessions(id),
      skill_id TEXT NOT NULL REFERENCES skills(id),
      bound_at INTEGER NOT NULL,
      PRIMARY KEY(session_id, skill_id)
    );
    INSERT OR IGNORE INTO workspace_skill_bindings (session_id,skill_id,bound_at)
      SELECT legacy.session_id,revisions.skill_id,legacy.bound_at
      FROM session_skill_bindings legacy
      JOIN skill_revisions revisions ON revisions.id=legacy.skill_revision_id;
    DROP TABLE session_skill_bindings;
    CREATE INDEX IF NOT EXISTS idx_workspace_skill_skill ON workspace_skill_bindings(skill_id);
  `);
  assertSkillCenterV44Schema(db);
}
