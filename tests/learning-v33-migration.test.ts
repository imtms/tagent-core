import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLearningIntegrationV33Schema,
  migrateLearningIntegrationV33,
  prepareLearningIntegrationV33,
} from "@tagent/persistence-sqlite/migrations";
import { Store } from "@tagent/persistence-sqlite/store";

const databases: Database.Database[] = [];

afterEach(() => databases.splice(0).reverse().forEach((db) => db.close()));

function v32Fixture(): Database.Database {
  const db = new Database(":memory:");
  databases.push(db);
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE schema_meta (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      request_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      phase TEXT NOT NULL,
      goal TEXT NOT NULL,
      gate_required INTEGER NOT NULL DEFAULT 1,
      blocked_reason TEXT NOT NULL DEFAULT '',
      last_event_seq INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      attempt INTEGER NOT NULL DEFAULT 1,
      resumed_at INTEGER,
      usage_input INTEGER NOT NULL DEFAULT 0,
      usage_output INTEGER NOT NULL DEFAULT 0,
      usage_cache_read INTEGER NOT NULL DEFAULT 0,
      usage_cache_write INTEGER NOT NULL DEFAULT 0,
      usage_total_tokens INTEGER NOT NULL DEFAULT 0,
      usage_cost REAL NOT NULL DEFAULT 0,
      contract_json TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE attempts (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      ordinal INTEGER NOT NULL,
      trigger TEXT NOT NULL,
      status TEXT NOT NULL,
      active INTEGER NOT NULL,
      version INTEGER NOT NULL,
      legacy_event_seq INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      reconstruction_state TEXT NOT NULL
    );
    CREATE TABLE run_events (
      run_id TEXT NOT NULL REFERENCES runs(id),
      seq INTEGER NOT NULL,
      attempt_id TEXT,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, seq)
    );
    CREATE TABLE run_checkpoints (
      run_id TEXT PRIMARY KEY REFERENCES runs(id),
      attempt INTEGER NOT NULL,
      attempt_id TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      assistant_partial TEXT NOT NULL DEFAULT '',
      current_tool_json TEXT NOT NULL DEFAULT '',
      last_event_seq INTEGER NOT NULL DEFAULT 0,
      last_transcript_seq INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE learning_projection_outbox (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      attempt INTEGER NOT NULL,
      lifecycle TEXT NOT NULL,
      outcome TEXT NOT NULL,
      event_seq INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL DEFAULT '{}',
      snapshot_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','processing','completed','failed')),
      error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      attempt_id TEXT,
      UNIQUE(run_id, attempt, lifecycle, event_seq)
    );
    CREATE INDEX idx_learning_projection_pending
      ON learning_projection_outbox(status, created_at);
    INSERT INTO schema_meta VALUES (1,32,1);
    INSERT INTO sessions VALUES ('session-1');
    INSERT INTO runs
      (id,session_id,request_id,status,phase,goal,last_event_seq,created_at,updated_at,completed_at,attempt)
    VALUES ('run-1','session-1','request-1','completed','done','migration fixture',1,1,30,30,1);
    INSERT INTO attempts
      (id,run_id,ordinal,trigger,status,active,version,legacy_event_seq,started_at,updated_at,
       completed_at,reconstruction_state)
    VALUES ('attempt:run-1:1','run-1',1,'initial','completed',0,2,1,1,30,30,'complete');
    INSERT INTO run_events
      (run_id,seq,attempt_id,type,data,created_at)
    VALUES ('run-1',1,'attempt:run-1:1','run.completed','{"reason":"done"}',20);
    INSERT INTO run_checkpoints
      (run_id,attempt,attempt_id,active,last_event_seq,last_transcript_seq,updated_at)
    VALUES ('run-1',1,'attempt:run-1:1',0,1,0,30);
  `);
  return db;
}

function insertLegacy(
  db: Database.Database,
  input: {
    id: string;
    lifecycle: string;
    eventSeq: number;
    createdAt: number;
    payloadJson?: string;
    snapshotJson?: string;
  },
): void {
  db.prepare(`INSERT INTO learning_projection_outbox
    (id,run_id,attempt,lifecycle,outcome,event_seq,payload_json,snapshot_json,status,error,
     created_at,updated_at,attempt_id)
    VALUES (?, 'run-1',1,?,'completed',?,?,?,'pending','',?,?,'attempt:run-1:1')`).run(
    input.id,
    input.lifecycle,
    input.eventSeq,
    input.payloadJson ?? '{"reason":"done"}',
    input.snapshotJson ?? '{"id":"run-1","attempt":1,"status":"completed"}',
    input.createdAt,
    input.createdAt,
  );
}

function migrateV33(db: Database.Database, previousVersion: 32 | 33 = 32): void {
  prepareLearningIntegrationV33(db, previousVersion, 100);
  db.transaction(() => {
    migrateLearningIntegrationV33(db, previousVersion, 100);
    db.prepare("UPDATE schema_meta SET version=33,updated_at=100 WHERE id=1").run();
  })();
}

function schemaObject(db: Database.Database, name: string) {
  return db.prepare("SELECT type,name,tbl_name as tableName,sql FROM sqlite_master WHERE name=?")
    .get(name) as { type: string; name: string; tableName: string; sql: string } | undefined;
}

describe("Learning integration schema v33 migration", () => {
  it("backfills event-bound and synthetic legacy rows with one strict, gap-free shared sequence", () => {
    const db = v32Fixture();
    insertLegacy(db, { id: "legacy-event", lifecycle: "run.completed", eventSeq: 1, createdAt: 20 });
    insertLegacy(db, { id: "legacy-synthetic", lifecycle: "run.blocked", eventSeq: 0, createdAt: 10 });

    migrateV33(db);
    assertLearningIntegrationV33Schema(db);

    expect(db.prepare(`SELECT id,outbox_sequence as sequence,source_event_id as sourceEventId,
      length(payload_hash) as hashLength FROM learning_projection_outbox ORDER BY outbox_sequence`).all())
      .toEqual([
        {
          id: "legacy-synthetic",
          sequence: 1,
          sourceEventId: expect.stringMatching(
            /^run:run-1:synthetic:run\.blocked:attempt:run-1:1:1:[a-f0-9]{64}$/,
          ),
          hashLength: 64,
        },
        {
          id: "legacy-event",
          sequence: 2,
          sourceEventId: "run:run-1:event:1",
          hashLength: 64,
        },
      ]);
    expect(db.prepare(`SELECT outbox_sequence as sequence,source_event_id as sourceEventId,
      event_id as eventId FROM integration_outbox ORDER BY outbox_sequence`).all())
      .toEqual([
        {
          sequence: 1,
          sourceEventId: expect.stringMatching(/^run:run-1:synthetic:/),
          eventId: expect.stringMatching(/^integration:[a-f0-9]{64}$/),
        },
        {
          sequence: 2,
          sourceEventId: "run:run-1:event:1",
          eventId: expect.stringMatching(/^integration:[a-f0-9]{64}$/),
        },
      ]);
    expect(db.prepare("SELECT next_sequence as nextSequence FROM integration_stream_sequence WHERE id=1").get())
      .toEqual({ nextSequence: 3 });
    expect(db.prepare(`SELECT legacy.outbox_sequence as legacySequence,
      integration.outbox_sequence as integrationSequence
      FROM learning_projection_outbox legacy JOIN integration_outbox integration
        ON integration.source_event_id=legacy.source_event_id ORDER BY legacy.outbox_sequence`).all())
      .toEqual([
        { legacySequence: 1, integrationSequence: 1 },
        { legacySequence: 2, integrationSequence: 2 },
      ]);
    const evidence = JSON.parse((db.prepare(`SELECT evidence_snapshot_json evidence
      FROM integration_outbox WHERE source_event_id='run:run-1:event:1'`).get() as { evidence: string }).evidence) as Record<string, unknown>;
    expect(evidence).toMatchObject({
      taskRun: { id: "run-1", attempt: 1, status: "completed" },
      attempt: { id: "attempt:run-1:1", ordinal: 1 },
      checkpoint: { runId: "run-1", attempt: 1, lastEventSeq: 1 },
      runEventRef: { runId: "run-1", seq: 1, type: "run.completed" },
    });
  });

  it("is exactly re-entrant without reallocating sequence or changing canonical rows", () => {
    const db = v32Fixture();
    insertLegacy(db, { id: "legacy-event", lifecycle: "run.completed", eventSeq: 1, createdAt: 20 });
    migrateV33(db);
    const before = db.prepare(`SELECT * FROM integration_outbox ORDER BY outbox_sequence`).all();
    const legacyBefore = db.prepare(`SELECT * FROM learning_projection_outbox ORDER BY outbox_sequence`).all();

    migrateV33(db, 33);

    expect(db.prepare(`SELECT * FROM integration_outbox ORDER BY outbox_sequence`).all()).toEqual(before);
    expect(db.prepare(`SELECT * FROM learning_projection_outbox ORDER BY outbox_sequence`).all()).toEqual(legacyBefore);
    expect(db.prepare("SELECT next_sequence as nextSequence FROM integration_stream_sequence WHERE id=1").get())
      .toEqual({ nextSequence: 2 });
    expect(db.prepare("SELECT version FROM schema_meta WHERE id=1").get()).toEqual({ version: 33 });
  });

  it("uses the immutable historical checkpoint when the live Run has advanced to another Attempt", () => {
    const db = v32Fixture();
    db.exec(`
      INSERT INTO attempts
        (id,run_id,ordinal,trigger,status,active,version,legacy_event_seq,started_at,updated_at,
         completed_at,reconstruction_state)
      VALUES ('attempt:run-1:2','run-1',2,'resume','running',1,1,1,40,40,NULL,'complete');
      UPDATE runs SET status='running',phase='execute',attempt=2,updated_at=40,completed_at=NULL WHERE id='run-1';
      UPDATE run_checkpoints SET attempt=2,attempt_id='attempt:run-1:2',active=1,updated_at=40 WHERE run_id='run-1';
    `);
    insertLegacy(db, {
      id: "legacy-attempt-1",
      lifecycle: "run.completed",
      eventSeq: 1,
      createdAt: 20,
      snapshotJson: JSON.stringify({
        id: "run-1",
        attempt: 1,
        status: "completed",
        checkpoint: {
          runId: "run-1",
          attempt: 1,
          active: false,
          assistantPartial: "",
          currentTool: null,
          lastEventSeq: 1,
          lastTranscriptSeq: 0,
          updatedAt: 30,
        },
      }),
    });

    migrateV33(db);

    const evidence = JSON.parse((db.prepare("SELECT evidence_snapshot_json evidence FROM integration_outbox")
      .get() as { evidence: string }).evidence) as { checkpoint: { attempt: number } };
    expect(evidence.checkpoint).toMatchObject({ attempt: 1 });
  });

  it("durably records malformed historical snapshots and refuses the v33 main transaction", () => {
    const db = v32Fixture();
    insertLegacy(db, {
      id: "legacy-malformed",
      lifecycle: "run.completed",
      eventSeq: 1,
      createdAt: 20,
      snapshotJson: "{not-json",
    });

    expect(() => prepareLearningIntegrationV33(db, 32, 100)).toThrow(/Learning integration v33 preflight/);

    expect(db.prepare(`SELECT code,source_ref as sourceRef,status FROM migration_issues
      WHERE migration_version=33`).all()).toEqual([
      { code: "malformed_snapshot", sourceRef: "learning_projection_outbox:legacy-malformed", status: "open" },
    ]);
    expect(schemaObject(db, "integration_outbox")).toBeUndefined();
    expect(db.prepare("SELECT version FROM schema_meta WHERE id=1").get()).toEqual({ version: 32 });
  });

  it("resolves a durable preflight issue only after the historical row is repaired", () => {
    const db = v32Fixture();
    insertLegacy(db, {
      id: "legacy-repairable",
      lifecycle: "run.completed",
      eventSeq: 1,
      createdAt: 20,
      snapshotJson: "{not-json",
    });
    expect(() => prepareLearningIntegrationV33(db, 32, 100)).toThrow(/preflight blocked/);

    db.prepare(`UPDATE learning_projection_outbox SET snapshot_json=? WHERE id='legacy-repairable'`)
      .run('{"id":"run-1","attempt":1,"status":"completed"}');
    expect(() => prepareLearningIntegrationV33(db, 32, 200)).not.toThrow();

    expect(db.prepare(`SELECT status,resolved_at as resolvedAt FROM migration_issues
      WHERE migration_version=33 AND code='malformed_snapshot'`).get())
      .toEqual({ status: "resolved", resolvedAt: 200 });
  });

  it("keeps a v32 canonical source collision at version 32 with a durable issue", () => {
    const db = v32Fixture();
    insertLegacy(db, { id: "legacy-completed", lifecycle: "run.completed", eventSeq: 1, createdAt: 20 });
    insertLegacy(db, { id: "legacy-failed", lifecycle: "run.failed", eventSeq: 1, createdAt: 21 });

    expect(() => prepareLearningIntegrationV33(db, 32, 100)).toThrow(/preflight blocked/);

    expect(db.prepare(`SELECT code,status FROM migration_issues WHERE migration_version=33 AND status='open'`).all())
      .toContainEqual({ code: "duplicate_source_event", status: "open" });
    expect(db.prepare("SELECT version FROM schema_meta WHERE id=1").get()).toEqual({ version: 32 });
  });

  it("fails closed on canonical identity or hash disagreement during a v33 re-entry", () => {
    const db = v32Fixture();
    insertLegacy(db, { id: "legacy-event", lifecycle: "run.completed", eventSeq: 1, createdAt: 20 });
    migrateV33(db);
    db.exec("DROP TRIGGER integration_outbox_immutable_update");
    db.prepare("UPDATE integration_outbox SET payload_hash='different' WHERE outbox_sequence=1").run();

    expect(() => prepareLearningIntegrationV33(db, 33, 200)).toThrow(/Learning integration v33 preflight/);
    expect(db.prepare(`SELECT code,status FROM migration_issues WHERE migration_version=33 AND status='open'`).all())
      .toContainEqual({ code: "integration_conflict", status: "open" });
    expect(db.prepare("SELECT version FROM schema_meta WHERE id=1").get()).toEqual({ version: 33 });
  });

  it("records a missing canonical integration row instead of recreating it during v33 re-entry", () => {
    const db = v32Fixture();
    insertLegacy(db, { id: "legacy-event", lifecycle: "run.completed", eventSeq: 1, createdAt: 20 });
    migrateV33(db);
    db.exec("DROP TRIGGER integration_outbox_immutable_delete");
    db.prepare("DELETE FROM integration_outbox WHERE outbox_sequence=1").run();

    expect(() => prepareLearningIntegrationV33(db, 33, 200)).toThrow(/preflight blocked/);

    expect(db.prepare(`SELECT code,status FROM migration_issues WHERE migration_version=33 AND status='open'`).all())
      .toContainEqual({ code: "integration_missing", status: "open" });
    expect(db.prepare("SELECT COUNT(*) count FROM integration_outbox").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT version FROM schema_meta WHERE id=1").get()).toEqual({ version: 33 });
  });

  it("rejects incompatible same-name schema objects and rolls back every main-v33 object", () => {
    const db = v32Fixture();
    insertLegacy(db, { id: "legacy-event", lifecycle: "run.completed", eventSeq: 1, createdAt: 20 });
    db.exec("CREATE TABLE integration_outbox (outbox_sequence INTEGER PRIMARY KEY, incompatible TEXT)");
    prepareLearningIntegrationV33(db, 32, 100);

    expect(() => db.transaction(() => migrateLearningIntegrationV33(db, 32, 100))())
      .toThrow(/Learning integration v33 schema/);

    expect(schemaObject(db, "integration_outbox")?.sql).toContain("incompatible TEXT");
    expect(schemaObject(db, "integration_stream_sequence")).toBeUndefined();
    expect(schemaObject(db, "migration_issues")).toBeDefined();
    expect(db.prepare("SELECT version FROM schema_meta WHERE id=1").get()).toEqual({ version: 32 });
  });

  it("opens a production Store at schema version 42 with the complete v33 foundation", () => {
    const store = new Store(":memory:", { deferPostMigrationRecovery: true });
    databases.push(store.db);

    expect(store.getSchemaVersion()).toBe(42);
    assertLearningIntegrationV33Schema(store.db);
    expect(dbObjectNames(store.db)).toEqual(expect.arrayContaining([
      "integration_stream_sequence",
      "integration_outbox",
      "integration_consumer_delivery",
      "learning_projection_checkpoint",
      "learning_projection_authority_state",
      "integration_reconciliation",
      "effect_receipts",
      "migration_issues",
    ]));
  });
});

function dbObjectNames(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>)
    .map((row) => row.name);
}
