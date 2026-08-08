import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  LEGACY_WORKFLOW_APPROVAL_SCOPE_TYPE,
  RUN_APPROVAL_SCOPE_TYPE,
  operationDigest,
} from "@tagent/governance";
import { migrateGovernanceV31 } from "@tagent/persistence-sqlite/migrations";
import { Store } from "@tagent/persistence-sqlite/store";
import { CoreWriterLease, WriterFenceGuard } from "@tagent/persistence-sqlite/writer";

const databases: Database.Database[] = [];

afterEach(() => databases.splice(0).reverse().forEach((db) => db.close()));

function v30Fixture() {
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
    INSERT INTO sessions VALUES ('session-from-run'), ('session-metadata');
    INSERT INTO runs VALUES
      ('run-metadata', 'session-from-run'),
      ('run-fallback', 'session-from-run'),
      ('run-approved', 'session-from-run');
    INSERT INTO approval_requests
      (id,run_id,decision_id,action_type,target_type,target_id,reason,metadata_json,status,requested_at)
    VALUES
      ('run-approval-metadata','run-metadata','decision-1','resume_taskrun','taskrun','run-metadata',
       'resume requested','{"sessionId":"session-metadata","requestedBy":"supervisor"}','pending',100),
      ('run-approval-fallback','run-fallback','decision-2','resume_taskrun','taskrun','run-fallback',
       'resume rejected','{}','rejected',101),
      ('run-approval-approved','run-approved','decision-3','resume_taskrun','taskrun','run-approved',
       'historically approved','{}','approved',102);
    INSERT INTO autonomy_approval_requests
      (id,scope_id,action_type,target_type,target_id,workflow_id,revision_id,proposal_id,binding_id,status,risk_class,
       impact_scope_json,evidence_json,diff_json,rollback_json,requested_by,request_reason,expires_at,
       decided_by,decision_reason,decided_at,executed_at,execution_receipt_json,request_hash,created_at,updated_at)
    VALUES
      ('workflow-pending','workflow-scope','activate_workflow','workflow_revision','revision-1','workflow-1','revision-1',NULL,NULL,
       'pending','low','{"futureRuns":true,"scopeId":"workflow-scope"}','[]',
       '{"toStatus":"active","toRevisionId":"revision-1"}','{"action":"restore"}',
       'governor','activate',999999,'','',NULL,NULL,'{}','legacy-request-hash-must-not-be-used',200,200),
      ('workflow-executed','workflow-scope','execute_workflow','capability-target','target-2','workflow-2',NULL,NULL,'binding-2',
       'executed','high','{"resource":"workspace"}','[]','{"mode":"write"}','{"action":"restore"}',
       'governor','execute',999999,'operator','approved',299,300,
       '{"actionType":"execute_workflow","targetId":"target-2","result":{"ok":true},"executedBy":"operator","executedAt":300}',
       'legacy-executed-request-hash',250,300);
  `);
  return db;
}

function tableSnapshot(db: Database.Database) {
  return {
    run: db.prepare(`SELECT id,scope_type as scopeType,scope_id as scopeId,operation_digest as operationDigest,
      risk_class as riskClass,expires_at as expiresAt,reuse_mode as reuseMode,max_uses as maxUses,
      used_count as usedCount FROM approval_requests ORDER BY id`).all(),
    workflow: db.prepare(`SELECT id,operation_digest as operationDigest,reuse_mode as reuseMode,
      max_uses as maxUses,used_count as usedCount FROM autonomy_approval_requests ORDER BY id`).all(),
    receipts: db.prepare("SELECT * FROM approval_receipts ORDER BY id").all(),
  };
}

function legacyDataSnapshot(db: Database.Database) {
  return {
    run: db.prepare("SELECT * FROM approval_requests ORDER BY id").all(),
    workflow: db.prepare("SELECT * FROM autonomy_approval_requests ORDER BY id").all(),
    receipts: db.prepare("SELECT * FROM approval_receipts ORDER BY id").all() as unknown[] | undefined,
  };
}

function createReceiptTable(
  db: Database.Database,
  unique = "UNIQUE(approval_source, approval_id, operation_id, outcome)",
): void {
  db.exec(`CREATE TABLE approval_receipts (
    id TEXT PRIMARY KEY,
    approval_source TEXT NOT NULL CHECK (approval_source IN ('legacy_run','legacy_workflow')),
    approval_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    operation_digest TEXT NOT NULL,
    outcome TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    details_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
    ${unique ? `,${unique}` : ""}
  )`);
}

function expectSchemaReentryFailure(db: Database.Database): void {
  const before = legacyDataSnapshot(db);
  const schemaVersion = db.pragma("schema_version", { simple: true });
  expect(() => db.transaction(() => migrateGovernanceV31(db, 31, 800))())
    .toThrow(/Governance v31 schema/);
  expect(legacyDataSnapshot(db)).toEqual(before);
  expect(db.pragma("schema_version", { simple: true })).toBe(schemaVersion);
}

describe("Governance schema v31 migration", () => {
  it("additively and reentrantly backfills v30 approvals without copying workflow request_hash", () => {
    const db = v30Fixture();
    db.transaction(() => migrateGovernanceV31(db, 30, 500))();

    const runRows = tableSnapshot(db).run;
    expect(runRows).toEqual([
      expect.objectContaining({
        id: "run-approval-approved",
        scopeType: RUN_APPROVAL_SCOPE_TYPE,
        scopeId: "session-from-run",
        riskClass: "medium",
        expiresAt: null,
        reuseMode: "one_time",
        maxUses: 1,
        usedCount: null,
      }),
      expect.objectContaining({
        id: "run-approval-fallback",
        scopeType: RUN_APPROVAL_SCOPE_TYPE,
        scopeId: "session-from-run",
        riskClass: "medium",
        expiresAt: null,
        reuseMode: "one_time",
        maxUses: 1,
        usedCount: 0,
      }),
      expect.objectContaining({
        id: "run-approval-metadata",
        scopeType: RUN_APPROVAL_SCOPE_TYPE,
        scopeId: "session-metadata",
        riskClass: "medium",
        expiresAt: null,
        reuseMode: "one_time",
        maxUses: 1,
        usedCount: 0,
      }),
    ]);
    expect(runRows.every((row) => (row as { operationDigest: string }).operationDigest
      .startsWith("tagent.approval.operation.sha256.v1:"))).toBe(true);

    const workflowRows = tableSnapshot(db).workflow as Array<{
      id: string; operationDigest: string; reuseMode: string; maxUses: number; usedCount: number;
    }>;
    expect(workflowRows).toEqual([
      expect.objectContaining({ id: "workflow-executed", reuseMode: "one_time", maxUses: 1, usedCount: 1 }),
      expect.objectContaining({ id: "workflow-pending", reuseMode: "one_time", maxUses: 1, usedCount: 0 }),
    ]);
    const pending = workflowRows.find((row) => row.id === "workflow-pending")!;
    expect(pending.operationDigest).not.toBe("legacy-request-hash-must-not-be-used");
    expect(pending.operationDigest).toBe(operationDigest({
      subject: { kind: "workflow", id: "workflow-1" },
      action: "workflow.activate",
      target: { kind: "workflow_revision", id: "revision-1" },
      scope: { type: LEGACY_WORKFLOW_APPROVAL_SCOPE_TYPE, id: "workflow-scope" },
      payload: {
        workflowId: "workflow-1",
        revisionId: "revision-1",
        impactScope: { futureRuns: true, scopeId: "workflow-scope" },
        diff: { toStatus: "active", toRevisionId: "revision-1" },
        rollback: { action: "restore" },
      },
    }));

    expect(tableSnapshot(db).receipts).toEqual([expect.objectContaining({
      id: "approval-receipt:legacy_workflow:workflow-executed:executed",
      approval_source: "legacy_workflow",
      approval_id: "workflow-executed",
      operation_id: "legacy-workflow-approval:workflow-executed",
      operation_digest: workflowRows.find((row) => row.id === "workflow-executed")!.operationDigest,
      outcome: "executed",
      actor_id: "operator",
      created_at: 300,
    })]);

    const first = tableSnapshot(db);
    db.transaction(() => migrateGovernanceV31(db, 31, 700))();
    expect(tableSnapshot(db)).toEqual(first);
  });

  it("fails closed and rolls the whole migration back for uncertain semantic input", () => {
    for (const corruption of [
      "UPDATE approval_requests SET metadata_json='[]' WHERE id='run-approval-metadata'",
      "UPDATE autonomy_approval_requests SET impact_scope_json='[]' WHERE id='workflow-pending'",
      "UPDATE autonomy_approval_requests SET execution_receipt_json='{}' WHERE id='workflow-executed'",
    ]) {
      const db = v30Fixture();
      db.exec(corruption);
      expect(() => db.transaction(() => migrateGovernanceV31(db, 30, 500))()).toThrow(/Governance v31/);
      expect(db.prepare("PRAGMA table_info(approval_requests)").all())
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "operation_digest" })]));
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='approval_receipts'").get())
        .toBeUndefined();
      databases.splice(databases.indexOf(db), 1);
      db.close();
    }
  });

  it("fails re-entry on canonical field or deterministic receipt conflicts", () => {
    const db = v30Fixture();
    db.transaction(() => migrateGovernanceV31(db, 30, 500))();
    const operationDigest = (db.prepare(`SELECT operation_digest as operationDigest
      FROM approval_requests WHERE id='run-approval-metadata'`).get() as { operationDigest: string }).operationDigest;
    db.prepare("UPDATE approval_requests SET operation_digest='wrong' WHERE id='run-approval-metadata'").run();
    expect(() => db.transaction(() => migrateGovernanceV31(db, 31, 600))())
      .toThrow(/Governance v31 backfill conflict/);

    db.prepare("UPDATE approval_requests SET operation_digest=? WHERE id='run-approval-metadata'").run(operationDigest);
    db.exec("DROP TRIGGER approval_receipts_append_only_update");
    db.prepare("UPDATE approval_receipts SET actor_id='wrong' WHERE approval_id='workflow-executed'").run();
    expect(() => db.transaction(() => migrateGovernanceV31(db, 31, 600))())
      .toThrow(/Governance v31 receipt conflict/);

    const missingReceiptDb = v30Fixture();
    missingReceiptDb.transaction(() => migrateGovernanceV31(missingReceiptDb, 30, 500))();
    missingReceiptDb.exec("DROP TRIGGER approval_receipts_append_only_delete");
    missingReceiptDb.prepare("DELETE FROM approval_receipts WHERE approval_id='workflow-executed'").run();
    expect(() => missingReceiptDb.transaction(() => migrateGovernanceV31(missingReceiptDb, 31, 600))())
      .toThrow(/Governance v31 receipt conflict/);
  });

  it("fails schema re-entry on same-name columns with wrong types or missing critical checks", () => {
    for (const invalidColumn of [
      "ALTER TABLE approval_requests ADD COLUMN operation_digest INTEGER",
      "ALTER TABLE approval_requests ADD COLUMN risk_class TEXT",
      "ALTER TABLE autonomy_approval_requests ADD COLUMN reuse_mode TEXT",
      "ALTER TABLE autonomy_approval_requests ADD COLUMN used_count INTEGER",
    ]) {
      const db = v30Fixture();
      createReceiptTable(db);
      db.exec(invalidColumn);
      expectSchemaReentryFailure(db);
      databases.splice(databases.indexOf(db), 1);
      db.close();
    }
  });

  it("fails schema re-entry when the receipt uniqueness or required indexes are malformed", () => {
    const fixtures: Array<(db: Database.Database) => void> = [
      (db) => createReceiptTable(db, ""),
      (db) => createReceiptTable(db, "UNIQUE(approval_source, approval_id, operation_id)"),
      (db) => {
        createReceiptTable(db);
        db.exec(`CREATE INDEX idx_approval_receipts_approval
          ON approval_receipts(approval_source,approval_id,id)`);
      },
      (db) => {
        createReceiptTable(db);
        db.exec(`CREATE INDEX idx_approval_receipts_operation_digest
          ON approval_receipts(operation_digest,id)`);
      },
    ];
    for (const arrange of fixtures) {
      const db = v30Fixture();
      arrange(db);
      expectSchemaReentryFailure(db);
      databases.splice(databases.indexOf(db), 1);
      db.close();
    }
  });

  it("fails schema re-entry for same-name append-only triggers with the wrong binding, operation, or body", () => {
    const invalidTriggers = [
      `CREATE TRIGGER approval_receipts_append_only_update
        BEFORE UPDATE ON approval_receipts BEGIN SELECT 1; END`,
      `CREATE TRIGGER approval_receipts_append_only_update
        BEFORE UPDATE ON sessions BEGIN
          SELECT RAISE(ABORT, 'approval_receipts is append-only');
        END`,
      `CREATE TRIGGER approval_receipts_append_only_delete
        BEFORE INSERT ON approval_receipts BEGIN
          SELECT RAISE(ABORT, 'approval_receipts is append-only');
        END`,
    ];
    for (const trigger of invalidTriggers) {
      const db = v30Fixture();
      createReceiptTable(db);
      db.exec(trigger);
      expectSchemaReentryFailure(db);
      databases.splice(databases.indexOf(db), 1);
      db.close();
    }
  });

  it("opens Store at v34, preserves legacy APIs, and guards the receipt table", () => {
    const store = new Store(":memory:", { deferPostMigrationRecovery: true });
    databases.push(store.db);
    expect(store.getSchemaVersion()).toBe(38);
    const session = store.createSession("legacy authority", "session-v31");
    const run = store.createRun(session.id, "legacy run", "run-v31");
    store.db.prepare(`INSERT INTO supervisor_decisions
      (id,run_id,attempt,checkpoint_seq,trigger,action,reason_code,rationale,confidence,status,created_at)
      VALUES ('decision-v31',?,1,0,'manual','pause_for_approval','approval_required','approval',1,'executed',1)`).run(run.id);
    expect(store.ensureApprovalRequest(run.id, "decision-v31", "approval")).toMatchObject({ status: "pending" });

    const lease = CoreWriterLease.claim(store.db, {
      ownerId: "migration-writer", pid: process.pid, host: "test-host",
    })!;
    const guard = new WriterFenceGuard(store.db, lease.authority);
    const installed = guard.installConnectionGuard();
    expect(installed.tables).toContain("approval_receipts");
    expect(installed.triggerCount).toBe(installed.tables.length * 3);
    guard.run((db: Database.Database) => db.prepare(`INSERT INTO approval_receipts
      (id,approval_source,approval_id,operation_id,operation_digest,outcome,actor_id,details_json,created_at)
      VALUES ('receipt-current','legacy_run','missing','operation-current','digest','authorized','actor','{}',1)`).run());
    expect(() => store.db.prepare("UPDATE approval_receipts SET actor_id='changed' WHERE id='receipt-current'").run())
      .toThrow(/append-only/);
    expect(() => store.db.prepare("DELETE FROM approval_receipts WHERE id='receipt-current'").run())
      .toThrow(/append-only/);
  });
});
