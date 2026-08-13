import type Database from "better-sqlite3";

interface ColumnShape { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }

const COLUMNS = [
  { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
  { name: "run_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "attempt_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "attempt", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
  { name: "request_ordinal", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
  { name: "schema_version", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
  { name: "envelope_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "provider_payload_hash", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "envelope_hash", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "created_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
] as const satisfies readonly ColumnShape[];

function indexColumns(db: Database.Database, name: string): string[] {
  return (db.prepare(`PRAGMA index_info("${name}")`).all() as Array<{ name: string }>).map((row) => row.name);
}

export function assertAttemptRequestEnvelopesV45Schema(db: Database.Database): void {
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='attempt_request_envelopes'").get() as { sql: string } | undefined;
  if (!table) throw new Error("Attempt request envelope v45 schema is missing attempt_request_envelopes");
  const columns = db.prepare("PRAGMA table_info(attempt_request_envelopes)").all() as ColumnShape[];
  if (columns.length !== COLUMNS.length || columns.some((column, index) => {
    const expected = COLUMNS[index];
    return column.name !== expected.name || column.type !== expected.type || column.notnull !== expected.notnull
      || column.dflt_value !== expected.dflt_value || column.pk !== expected.pk;
  })) {
    throw new Error("Attempt request envelope v45 schema has incompatible columns");
  }
  const normalizedSql = table.sql.replace(/\s+/g, "").toLowerCase();
  for (const constraint of [
    "check(length(id)>0)", "check(attempt>0)", "check(request_ordinal>0)", "check(schema_version=1)",
    "check(json_valid(envelope_json))", "check(length(provider_payload_hash)=64)",
    "check(length(envelope_hash)=64)", "check(created_at>=0)",
  ]) {
    if (!normalizedSql.includes(constraint)) throw new Error(`Attempt request envelope v45 schema is missing ${constraint}`);
  }
  const indexes = db.prepare("PRAGMA index_list(attempt_request_envelopes)").all() as Array<{ name: string; unique: number }>;
  const expectedIndexes = [
    { name: "idx_request_envelopes_attempt_ordinal", unique: 1, columns: ["attempt_id", "request_ordinal"] },
    { name: "idx_request_envelopes_run", unique: 0, columns: ["run_id", "attempt", "request_ordinal"] },
  ];
  for (const expected of expectedIndexes) {
    const index = indexes.find((candidate) => candidate.name === expected.name);
    if (!index || index.unique !== expected.unique) throw new Error(`Attempt request envelope v45 schema has invalid ${expected.name}`);
    if (JSON.stringify(indexColumns(db, expected.name)) !== JSON.stringify(expected.columns)) {
      throw new Error(`Attempt request envelope v45 schema has invalid ${expected.name} columns`);
    }
  }
  const attemptIndex = (db.prepare("PRAGMA index_list(attempts)").all() as Array<{ name: string; unique: number }>)
    .find((candidate) => candidate.name === "idx_attempts_run_ordinal_id");
  if (!attemptIndex || attemptIndex.unique !== 1
    || JSON.stringify(indexColumns(db, attemptIndex.name)) !== JSON.stringify(["run_id", "ordinal", "id"])) {
    throw new Error("Attempt request envelope v45 schema has invalid idx_attempts_run_ordinal_id");
  }
  const foreignKeys = (db.prepare("PRAGMA foreign_key_list(attempt_request_envelopes)").all() as Array<{ id: number; seq: number; from: string; table: string; to: string }>)
    .map(({ id, seq, from, table: target, to }) => ({ id, seq, from, table: target, to }))
    .sort((left, right) => left.id - right.id || left.seq - right.seq);
  const expectedForeignKeys = [
    { id: 0, seq: 0, from: "run_id", table: "attempts", to: "run_id" },
    { id: 0, seq: 1, from: "attempt", table: "attempts", to: "ordinal" },
    { id: 0, seq: 2, from: "attempt_id", table: "attempts", to: "id" },
  ];
  if (JSON.stringify(foreignKeys) !== JSON.stringify(expectedForeignKeys)) {
    throw new Error("Attempt request envelope v45 schema has invalid foreign keys");
  }
  if ((db.prepare("PRAGMA foreign_key_check(attempt_request_envelopes)").all()).length) throw new Error("Attempt request envelope v45 schema has foreign key violations");
}

export function migrateAttemptRequestEnvelopesV45(db: Database.Database, previousVersion: number): void {
  if (previousVersion !== 44 && previousVersion !== 45) throw new Error(`Attempt request envelope v45 migration requires schema version 44 or 45, found ${previousVersion}`);
  const tableExists = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='attempt_request_envelopes'").get());
  if (previousVersion === 44 && !tableExists) db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_run_ordinal_id ON attempts(run_id, ordinal, id);
    CREATE TABLE attempt_request_envelopes (
      id TEXT PRIMARY KEY CHECK(length(id) > 0),
      run_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK(attempt > 0),
      request_ordinal INTEGER NOT NULL CHECK(request_ordinal > 0),
      schema_version INTEGER NOT NULL CHECK(schema_version = 1),
      envelope_json TEXT NOT NULL CHECK(json_valid(envelope_json)),
      provider_payload_hash TEXT NOT NULL CHECK(length(provider_payload_hash) = 64),
      envelope_hash TEXT NOT NULL CHECK(length(envelope_hash) = 64),
      created_at INTEGER NOT NULL CHECK(created_at >= 0),
      FOREIGN KEY (run_id, attempt, attempt_id) REFERENCES attempts(run_id, ordinal, id)
    );
    CREATE UNIQUE INDEX idx_request_envelopes_attempt_ordinal ON attempt_request_envelopes(attempt_id, request_ordinal);
    CREATE INDEX idx_request_envelopes_run ON attempt_request_envelopes(run_id, attempt, request_ordinal);
  `);
  assertAttemptRequestEnvelopesV45Schema(db);
}
