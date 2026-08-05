import { afterEach, describe, expect, it } from "vitest";
import { Store } from "@tagent/persistence-sqlite/store";
import { appendProjectionPair } from "../adapters/persistence-sqlite/src/sqlite/canonical-integration-event.js";

const stores: Store[] = [];
afterEach(() => { while (stores.length) stores.pop()!.close(); });
function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  const session = store.createSession("v33 dual write");
  const run = store.createRun(session.id, "goal", "v33-request");
  return { store, run };
}

function producerSnapshot(store: Store, runId: string) {
  return store.db.prepare(`SELECT
    (SELECT status FROM runs WHERE id=?) runStatus,
    (SELECT last_event_seq FROM runs WHERE id=?) runEventSeq,
    (SELECT status FROM attempts WHERE run_id=? AND active=1) activeAttemptStatus,
    (SELECT status FROM attempts WHERE run_id=? ORDER BY ordinal DESC LIMIT 1) attemptStatus,
    (SELECT version FROM attempts WHERE run_id=? ORDER BY ordinal DESC LIMIT 1) attemptVersion,
    (SELECT legacy_event_seq FROM attempts WHERE run_id=? ORDER BY ordinal DESC LIMIT 1) attemptEventSeq,
    (SELECT active FROM run_checkpoints WHERE run_id=?) checkpointActive,
    (SELECT current_tool_json FROM run_checkpoints WHERE run_id=?) checkpointTool,
    (SELECT last_event_seq FROM run_checkpoints WHERE run_id=?) checkpointEventSeq,
    (SELECT COUNT(*) FROM run_events WHERE run_id=?) events,
    (SELECT COUNT(*) FROM attempt_transition_audit WHERE run_id=?) audits,
    (SELECT COUNT(*) FROM attempt_shadow_comparisons comparison
      JOIN attempts attempt ON attempt.id=comparison.attempt_id WHERE attempt.run_id=?) comparisons,
    (SELECT COUNT(*) FROM learning_projection_outbox WHERE run_id=?) legacyOutbox,
    (SELECT COUNT(*) FROM integration_outbox WHERE aggregate_id=?) integrationOutbox,
    (SELECT next_sequence FROM integration_stream_sequence WHERE id=1) nextSequence`)
    .get(runId, runId, runId, runId, runId, runId, runId, runId, runId, runId, runId, runId, runId, runId);
}

function canonicalInput(store: Store, runId: string, payload: Record<string, unknown>) {
  const row = store.db.prepare(`SELECT attempt,attempt_id as attemptId,lifecycle,outcome,
    event_seq as eventSeq,created_at as createdAt FROM learning_projection_outbox WHERE run_id=?`)
    .get(runId) as {
      attempt: number;
      attemptId: string;
      lifecycle: string;
      outcome: string;
      eventSeq: number;
      createdAt: number;
    };
  return {
    runId,
    attemptId: row.attemptId,
    attemptOrdinal: row.attempt,
    lifecycle: row.lifecycle,
    outcome: row.outcome,
    eventSeq: row.eventSeq,
    payload,
    taskRunSnapshot: store.getRun(runId)! as unknown as Record<string, unknown>,
    timestamp: row.createdAt,
    runEventType: "run.completed",
  };
}

describe("Learning v33 Store producer dual-write", () => {
  it("writes transition event and paired rows with identical sequence/source/hash", () => {
    const { store, run } = fixture();
    store.transitionRun(run.id, ["running"], "completed", "run.completed", { ok: true }, "done", 1);
    const pair = store.db.prepare(`SELECT l.outbox_sequence as sequence,l.source_event_id as sourceEventId,
      l.payload_hash as legacyHash,i.payload_hash as integrationHash,i.event_id as eventId
      FROM learning_projection_outbox l JOIN integration_outbox i ON i.outbox_sequence=l.outbox_sequence`).get() as any;
    expect(pair.sequence).toBeGreaterThan(0);
    expect(pair.sourceEventId).toBe("run:" + run.id + ":event:1");
    expect(pair.legacyHash).toBe(pair.integrationHash);
    expect(pair.eventId).toMatch(/^integration:[0-9a-f]{64}$/);
  });

  it("requestUserInput emits one real event-backed projection", () => {
    const { store, run } = fixture();
    expect(store.requestUserInput).toHaveLength(3);
    store.db.exec(`CREATE TEMP TRIGGER require_waiting_event_before_run_state
      BEFORE UPDATE OF status ON runs WHEN NEW.id='${run.id}' AND NEW.status='waiting_input'
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM run_events WHERE run_id=NEW.id AND seq=OLD.last_event_seq+1
            AND type='run.waiting_for_input'
        ) THEN RAISE(ABORT,'waiting event must precede Run state') END;
      END`);
    store.requestUserInput(run.id, "Need input", []);
    const events = store.db.prepare("SELECT seq FROM run_events WHERE run_id=?").all(run.id) as Array<{ seq: number }>;
    expect(events).toHaveLength(1);
    const row = store.db.prepare("SELECT event_seq as eventSeq FROM learning_projection_outbox WHERE run_id=?").get(run.id) as { eventSeq: number };
    expect(row.eventSeq).toBeGreaterThan(0);
  });

  it("appendProjectionPair returns the exact duplicate without consuming a sequence", () => {
    const { store, run } = fixture();
    store.transitionRun(run.id, ["running"], "completed", "run.completed", { ok: true }, "done", 1);
    const before = (store.db.prepare("SELECT next_sequence as n FROM integration_stream_sequence WHERE id=1").get() as { n: number }).n;
    const original = store.db.prepare(`SELECT outbox_sequence as outboxSequence,event_id as eventId,
      source_event_id as sourceEventId,payload_hash as payloadHash FROM integration_outbox`).get();
    const duplicate = store.db.transaction(() => appendProjectionPair(
      store.db,
      canonicalInput(store, run.id, { ok: true, reason: "done" }),
    ))();
    expect(duplicate).toEqual(original);
    expect(store.db.prepare("SELECT COUNT(*) as n FROM learning_projection_outbox").get()).toEqual({ n: 1 });
    expect(store.db.prepare("SELECT COUNT(*) as n FROM integration_outbox").get()).toEqual({ n: 1 });
    expect((store.db.prepare("SELECT next_sequence as n FROM integration_stream_sequence WHERE id=1").get() as { n: number }).n).toBe(before);
  });

  it("appendProjectionPair rejects a conflicting payload without consuming a sequence", () => {
    const { store, run } = fixture();
    store.transitionRun(run.id, ["running"], "completed", "run.completed", { ok: true }, "done", 1);
    const before = producerSnapshot(store, run.id);
    expect(() => store.db.transaction(() => appendProjectionPair(
      store.db,
      canonicalInput(store, run.id, { ok: false, reason: "done" }),
    ))()).toThrow(/identity\/hash conflict/);
    expect(producerSnapshot(store, run.id)).toEqual(before);
  });

  it("appendProjectionPair rejects a partial pair without consuming a sequence", () => {
    const { store, run } = fixture();
    store.transitionRun(run.id, ["running"], "completed", "run.completed", { ok: true }, "done", 1);
    const input = canonicalInput(store, run.id, { ok: true, reason: "done" });
    store.db.prepare("DELETE FROM learning_projection_outbox WHERE run_id=?").run(run.id);
    const before = producerSnapshot(store, run.id);
    expect(() => store.db.transaction(() => appendProjectionPair(
      store.db,
      input,
    ))()).toThrow(/partial or ambiguous/);
    expect(producerSnapshot(store, run.id)).toEqual(before);
  });

  it.each([
    ["finalize", (store: Store, id: string) => store.finalizeRun(id, "completed", "done")],
    ["block", (store: Store, id: string) => store.blockRun(id, "blocked")],
    ["interrupt", (store: Store, _id: string) => store.markInterrupted()],
  ])("%s is backed by a real event", (_name, action) => {
    const { store, run } = fixture(); action(store, run.id);
    const row = store.db.prepare("SELECT event_seq as eventSeq FROM learning_projection_outbox WHERE run_id=?").get(run.id) as { eventSeq: number };
    expect(row.eventSeq).toBeGreaterThan(0);
    expect(store.db.prepare("SELECT COUNT(*) as n FROM run_events WHERE run_id=?").get(run.id)).toMatchObject({ n: 1 });
  });

  it.each([
    ["legacy", "learning_projection_outbox"],
    ["integration", "integration_outbox"],
  ] as const)("%s insert failure rolls back event, Run, Attempt, checkpoint, hooks, pair, and sequence", (_side, table) => {
    const { store, run } = fixture();
    const baseline = producerSnapshot(store, run.id);
    store.db.exec(`CREATE TEMP TRIGGER reject_v33_pair BEFORE INSERT ON ${table}
      BEGIN SELECT RAISE(ABORT,'reject ${table}'); END`);
    expect(() => store.transitionRun(run.id, ["running"], "completed", "run.completed", {}, "x", 1))
      .toThrow(`reject ${table}`);
    expect(producerSnapshot(store, run.id)).toEqual(baseline);
    store.db.exec("DROP TRIGGER reject_v33_pair");
    store.transitionRun(run.id, ["running"], "completed", "run.completed", {}, "x", 1);
    expect(store.db.prepare("SELECT outbox_sequence as n FROM integration_outbox").get()).toEqual({ n: 1 });
    expect(store.db.prepare("SELECT next_sequence as n FROM integration_stream_sequence WHERE id=1").get()).toEqual({ n: 2 });
  });
});
