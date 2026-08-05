import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  migrateCapabilityAuthorizationV32,
  migrateGovernanceV31,
} from "@tagent/persistence-sqlite/migrations";
import { Store } from "@tagent/persistence-sqlite/store";

const databases: Database.Database[] = [];
const directories: string[] = [];

afterEach(() => {
  databases.splice(0).reverse().forEach((db) => {
    if (db.open) db.close();
  });
  directories.splice(0).reverse().forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

function v31Fixture(): Database.Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT REFERENCES sessions(id));
    CREATE TABLE approval_requests (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      decision_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_at INTEGER NOT NULL,
      resolved_at INTEGER,
      resolved_by TEXT NOT NULL DEFAULT '',
      resolution TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE autonomy_approval_requests (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL,
      action_type TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      workflow_id TEXT,
      revision_id TEXT,
      proposal_id TEXT,
      binding_id TEXT,
      status TEXT NOT NULL,
      risk_class TEXT NOT NULL,
      impact_scope_json TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      diff_json TEXT NOT NULL,
      rollback_json TEXT NOT NULL,
      requested_by TEXT NOT NULL,
      request_reason TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      decided_by TEXT NOT NULL DEFAULT '',
      decision_reason TEXT NOT NULL DEFAULT '',
      decided_at INTEGER,
      executed_at INTEGER,
      execution_receipt_json TEXT NOT NULL DEFAULT '{}',
      request_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE operations (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      attempt INTEGER NOT NULL,
      attempt_id TEXT,
      operation_type TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      effects_json TEXT NOT NULL DEFAULT '[]',
      result_json TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    INSERT INTO sessions VALUES ('session-1');
    INSERT INTO runs VALUES ('run-1','session-1');
    INSERT INTO approval_requests
      (id,run_id,decision_id,action_type,target_type,target_id,reason,metadata_json,status,requested_at)
    VALUES
      ('run-pending','run-1','decision-pending','resume_taskrun','taskrun','run-1','resume','{}','pending',1),
      ('run-approved','run-1','decision-approved','resume_taskrun','taskrun','run-1','resume','{}','approved',2);
    INSERT INTO autonomy_approval_requests
      (id,scope_id,action_type,target_type,target_id,workflow_id,revision_id,proposal_id,binding_id,status,risk_class,
       impact_scope_json,evidence_json,diff_json,rollback_json,requested_by,request_reason,expires_at,
       decided_by,decision_reason,decided_at,executed_at,execution_receipt_json,request_hash,created_at,updated_at)
    VALUES
      ('workflow-pending','workflow-scope','activate_workflow','workflow_revision','revision-1',
       'workflow-1','revision-1',NULL,NULL,'pending','medium','{"scopeId":"workflow-scope"}','[]',
       '{"toRevisionId":"revision-1"}','{"action":"restore"}','governor','activate',999999,
       '','',NULL,NULL,'{}','request-hash',3,3);
  `);
  db.transaction(() => migrateGovernanceV31(db, 30, 10))();
  return db;
}

function migrateV32(db: Database.Database): void {
  db.transaction(() => migrateCapabilityAuthorizationV32(db, 31, 20))();
}

function schemaObject(db: Database.Database, name: string) {
  return db.prepare("SELECT type,name,tbl_name as tableName,sql FROM main.sqlite_master WHERE name=?")
    .get(name) as { type: string; name: string; tableName: string; sql: string } | undefined;
}

describe("Capability authorization schema v32 migration", () => {
  it("adds only the authorization uniqueness, Attempt lookup, and immutable operation identity controls", () => {
    const db = v31Fixture();
    const tablesBefore = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();

    migrateV32(db);

    expect(db.prepare("SELECT name,\"unique\" as isUnique,partial FROM pragma_index_list('approval_receipts') WHERE name='idx_approval_receipts_one_allow_per_operation'").get())
      .toEqual({ name: "idx_approval_receipts_one_allow_per_operation", isUnique: 1, partial: 1 });
    expect(db.prepare("SELECT name FROM pragma_index_info('idx_approval_receipts_one_allow_per_operation') ORDER BY seqno").all())
      .toEqual([{ name: "operation_id" }]);
    expect(schemaObject(db, "idx_approval_receipts_one_allow_per_operation")?.sql.toLowerCase())
      .toContain("where outcome='allow'");
    expect(db.prepare("SELECT name,\"unique\" as isUnique,partial FROM pragma_index_list('operations') WHERE name='idx_operations_attempt_created'").get())
      .toEqual({ name: "idx_operations_attempt_created", isUnique: 0, partial: 0 });
    expect(db.prepare("SELECT name FROM pragma_index_info('idx_operations_attempt_created') ORDER BY seqno").all())
      .toEqual([{ name: "attempt_id" }, { name: "created_at" }, { name: "id" }]);
    expect(schemaObject(db, "operations_identity_immutable")).toMatchObject({
      type: "trigger",
      tableName: "operations",
    });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual(tablesBefore);

    db.prepare(`INSERT INTO operations
      (id,run_id,attempt,attempt_id,operation_type,payload_hash,status,stage,created_at,updated_at)
      VALUES ('operation-1','run-1',1,'attempt:run-1:1','workspace.write','digest','running','executing',1,1)`).run();
    expect(() => db.prepare(`UPDATE operations SET status='succeeded',stage='settled',result_json='{"ok":true}',
      updated_at=2,completed_at=2 WHERE id='operation-1'`).run()).not.toThrow();
    expect(() => db.prepare("UPDATE operations SET run_id=run_id WHERE id='operation-1'").run())
      .toThrow(/operations identity is immutable/);
  });

  it("is re-entrant and validates every same-name v32 schema object fail-closed", () => {
    const db = v31Fixture();
    migrateV32(db);
    const first = db.prepare(`SELECT type,name,tbl_name as tableName,sql FROM sqlite_master
      WHERE name IN ('idx_approval_receipts_one_allow_per_operation','idx_operations_attempt_created',
        'operations_identity_immutable') ORDER BY name`).all();
    db.transaction(() => migrateCapabilityAuthorizationV32(db, 32, 30))();
    expect(db.prepare(`SELECT type,name,tbl_name as tableName,sql FROM sqlite_master
      WHERE name IN ('idx_approval_receipts_one_allow_per_operation','idx_operations_attempt_created',
        'operations_identity_immutable') ORDER BY name`).all()).toEqual(first);

    const malformed: Array<(candidate: Database.Database) => void> = [
      (candidate) => candidate.exec(`CREATE INDEX idx_approval_receipts_one_allow_per_operation
        ON approval_receipts(operation_id)`),
      (candidate) => candidate.exec(`CREATE INDEX idx_operations_attempt_created
        ON operations(attempt_id,id)`),
      (candidate) => candidate.exec(`CREATE TRIGGER operations_identity_immutable
        BEFORE UPDATE OF status ON operations BEGIN SELECT 1; END`),
    ];
    for (const arrange of malformed) {
      const candidate = v31Fixture();
      arrange(candidate);
      expect(() => migrateV32(candidate)).toThrow(/Capability authorization v32 schema/);
      databases.splice(databases.indexOf(candidate), 1);
      candidate.close();
    }
  });

  it("rolls back the entire upgrade when legacy data has multiple allow receipts for one operation", () => {
    const db = v31Fixture();
    db.prepare(`INSERT INTO approval_receipts
      (id,approval_source,approval_id,operation_id,operation_digest,outcome,actor_id,details_json,created_at)
      VALUES
      ('receipt-1','legacy_run','approval-1','operation-duplicate','digest-1','allow','actor','{}',1),
      ('receipt-2','legacy_workflow','approval-2','operation-duplicate','digest-2','allow','actor','{}',2)`).run();

    expect(() => migrateV32(db)).toThrow(/UNIQUE constraint failed: approval_receipts\.operation_id/);
    expect(schemaObject(db, "idx_approval_receipts_one_allow_per_operation")).toBeUndefined();
    expect(schemaObject(db, "idx_operations_attempt_created")).toBeUndefined();
    expect(schemaObject(db, "operations_identity_immutable")).toBeUndefined();
    expect((db.prepare("SELECT COUNT(*) count FROM approval_receipts").get() as { count: number }).count).toBe(2);
  });

  it("rejects schema-31 canonical NULLs instead of repairing them, while preserving historical approved uncertainty", () => {
    const db = v31Fixture();
    expect(db.prepare("SELECT used_count as usedCount FROM approval_requests WHERE id='run-approved'").get())
      .toEqual({ usedCount: null });
    db.prepare("UPDATE approval_requests SET scope_type=NULL WHERE id='run-pending'").run();

    expect(() => migrateV32(db)).toThrow(/Governance v31 backfill conflict/);
    expect(db.prepare("SELECT scope_type as scopeType FROM approval_requests WHERE id='run-pending'").get())
      .toEqual({ scopeType: null });
    expect(schemaObject(db, "idx_approval_receipts_one_allow_per_operation")).toBeUndefined();

    const workflowDb = v31Fixture();
    workflowDb.prepare("UPDATE autonomy_approval_requests SET operation_digest=NULL WHERE id='workflow-pending'").run();
    expect(() => migrateV32(workflowDb)).toThrow(/Governance v31 backfill conflict/);
    expect(workflowDb.prepare(`SELECT operation_digest as operationDigest
      FROM autonomy_approval_requests WHERE id='workflow-pending'`).get())
      .toEqual({ operationDigest: null });

    const consumedDb = v31Fixture();
    consumedDb.prepare("UPDATE approval_requests SET used_count=1 WHERE id='run-approved'").run();
    consumedDb.prepare(`UPDATE autonomy_approval_requests
      SET status='approved',used_count=1 WHERE id='workflow-pending'`).run();
    expect(() => migrateV32(consumedDb)).not.toThrow();
  });

  it("upgrades a Store at v31 and reopens v33 without invoking the rejecting v31 migration", () => {
    const directory = mkdtempSync(join(tmpdir(), "tagent-governance-v32-"));
    directories.push(directory);
    const filename = join(directory, "core.db");
    const initial = new Store(filename, { deferPostMigrationRecovery: true });
    expect(initial.getSchemaVersion()).toBe(33);
    initial.db.exec(`
      DROP INDEX idx_approval_receipts_one_allow_per_operation;
      DROP INDEX idx_operations_attempt_created;
      DROP TRIGGER operations_identity_immutable;
      UPDATE schema_meta SET version=31 WHERE id=1;
    `);
    initial.close();

    const upgraded = new Store(filename, { deferPostMigrationRecovery: true });
    expect(upgraded.getSchemaVersion()).toBe(33);
    expect(schemaObject(upgraded.db, "operations_identity_immutable")).toBeDefined();
    upgraded.close();

    const reopened = new Store(filename, { deferPostMigrationRecovery: true });
    databases.push(reopened.db);
    expect(reopened.getSchemaVersion()).toBe(33);
  });
});
