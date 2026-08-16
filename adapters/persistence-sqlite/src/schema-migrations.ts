import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  BASE_SCHEMA_SQL,
  BASE_SCHEMA_VERSION,
  CURRENT_SCHEMA_ID,
  CURRENT_SCHEMA_SQL,
  CURRENT_SCHEMA_VERSION,
  MIGRATION_JOURNAL_SCHEMA_SQL,
} from "./current-schema.js";

export interface SchemaMigration {
  version: number;
  description: string;
  sql: string;
}

const MIGRATIONS: readonly SchemaMigration[] = [
  {
    version: 2,
    description: "add append-only schema migration journal",
    sql: MIGRATION_JOURNAL_SCHEMA_SQL,
  },
];

function checksum(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshot(db: Database.Database): unknown[] {
  return db.prepare(`SELECT type,name,tbl_name AS tableName,sql
    FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
    ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 WHEN 'trigger' THEN 2 ELSE 3 END,name`).all();
}

function assertMarker(db: Database.Database): void {
  let marker: { schemaId: string } | undefined;
  try {
    marker = db.prepare("SELECT schema_id AS schemaId FROM core_schema WHERE id=1")
      .get() as { schemaId: string } | undefined;
  } catch {
    marker = undefined;
  }
  if (marker?.schemaId !== CURRENT_SCHEMA_ID) {
    throw new Error(`Unsupported SQLite schema. Core requires ${CURRENT_SCHEMA_ID} or an empty database.`);
  }
}

function assertShape(db: Database.Database, sql: string, label: string): void {
  const reference = new Database(":memory:");
  try {
    reference.pragma("foreign_keys = ON");
    reference.exec(sql);
    if (JSON.stringify(snapshot(db)) !== JSON.stringify(snapshot(reference))) {
      throw new Error(`SQLite schema does not match ${label}; repair from backup before retrying the upgrade.`);
    }
  } finally {
    reference.close();
  }
}

function userVersion(db: Database.Database): number {
  return db.pragma("user_version", { simple: true }) as number;
}

function setUserVersion(db: Database.Database, version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) throw new TypeError("SQLite schema version must be a non-negative safe integer");
  db.pragma(`user_version = ${version}`);
}

function recordMigration(db: Database.Database, migration: SchemaMigration, appliedAt: number): void {
  if (migration.version === 2) {
    db.prepare(`INSERT INTO core_schema_migrations (version,description,checksum,applied_at)
      VALUES (?,?,?,?)`).run(BASE_SCHEMA_VERSION, "baseline exact tagent-core/0.8 schema", checksum(BASE_SCHEMA_SQL), appliedAt);
  }
  db.prepare(`INSERT INTO core_schema_migrations (version,description,checksum,applied_at)
    VALUES (?,?,?,?)`).run(migration.version, migration.description, checksum(migration.sql), appliedAt);
}

/** Apply a caller-supplied, contiguous migration plan as one immediate transaction. */
export function applySqliteMigrations(
  db: Database.Database,
  migrations: readonly SchemaMigration[],
  appliedAt: number,
): void {
  db.transaction(() => {
    for (const migration of migrations) {
      const installedVersion = userVersion(db);
      if (migration.version !== installedVersion + 1
        && !(installedVersion === 0 && migration.version === BASE_SCHEMA_VERSION + 1)) {
        throw new Error(`SQLite migration sequence is not contiguous at revision ${migration.version}`);
      }
      db.exec(migration.sql);
      recordMigration(db, migration, appliedAt);
      setUserVersion(db, migration.version);
    }
  }).immediate();
}

function validateJournal(db: Database.Database): void {
  const expected = [
    { version: BASE_SCHEMA_VERSION, description: "baseline exact tagent-core/0.8 schema", checksum: checksum(BASE_SCHEMA_SQL) },
    ...MIGRATIONS.map((migration) => ({
      version: migration.version,
      description: migration.description,
      checksum: checksum(migration.sql),
    })),
  ];
  const actual = db.prepare(`SELECT version,description,checksum FROM core_schema_migrations ORDER BY version`).all();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("SQLite schema migration journal is missing, reordered, or has a checksum mismatch");
  }
}

export function assertCurrentSqliteSchema(db: Database.Database): void {
  assertMarker(db);
  const version = userVersion(db);
  if (version !== CURRENT_SCHEMA_VERSION) {
    throw new Error(`SQLite schema revision ${version} is not current revision ${CURRENT_SCHEMA_VERSION}`);
  }
  assertShape(db, CURRENT_SCHEMA_SQL, `${CURRENT_SCHEMA_ID} revision ${CURRENT_SCHEMA_VERSION}`);
  validateJournal(db);
}

export function initializeSqliteSchema(db: Database.Database, appliedAt = Date.now()): void {
  const objectCount = (db.prepare(`SELECT COUNT(*) AS count FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'`).get() as { count: number }).count;
  if (objectCount === 0) {
    db.transaction(() => {
      db.exec(BASE_SCHEMA_SQL);
      setUserVersion(db, BASE_SCHEMA_VERSION);
    }).immediate();
  }

  assertMarker(db);
  let version = userVersion(db);
  if (version === 0) {
    // Databases created by Core <=0.8.5 predate PRAGMA user_version. Their exact
    // shape is the durable proof that they are the revision-1 migration source.
    assertShape(db, BASE_SCHEMA_SQL, `${CURRENT_SCHEMA_ID} legacy revision ${BASE_SCHEMA_VERSION}`);
    version = BASE_SCHEMA_VERSION;
  }
  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`SQLite schema revision ${version} is newer than supported revision ${CURRENT_SCHEMA_VERSION}`);
  }
  if (version === BASE_SCHEMA_VERSION) {
    assertShape(db, BASE_SCHEMA_SQL, `${CURRENT_SCHEMA_ID} revision ${BASE_SCHEMA_VERSION}`);
  }

  const pending = MIGRATIONS.filter((migration) => migration.version > version);
  if (pending.length) {
    applySqliteMigrations(db, pending, appliedAt);
  }
  assertCurrentSqliteSchema(db);
}

export function getSqliteSchemaVersion(db: Database.Database): number {
  return userVersion(db);
}
