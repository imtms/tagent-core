import type Database from "better-sqlite3";

interface ColumnShape {
  name: string;
  type: string;
  notnull: 0 | 1;
  dflt_value: string | null;
  pk: number;
}

const EXPECTED_COLUMNS: readonly ColumnShape[] = [
  { name: "session_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
  { name: "idempotency_key", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
  { name: "submission_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "principal_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "payload_hash", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "canonical_payload_json", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
  { name: "provenance_json", type: "TEXT", notnull: 1, dflt_value: "'{}'", pk: 0 },
  { name: "created_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
  { name: "updated_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
];

export function assertGatewayOperatorV40Schema(db: Database.Database): void {
  const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='submission_audit_receipts'").get();
  if (!table) throw new Error("Gateway operator v40 schema is missing submission_audit_receipts");
  const columns = db.prepare("PRAGMA table_info(submission_audit_receipts)").all() as ColumnShape[];
  if (columns.length !== EXPECTED_COLUMNS.length) throw new Error("Gateway operator v40 schema has an invalid submission_audit_receipts column count");
  for (const [index, expected] of EXPECTED_COLUMNS.entries()) {
    const actual = columns[index];
    if (!actual
      || actual.name !== expected.name
      || actual.type.toUpperCase() !== expected.type
      || actual.notnull !== expected.notnull
      || actual.dflt_value !== expected.dflt_value
      || actual.pk !== expected.pk) {
      throw new Error(`Gateway operator v40 schema has an invalid submission_audit_receipts.${expected.name} column shape`);
    }
  }
  const foreignKeys = db.prepare("PRAGMA foreign_key_list(submission_audit_receipts)").all() as Array<{
    from: string; table: string; to: string; on_delete: string;
  }>;
  for (const expected of [
    { from: "session_id", table: "sessions", to: "id" },
    { from: "submission_id", table: "session_supervisor_inbox", to: "id" },
  ]) {
    if (!foreignKeys.some((row) => row.from === expected.from && row.table === expected.table
      && row.to === expected.to && row.on_delete === "CASCADE")) {
      throw new Error(`Gateway operator v40 schema has an invalid submission_audit_receipts.${expected.from} foreign key`);
    }
  }
  if (foreignKeys.length !== 2) throw new Error("Gateway operator v40 schema has unexpected submission audit foreign keys");
  const indexes = new Map((db.prepare("PRAGMA index_list(submission_audit_receipts)").all() as Array<{ name: string }>).map((row) => [row.name, row]));
  if (!indexes.has("idx_submission_audit_principal")) throw new Error("Gateway operator v40 schema is missing idx_submission_audit_principal");
  const indexColumns = (db.prepare("PRAGMA index_info(idx_submission_audit_principal)").all() as Array<{ name: string }>).map((row) => row.name);
  if (indexColumns.join("\u0000") !== ["principal_id", "created_at"].join("\u0000")) {
    throw new Error("Gateway operator v40 schema has invalid idx_submission_audit_principal columns");
  }
  const uniqueSubmission = (db.prepare("PRAGMA index_list(submission_audit_receipts)").all() as Array<{ name: string; unique: 0 | 1 }>).some((index) => {
    if (index.unique !== 1) return false;
    const names = (db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ name: string }>).map((row) => row.name);
    return names.length === 1 && names[0] === "submission_id";
  });
  if (!uniqueSubmission) throw new Error("Gateway operator v40 schema is missing the unique submission audit identity");
}

export function migrateGatewayOperatorV40(db: Database.Database, previousVersion: number): void {
  if (previousVersion !== 39 && previousVersion !== 40) throw new Error(`Gateway operator v40 migration requires schema version 39 or 40, found ${previousVersion}`);
  if (previousVersion === 40) return assertGatewayOperatorV40Schema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS submission_audit_receipts (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      idempotency_key TEXT NOT NULL,
      submission_id TEXT NOT NULL UNIQUE REFERENCES session_supervisor_inbox(id) ON DELETE CASCADE,
      principal_id TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      canonical_payload_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(session_id,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_submission_audit_principal
      ON submission_audit_receipts(principal_id,created_at);
  `);
  assertGatewayOperatorV40Schema(db);
}
