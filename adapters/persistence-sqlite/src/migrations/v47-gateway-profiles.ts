import type Database from "better-sqlite3";

interface ColumnShape {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

function column(db: Database.Database, table: string, name: string): ColumnShape | undefined {
  return (db.prepare(`PRAGMA table_info("${table}")`).all() as ColumnShape[])
    .find((candidate) => candidate.name === name);
}

function assertRevisionColumn(db: Database.Database, table: string): void {
  const revision = column(db, table, "revision");
  if (!revision || revision.type !== "INTEGER" || revision.notnull !== 1 || revision.dflt_value !== "1") {
    throw new Error(`Gateway profiles v47 schema has incompatible ${table}.revision`);
  }
}

function assertTable(db: Database.Database, name: string, requiredColumns: readonly string[]): void {
  const definition = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name) as { sql: string } | undefined;
  if (!definition) throw new Error(`Gateway profiles v47 schema is missing ${name}`);
  const columns = new Set((db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{ name: string }>).map((item) => item.name));
  for (const required of requiredColumns) {
    if (!columns.has(required)) throw new Error(`Gateway profiles v47 schema is missing ${name}.${required}`);
  }
}

function assertIndex(db: Database.Database, name: string, columns: readonly string[]): void {
  const found = db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name);
  if (!found) throw new Error(`Gateway profiles v47 schema is missing ${name}`);
  const actual = (db.prepare(`PRAGMA index_info("${name}")`).all() as Array<{ name: string }>).map((item) => item.name);
  if (JSON.stringify(actual) !== JSON.stringify(columns)) throw new Error(`Gateway profiles v47 schema has invalid ${name}`);
}

export function assertGatewayProfilesV47Schema(db: Database.Database): void {
  assertRevisionColumn(db, "sessions");
  assertRevisionColumn(db, "session_supervisor_inbox");
  assertRevisionColumn(db, "skills");
  assertTable(db, "workspace_skill_revisions", ["workspace_id", "revision", "updated_at"]);
  assertTable(db, "session_inbox_revisions", ["session_id", "revision", "updated_at"]);
  assertTable(db, "skill_catalog_state", ["id", "revision", "updated_at"]);
  assertTable(db, "profile_resource_revisions", ["profile_id", "resource_type", "resource_id", "revision", "updated_at"]);
  assertTable(db, "profile_mutation_receipts", [
    "principal_id", "profile_id", "endpoint_id", "resource_type", "resource_id", "idempotency_key",
    "payload_hash", "expected_revision", "resulting_revision", "result_json", "created_at", "updated_at",
  ]);
  assertTable(db, "profile_operation_receipts", [
    "principal_id", "delegated_actor_id", "delegated_request_id", "profile_id", "endpoint_id",
    "resource_type", "resource_id", "idempotency_key", "payload_hash", "status", "result_json",
    "error_json", "created_at", "updated_at", "completed_at",
  ]);
  assertTable(db, "profile_audit_events", [
    "id", "principal_id", "granted_scopes_json", "delegated_actor_id", "delegated_request_id",
    "request_id", "profile_id", "endpoint_id", "resource_type", "resource_id", "operation",
    "outcome", "error_code", "created_at",
  ]);
  assertIndex(db, "idx_profile_operations_lookup", [
    "principal_id", "profile_id", "endpoint_id", "resource_type", "resource_id", "idempotency_key",
  ]);
  assertIndex(db, "idx_profile_audit_resource", ["profile_id", "resource_type", "resource_id", "created_at"]);
}

export function migrateGatewayProfilesV47(db: Database.Database, previousVersion: number): void {
  if (previousVersion !== 46 && previousVersion !== 47) {
    throw new Error(`Gateway profiles v47 migration requires schema version 46 or 47, found ${previousVersion}`);
  }
  if (previousVersion === 47) {
    db.exec(`CREATE TABLE IF NOT EXISTS profile_resource_revisions (
      profile_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(profile_id,resource_type,resource_id)
    )`);
    return assertGatewayProfilesV47Schema(db);
  }
  if (!column(db, "sessions", "revision")) {
    db.exec("ALTER TABLE sessions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)");
  }
  if (!column(db, "session_supervisor_inbox", "revision")) {
    db.exec("ALTER TABLE session_supervisor_inbox ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)");
  }
  if (!column(db, "skills", "revision")) {
    db.exec("ALTER TABLE skills ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0)");
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_skill_revisions (
      workspace_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      updated_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO workspace_skill_revisions (workspace_id,revision,updated_at)
      SELECT id,1,updated_at FROM sessions;

    CREATE TABLE IF NOT EXISTS session_inbox_revisions (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      updated_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO session_inbox_revisions (session_id,revision,updated_at)
      SELECT id,1,updated_at FROM sessions;

    CREATE TABLE IF NOT EXISTS skill_catalog_state (
      id INTEGER PRIMARY KEY CHECK(id=1),
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      updated_at INTEGER NOT NULL
    );
    INSERT OR IGNORE INTO skill_catalog_state (id,revision,updated_at) VALUES (1,1,0);

    CREATE TABLE IF NOT EXISTS profile_resource_revisions (
      profile_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(profile_id,resource_type,resource_id)
    );

    CREATE TABLE IF NOT EXISTS profile_mutation_receipts (
      principal_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
      expected_revision INTEGER NOT NULL CHECK(expected_revision > 0),
      resulting_revision INTEGER NOT NULL CHECK(resulting_revision > 0),
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY(principal_id,profile_id,endpoint_id,resource_type,resource_id,idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS profile_operation_receipts (
      principal_id TEXT NOT NULL,
      delegated_actor_id TEXT,
      delegated_request_id TEXT,
      profile_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
      status TEXT NOT NULL CHECK(status IN ('started','succeeded','failed','outcome_unknown')),
      result_json TEXT NOT NULL DEFAULT '',
      error_json TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      PRIMARY KEY(principal_id,profile_id,endpoint_id,resource_type,resource_id,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS idx_profile_operations_lookup ON profile_operation_receipts
      (principal_id,profile_id,endpoint_id,resource_type,resource_id,idempotency_key);

    CREATE TABLE IF NOT EXISTS profile_audit_events (
      id TEXT PRIMARY KEY,
      principal_id TEXT NOT NULL,
      granted_scopes_json TEXT NOT NULL,
      delegated_actor_id TEXT,
      delegated_request_id TEXT,
      request_id TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      endpoint_id TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK(outcome IN ('succeeded','failed','outcome_unknown')),
      error_code TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_profile_audit_resource ON profile_audit_events
      (profile_id,resource_type,resource_id,created_at);
  `);
  assertGatewayProfilesV47Schema(db);
}
