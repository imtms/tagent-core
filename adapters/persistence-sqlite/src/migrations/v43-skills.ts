import type Database from "better-sqlite3";

interface ColumnShape {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

const TABLES = {
  skills: [
    { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
    { name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "created_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    { name: "updated_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
  ],
  skill_revisions: [
    { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
    { name: "skill_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "revision", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    { name: "description", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "content", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "file_path", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "sha256", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "disable_model_invocation", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
    { name: "source_filename", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "created_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
  ],
  session_skill_bindings: [
    { name: "session_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
    { name: "skill_revision_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "bound_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
  ],
} as const satisfies Record<string, readonly ColumnShape[]>;

const INDEXES = [
  { name: "idx_skill_revisions_latest", table: "skill_revisions", columns: [{ name: "skill_id", desc: 0 }, { name: "revision", desc: 1 }] },
  { name: "idx_session_skill_revision", table: "session_skill_bindings", columns: [{ name: "skill_revision_id", desc: 0 }] },
] as const;

const FOREIGN_KEYS = {
  skill_revisions: [{ from: "skill_id", table: "skills", to: "id" }],
  session_skill_bindings: [
    { from: "session_id", table: "sessions", to: "id" },
    { from: "skill_revision_id", table: "skill_revisions", to: "id" },
  ],
} as const;

function quotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function sameColumns(actual: ColumnShape[], expected: readonly ColumnShape[]): boolean {
  return actual.length === expected.length && actual.every((column, index) => {
    const shape = expected[index];
    return column.name === shape.name && column.type === shape.type && column.notnull === shape.notnull
      && column.dflt_value === shape.dflt_value && column.pk === shape.pk;
  });
}

function assertUniqueColumns(db: Database.Database, table: string, columns: readonly string[]): void {
  const indexes = db.prepare(`PRAGMA index_list(${quotedIdentifier(table)})`).all() as Array<{ name: string; unique: number }>;
  const found = indexes.some((index) => index.unique === 1 && (db.prepare(`PRAGMA index_info(${quotedIdentifier(index.name)})`).all() as Array<{ name: string }>)
    .map((row) => row.name).join("\u0000") === columns.join("\u0000"));
  if (!found) throw new Error(`Skills v43 schema is missing UNIQUE ${table}(${columns.join(",")})`);
}

export function assertSkillsV43Schema(db: Database.Database): void {
  for (const [table, expected] of Object.entries(TABLES)) {
    const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string } | undefined;
    if (!definition) throw new Error(`Skills v43 schema is missing ${table}`);
    const actual = db.prepare(`PRAGMA table_info(${quotedIdentifier(table)})`).all() as ColumnShape[];
    if (!sameColumns(actual, expected)) throw new Error(`Skills v43 schema has incompatible ${table} columns`);
  }
  const revisionSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='skill_revisions'").get() as { sql: string }).sql
    .replace(/\s+/g, "").toLowerCase();
  for (const constraint of ["check(revision>0)", "check(length(sha256)=64)", "check(disable_model_invocationin(0,1))"]) {
    if (!revisionSql.includes(constraint)) throw new Error(`Skills v43 schema is missing ${constraint}`);
  }
  for (const expected of INDEXES) {
    const index = db.prepare("SELECT tbl_name AS tableName FROM sqlite_master WHERE type='index' AND name=?").get(expected.name) as { tableName: string } | undefined;
    if (!index || index.tableName !== expected.table) throw new Error(`Skills v43 schema is missing ${expected.name}`);
    const columns = (db.prepare(`PRAGMA index_xinfo(${quotedIdentifier(expected.name)})`).all() as Array<{ name: string | null; desc: number; key: number }>)
      .filter((row) => row.key === 1).map((row) => ({ name: row.name, desc: row.desc }));
    if (JSON.stringify(columns) !== JSON.stringify(expected.columns)) throw new Error(`Skills v43 schema has invalid ${expected.name} columns`);
  }
  assertUniqueColumns(db, "skills", ["name"]);
  assertUniqueColumns(db, "skill_revisions", ["skill_id", "revision"]);
  assertUniqueColumns(db, "skill_revisions", ["skill_id", "sha256"]);
  for (const [table, expected] of Object.entries(FOREIGN_KEYS)) {
    const actual = (db.prepare(`PRAGMA foreign_key_list(${quotedIdentifier(table)})`).all() as Array<{ from: string; table: string; to: string }>)
      .map(({ from, table: target, to }) => ({ from, table: target, to })).sort((left, right) => left.from.localeCompare(right.from));
    const wanted = [...expected].sort((left, right) => left.from.localeCompare(right.from));
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`Skills v43 schema has invalid ${table} foreign keys`);
    const violations = db.prepare(`PRAGMA foreign_key_check(${quotedIdentifier(table)})`).all();
    if (violations.length) throw new Error(`Skills v43 schema has ${violations.length} ${table} foreign key violation(s)`);
  }
}

export function migrateSkillsV43(db: Database.Database, previousVersion: number): void {
  if (previousVersion !== 42 && previousVersion !== 43) {
    throw new Error(`Skills v43 migration requires schema version 42 or 43, found ${previousVersion}`);
  }
  if (previousVersion === 43) return assertSkillsV43Schema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS skill_revisions (
      id TEXT PRIMARY KEY,
      skill_id TEXT NOT NULL REFERENCES skills(id),
      revision INTEGER NOT NULL CHECK(revision > 0),
      description TEXT NOT NULL,
      content TEXT NOT NULL,
      file_path TEXT NOT NULL,
      sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
      disable_model_invocation INTEGER NOT NULL DEFAULT 0 CHECK(disable_model_invocation IN (0,1)),
      source_filename TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(skill_id, revision),
      UNIQUE(skill_id, sha256)
    );
    CREATE INDEX IF NOT EXISTS idx_skill_revisions_latest ON skill_revisions(skill_id, revision DESC);
    CREATE TABLE IF NOT EXISTS session_skill_bindings (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id),
      skill_revision_id TEXT NOT NULL REFERENCES skill_revisions(id),
      bound_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_skill_revision ON session_skill_bindings(skill_revision_id);
  `);
  assertSkillsV43Schema(db);
}
