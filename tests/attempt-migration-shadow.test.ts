import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { attemptIdFor } from "@tagent/execution/domain";
import { Store } from "@tagent/persistence-sqlite";

function removeV33LearningIntegration(store: Store): void {
  store.db.exec(`
    DROP TABLE integration_consumer_delivery;
    DROP TABLE learning_projection_checkpoint;
    DROP TABLE learning_projection_authority_state;
    DROP TABLE integration_reconciliation;
    DROP TABLE effect_receipts;
    DROP TABLE integration_outbox;
    DROP TABLE integration_stream_sequence;
    DROP TABLE migration_issues;
    DROP TRIGGER learning_projection_outbox_identity_immutable;
    DROP INDEX idx_learning_projection_pending;
    ALTER TABLE learning_projection_outbox RENAME TO learning_projection_outbox_v33;
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
    INSERT INTO learning_projection_outbox
      (id,run_id,attempt,lifecycle,outcome,event_seq,payload_json,snapshot_json,status,error,
       created_at,updated_at,attempt_id)
      SELECT id,run_id,attempt,lifecycle,outcome,event_seq,payload_json,snapshot_json,status,error,
        created_at,updated_at,attempt_id
      FROM learning_projection_outbox_v33;
    DROP TABLE learning_projection_outbox_v33;
  `);
}

describe("Attempt schema v30 migration", () => {
  it("reentrantly backfills v29 runs without changing legacy Run state or event sequence", () => {
    const filename = path.join(mkdtempSync(path.join(tmpdir(), "tagent-attempt-migration-")), "legacy-v29.db");
    const seed = new Store(filename);
    const session = seed.createSession();
    const run = seed.createRun(session.id, "legacy run");
    seed.blockRun(run.id, "resume");
    seed.resumeRun(run.id);
    seed.appendEvent(run.id, "legacy.marker", { stable: true });
    const legacyBefore = seed.db.prepare("SELECT status,attempt,last_event_seq AS lastEventSeq FROM runs WHERE id=?").get(run.id);
    removeV33LearningIntegration(seed);
    seed.db.exec(`
      DROP TABLE attempt_authority_state;
      DROP TABLE attempt_authority_receipts;
      DROP TABLE attempt_shadow_comparisons;
      DROP TABLE attempt_transition_audit;
      DROP TABLE candidate_results;
      DROP TABLE execution_leases;
      DROP TABLE attempts;
      UPDATE schema_meta SET version=29 WHERE id=1;
    `);
    seed.close();

    const migrated = new Store(filename);
    expect(migrated.getSchemaVersion()).toBe(42);
    expect(migrated.db.prepare("SELECT status,attempt,last_event_seq AS lastEventSeq FROM runs WHERE id=?").get(run.id)).toEqual(legacyBefore);
    expect(migrated.db.prepare("SELECT id,ordinal FROM attempts WHERE run_id=? ORDER BY ordinal").all(run.id)).toEqual([
      { id: attemptIdFor(run.id, 1), ordinal: 1 },
      { id: attemptIdFor(run.id, 2), ordinal: 2 },
    ]);
    expect(migrated.db.prepare(`SELECT ordinal,status,reconstruction_state as reconstructionState
      FROM attempts WHERE run_id=? ORDER BY ordinal`).all(run.id)).toEqual([
      { ordinal: 1, status: "legacy_unknown", reconstructionState: "legacy_unknown" },
      { ordinal: 2, status: "running", reconstructionState: "complete" },
    ]);
    expect(migrated.db.prepare("SELECT attempt_id as attemptId FROM run_events WHERE run_id=? ORDER BY seq DESC LIMIT 1").get(run.id))
      .toEqual({ attemptId: attemptIdFor(run.id, 2) });
    const counts = migrated.db.prepare("SELECT (SELECT COUNT(*) FROM attempts) attempts,(SELECT COUNT(*) FROM attempt_transition_audit) audit,(SELECT COUNT(*) FROM attempt_shadow_comparisons) comparisons").get();
    migrated.close();

    const reopened = new Store(filename);
    expect(reopened.db.prepare("SELECT (SELECT COUNT(*) FROM attempts) attempts,(SELECT COUNT(*) FROM attempt_transition_audit) audit,(SELECT COUNT(*) FROM attempt_shadow_comparisons) comparisons").get()).toEqual(counts);
    expect(reopened.db.prepare("SELECT status,attempt,last_event_seq AS lastEventSeq FROM runs WHERE id=?").get(run.id)).toEqual(legacyBefore);
    reopened.close();
  });

  it("enforces one active Attempt per TaskRun with a partial unique index", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "unique active");
    expect(() => store.db.prepare(`INSERT INTO attempts
      (id,run_id,ordinal,trigger,status,active,version,legacy_event_seq,started_at,updated_at)
      VALUES (?,?,2,'resume','running',1,1,0,1,1)`).run(attemptIdFor(run.id, 2), run.id)).toThrow();
    expect(() => store.db.prepare(`INSERT INTO attempts
      (id,run_id,ordinal,trigger,status,active,version,legacy_event_seq,started_at,updated_at)
      VALUES (?,?,2,'resume','running',0,1,0,1,1)`).run(attemptIdFor(run.id, 2), run.id)).toThrow(/CHECK/);
    store.close();
  });

  it("fails migration when an existing deterministic Attempt row conflicts with the v29 projection", () => {
    const filename = path.join(mkdtempSync(path.join(tmpdir(), "tagent-attempt-conflict-")), "conflict.db");
    const store = new Store(filename);
    const run = store.createRun(store.createSession().id, "conflicting pre-v30 attempt");
    store.db.prepare("UPDATE attempts SET status='blocked',active=0 WHERE id=?").run(attemptIdFor(run.id, 1));
    store.db.prepare("UPDATE schema_meta SET version=29 WHERE id=1").run();
    store.close();

    expect(() => new Store(filename)).toThrow(/Attempt v30 backfill conflict/);
  });

  it("fails migration on orphaned or conflicting compatibility AttemptIds", () => {
    for (const fixture of ["orphan", "conflict"] as const) {
      const filename = path.join(mkdtempSync(path.join(tmpdir(), `tagent-attempt-${fixture}-`)), `${fixture}.db`);
      const store = new Store(filename);
      const run = store.createRun(store.createSession().id, fixture);
      store.db.prepare(`INSERT INTO context_manifests
        (id,run_id,attempt,attempt_id,source,items_json,stats_json,manifest_hash,created_at)
        VALUES (?,?,?,?, 'session','[]','{}','hash',1)`).run(
        `manifest-${fixture}`,
        run.id,
        fixture === "orphan" ? 2 : 1,
        fixture === "orphan" ? null : "attempt:wrong:1",
      );
      store.db.exec(`
        DROP TABLE attempt_authority_state;
        DROP TABLE attempt_authority_receipts;
        DROP TABLE attempt_shadow_comparisons;
        DROP TABLE attempt_transition_audit;
        DROP TABLE candidate_results;
        DROP TABLE execution_leases;
        DROP TABLE attempts;
        UPDATE schema_meta SET version=29 WHERE id=1;
      `);
      store.close();
      expect(() => new Store(filename)).toThrow(
        fixture === "orphan" ? /compatibility backfill orphan/ : /compatibility backfill conflict/,
      );
    }
  });

  it("writes deterministic attempt_id on new execution-owned rows", () => {
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "attempt compatibility writes");
    const attemptId = attemptIdFor(run.id, 1);
    store.recordContextManifest({
      id: "manifest-1", runId: run.id, attempt: 1, source: "session",
      items: [], stats: {}, manifestHash: "manifest-hash", createdAt: 1,
    });
    store.recordSupervisorDecision({
      id: "decision-1", runId: run.id, attempt: 1, checkpointSeq: 0,
      trigger: "checkpoint", action: "observe", reasonCode: "observe", rationale: "observe",
      confidence: 1, instruction: "", candidateResponseHash: "", status: "proposed", error: "",
      createdAt: 1, executedAt: null, evaluator: "system", evaluatorModel: "",
    });
    store.recordGateEvaluation({
      id: "gate-1", runId: run.id, attempt: 1, checkpointSeq: 0, gateType: "completion",
      evaluator: "system", evaluatorModel: "", summary: "pending", passed: false,
      failures: [], criterionCoverage: [], inputManifestHash: "manifest-hash", createdAt: 1,
    });
    store.requestUserInput(run.id, "Target?", [{
      key: "target", label: "Target", description: "Deployment target", inputType: "text",
      required: true, placeholder: "staging",
    }]);
    for (const table of [
      "context_manifests",
      "supervisor_decisions",
      "gate_evaluations",
      "user_input_requests",
      "learning_projection_outbox",
    ]) {
      expect(store.db.prepare(`SELECT attempt_id as attemptId FROM ${table} LIMIT 1`).get(), table)
        .toEqual({ attemptId });
    }
    store.close();
  });
});
