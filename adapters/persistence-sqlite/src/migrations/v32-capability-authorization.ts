import type Database from "better-sqlite3";
import { assertGovernanceV31Foundation } from "./v31-governance.js";

const ALLOW_OPERATION_INDEX = "idx_approval_receipts_one_allow_per_operation";
const ATTEMPT_LOOKUP_INDEX = "idx_operations_attempt_created";
const OPERATION_IDENTITY_TRIGGER = "operations_identity_immutable";

export const CAPABILITY_AUTHORIZATION_SCHEMA_V32_SQL = `
  CREATE UNIQUE INDEX IF NOT EXISTS idx_approval_receipts_one_allow_per_operation
    ON approval_receipts(operation_id) WHERE outcome='allow';
  CREATE INDEX IF NOT EXISTS idx_operations_attempt_created
    ON operations(attempt_id, created_at, id);
  CREATE TRIGGER IF NOT EXISTS operations_identity_immutable
    BEFORE UPDATE OF run_id, attempt, attempt_id, operation_type, payload_hash ON operations
    BEGIN
      SELECT RAISE(ABORT, 'operations identity is immutable');
    END;
`;

interface IndexListRow {
  name: string;
  isUnique: number;
  origin: string;
  partial: number;
}

interface SchemaObjectRow {
  type: string;
  tableName: string;
  sql: string | null;
}

function fail(message: string): never {
  throw new Error(`Capability authorization v32 ${message}`);
}

function normalizeDdl(source: string): string {
  return source
    .toLowerCase()
    .replace(/\bif\s+not\s+exists\b/g, "")
    .replace(/["`]/g, "")
    .replace(/\[([^\]]+)]/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),=<>])\s*/g, "$1")
    .trim();
}

function schemaObject(db: Database.Database, name: string): SchemaObjectRow | undefined {
  return db.prepare(`SELECT type,tbl_name as tableName,sql FROM main.sqlite_master WHERE name=?`)
    .get(name) as SchemaObjectRow | undefined;
}

function indexColumns(db: Database.Database, name: string): string[] {
  return (db.prepare("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(name) as Array<{ name: string | null }>)
    .map((row) => row.name ?? "");
}

function sameColumns(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length && actual.every((column, index) => column === expected[index]);
}

function assertIndex(
  db: Database.Database,
  expected: {
    name: string;
    table: string;
    unique: 0 | 1;
    partial: 0 | 1;
    columns: string[];
    sql: string;
  },
): void {
  const object = schemaObject(db, expected.name);
  if (!object?.sql || object.type !== "index" || object.tableName !== expected.table) {
    fail(`schema has incompatible index ${expected.name}`);
  }
  const index = (db.prepare(`SELECT name,"unique" as isUnique,origin,partial
    FROM pragma_index_list(?) WHERE name=?`).get(expected.table, expected.name) as IndexListRow | undefined);
  if (!index
    || index.isUnique !== expected.unique
    || index.origin !== "c"
    || index.partial !== expected.partial
    || !sameColumns(indexColumns(db, expected.name), expected.columns)
    || normalizeDdl(object.sql) !== normalizeDdl(expected.sql)) {
    fail(`schema has incompatible index ${expected.name}`);
  }
}

function assertOperationIdentityTrigger(db: Database.Database): void {
  const object = schemaObject(db, OPERATION_IDENTITY_TRIGGER);
  const expected = `CREATE TRIGGER operations_identity_immutable
    BEFORE UPDATE OF run_id, attempt, attempt_id, operation_type, payload_hash ON operations
    BEGIN SELECT RAISE(ABORT, 'operations identity is immutable'); END`;
  if (!object?.sql
    || object.type !== "trigger"
    || object.tableName !== "operations"
    || normalizeDdl(object.sql) !== normalizeDdl(expected)) {
    fail(`schema has incompatible trigger ${OPERATION_IDENTITY_TRIGGER}`);
  }
}

export function assertCapabilityAuthorizationV32Schema(db: Database.Database): void {
  assertIndex(db, {
    name: ALLOW_OPERATION_INDEX,
    table: "approval_receipts",
    unique: 1,
    partial: 1,
    columns: ["operation_id"],
    sql: `CREATE UNIQUE INDEX ${ALLOW_OPERATION_INDEX}
      ON approval_receipts(operation_id) WHERE outcome='allow'`,
  });
  assertIndex(db, {
    name: ATTEMPT_LOOKUP_INDEX,
    table: "operations",
    unique: 0,
    partial: 0,
    columns: ["attempt_id", "created_at", "id"],
    sql: `CREATE INDEX ${ATTEMPT_LOOKUP_INDEX}
      ON operations(attempt_id, created_at, id)`,
  });
  assertOperationIdentityTrigger(db);
}

export function migrateCapabilityAuthorizationV32(
  db: Database.Database,
  previousVersion: number | undefined,
  _timestamp: number,
): void {
  if (previousVersion === undefined || previousVersion < 31) {
    fail(`migration requires schema version 31, found ${String(previousVersion)}`);
  }
  if (previousVersion > 32) {
    fail(`migration cannot open schema version ${previousVersion}`);
  }
  assertGovernanceV31Foundation(db);
  db.exec(CAPABILITY_AUTHORIZATION_SCHEMA_V32_SQL);
  assertCapabilityAuthorizationV32Schema(db);
}
