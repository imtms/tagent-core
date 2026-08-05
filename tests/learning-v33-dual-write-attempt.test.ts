import { afterEach, describe, expect, it } from "vitest";
import { ATTEMPT_AUTHORITY_SCENARIOS } from "@tagent/execution/domain";
import { Store } from "@tagent/persistence-sqlite/store";
import { CoreWriterLease, WriterFenceGuard } from "@tagent/persistence-sqlite/writer";
import { createGuardedLegacyStoreAdapter } from "@tagent/persistence-sqlite/sqlite";
import { prepareLearningIntegrationV33 } from "@tagent/persistence-sqlite/migrations";

const stores: Store[] = [];

afterEach(() => stores.splice(0).forEach((store) => { if (store.db.open) store.close(); }));

function fixture(owner: string) {
  const store = new Store(":memory:", { deferPostMigrationRecovery: true });
  stores.push(store);
  const writer = CoreWriterLease.claim(store.db, { ownerId: owner, pid: process.pid, host: "test" })!;
  const adapter = createGuardedLegacyStoreAdapter(store, new WriterFenceGuard(store.db, writer.authority));
  const session = adapter.sessions.createSession();
  const run = adapter.taskRuns.createRun(session.id, owner);
  const attempt = adapter.attempts.getActiveAttempt(run.id)!;
  return { store, adapter, session, run, attempt };
}

function approve(
  adapter: ReturnType<typeof createGuardedLegacyStoreAdapter>,
  attemptId: string,
): void {
  adapter.attemptAuthority.recordShadowComparisons(Array.from({ length: 1_000 }, (_, index) => ({
    attemptId,
    scenario: ATTEMPT_AUTHORITY_SCENARIOS[index % ATTEMPT_AUTHORITY_SCENARIOS.length],
    legacy: { status: "running" },
    projected: { status: "running" },
    mismatch: false,
  })));
  const receipt = adapter.attemptAuthority.recordAuthorityReceipt({
    id: `approval:${attemptId}`,
    requestedAttemptId: attemptId,
    decision: "approved",
    actor: "release-governor",
    reason: "v33 projection evidence accepted",
  });
  adapter.attemptAuthority.requestAuthority({ requestedAttemptId: attemptId, receiptId: receipt.id });
}

function mutationSnapshot(store: Store, runId: string, attemptId: string) {
  return store.db.prepare(`SELECT
    (SELECT status FROM runs WHERE id=?) runStatus,
    (SELECT last_event_seq FROM runs WHERE id=?) runEventSeq,
    (SELECT status FROM attempts WHERE id=?) attemptStatus,
    (SELECT version FROM attempts WHERE id=?) attemptVersion,
    (SELECT status FROM candidate_results WHERE attempt_id=?) candidateStatus,
    (SELECT released_at FROM execution_leases WHERE attempt_id=?) releasedAt,
    (SELECT COUNT(*) FROM run_events WHERE run_id=?) events,
    (SELECT COUNT(*) FROM attempt_transition_audit WHERE attempt_id=?) audits,
    (SELECT COUNT(*) FROM attempt_shadow_comparisons WHERE attempt_id=?) comparisons,
    (SELECT COUNT(*) FROM supervisor_decisions WHERE run_id=? AND status='executed') executedDecisions,
    (SELECT COUNT(*) FROM messages WHERE role='assistant') assistantMessages,
    (SELECT last_event_seq FROM run_checkpoints WHERE run_id=?) checkpointEventSeq,
    (SELECT COUNT(*) FROM learning_projection_outbox WHERE run_id=?) legacyOutbox,
    (SELECT COUNT(*) FROM integration_outbox WHERE aggregate_id=?) integrationOutbox,
    (SELECT next_sequence FROM integration_stream_sequence WHERE id=1) nextSequence`)
    .get(
      runId,
      runId,
      attemptId,
      attemptId,
      attemptId,
      attemptId,
      runId,
      attemptId,
      attemptId,
      runId,
      runId,
      runId,
      runId,
    );
}

function requireCanonicalProducerOrder(store: Store, runId: string, attemptId: string): void {
  store.db.exec(`CREATE TEMP TRIGGER require_terminal_event_before_attempt_state
    BEFORE UPDATE OF status ON attempts
    WHEN NEW.id='${attemptId}' AND NEW.status IN ('completed','blocked','failed','interrupted','cancelled')
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM run_events WHERE run_id='${runId}' AND attempt_id=NEW.id
          AND seq=NEW.legacy_event_seq AND type='run.' || NEW.status
      ) THEN RAISE(ABORT,'terminal event must precede Attempt state') END;
    END;
    CREATE TEMP TRIGGER require_attempt_hooks_before_legacy_pair
    BEFORE INSERT ON learning_projection_outbox WHEN NEW.run_id='${runId}'
    BEGIN
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM attempt_transition_audit
        WHERE attempt_id='${attemptId}' AND legacy_event_seq=NEW.event_seq
      ) THEN RAISE(ABORT,'Attempt audit hook must precede legacy pair') END;
      SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM attempt_shadow_comparisons WHERE attempt_id='${attemptId}'
      ) THEN RAISE(ABORT,'Attempt shadow hook must precede legacy pair') END;
    END`);
}

function expectCanonicalPair(store: Store, input: {
  runId: string;
  attemptId: string;
  lifecycle: string;
  outcome: string;
  eventSeq: number;
  sequence: number;
}): void {
  const pair = store.db.prepare(`SELECT
    legacy.outbox_sequence as legacySequence,
    integration.outbox_sequence as integrationSequence,
    legacy.source_event_id as legacySourceEventId,
    integration.source_event_id as integrationSourceEventId,
    legacy.payload_hash as legacyPayloadHash,
    integration.payload_hash as integrationPayloadHash,
    legacy.lifecycle,
    legacy.outcome,
    legacy.event_seq as eventSeq,
    integration.run_event_ref as runEventRef,
    integration.attempt_id as attemptId,
    integration.attempt_ordinal as ordinal,
    integration.evidence_snapshot_json as evidenceSnapshotJson
    FROM learning_projection_outbox legacy JOIN integration_outbox integration
      ON integration.outbox_sequence=legacy.outbox_sequence
    WHERE legacy.run_id=? AND legacy.lifecycle=?`).get(input.runId, input.lifecycle) as {
      legacySequence: number;
      integrationSequence: number;
      legacySourceEventId: string;
      integrationSourceEventId: string;
      legacyPayloadHash: string;
      integrationPayloadHash: string;
      lifecycle: string;
      outcome: string;
      eventSeq: number;
      runEventRef: string;
      attemptId: string;
      ordinal: number;
      evidenceSnapshotJson: string;
    };
  expect(pair).toMatchObject({
    legacySequence: input.sequence,
    integrationSequence: input.sequence,
    legacySourceEventId: `run:${input.runId}:event:${input.eventSeq}`,
    integrationSourceEventId: `run:${input.runId}:event:${input.eventSeq}`,
    legacyPayloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    integrationPayloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    lifecycle: input.lifecycle,
    outcome: input.outcome,
    eventSeq: input.eventSeq,
    runEventRef: `run:${input.runId}:event:${input.eventSeq}`,
    attemptId: input.attemptId,
    ordinal: 1,
  });
  expect(pair.integrationPayloadHash).toBe(pair.legacyPayloadHash);
  expect(JSON.parse(pair.evidenceSnapshotJson)).toMatchObject({
    taskRun: { id: input.runId, attempt: 1, status: input.outcome },
    attempt: { id: input.attemptId, ordinal: 1, status: input.outcome },
    checkpoint: { runId: input.runId, attempt: 1, lastEventSeq: input.eventSeq },
    runEventRef: { runId: input.runId, seq: input.eventSeq, type: input.lifecycle },
  });
}

describe("Attempt v33 learning integration producer", () => {
  it("settles through one canonical pair and rolls back both outbox failure sides without a sequence gap", () => {
    const { store, adapter, session, run, attempt } = fixture("attempt-settle-v33");
    requireCanonicalProducerOrder(store, run.id, attempt.id);
    const lease = adapter.attempts.acquireExecutionLease({
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      ownerId: "executor",
      leaseMs: 30_000,
    });
    const candidate = adapter.attempts.recordCandidateResult({
      id: "candidate-v33",
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      leaseToken: lease.token,
      fence: lease.fence,
      response: "canonical result",
    });
    adapter.supervisorDecisions.recordSupervisorDecision({
      id: "decision-v33",
      runId: run.id,
      attempt: 1,
      checkpointSeq: 0,
      trigger: "settled",
      action: "complete_taskrun",
      reasonCode: "verified",
      rationale: "verified",
      confidence: 1,
      instruction: "",
      candidateResponseHash: candidate.responseHash,
      status: "proposed",
      error: "",
      createdAt: 10,
      executedAt: null,
      evaluator: "system",
      evaluatorModel: "",
    });
    approve(adapter, attempt.id);
    const settle = () => adapter.attempts.settleAttempt({
      attemptId: attempt.id,
      expectedVersion: candidate.attemptVersion,
      leaseToken: lease.token,
      fence: lease.fence,
      candidateResultId: candidate.id,
      supervisorDecisionId: "decision-v33",
      status: "completed",
      reason: "approved",
      timestamp: 100,
    });
    const baseline = mutationSnapshot(store, run.id, attempt.id);

    store.db.exec(`CREATE TRIGGER reject_attempt_legacy_pair BEFORE INSERT ON learning_projection_outbox
      BEGIN SELECT RAISE(ABORT, 'attempt legacy pair rejected'); END`);
    expect(settle).toThrow(/attempt legacy pair rejected/);
    expect(mutationSnapshot(store, run.id, attempt.id)).toEqual(baseline);
    store.db.exec("DROP TRIGGER reject_attempt_legacy_pair");

    store.db.exec(`CREATE TRIGGER reject_attempt_integration_pair BEFORE INSERT ON integration_outbox
      BEGIN SELECT RAISE(ABORT, 'attempt integration pair rejected'); END`);
    expect(settle).toThrow(/attempt integration pair rejected/);
    expect(mutationSnapshot(store, run.id, attempt.id)).toEqual(baseline);
    store.db.exec("DROP TRIGGER reject_attempt_integration_pair");

    expect(settle()).toMatchObject({ status: "completed", active: false });
    expect(adapter.sessions.listMessages(session.id)).toContainEqual(
      expect.objectContaining({ role: "assistant", content: "canonical result" }),
    );
    expectCanonicalPair(store, {
      runId: run.id,
      attemptId: attempt.id,
      lifecycle: "run.completed",
      outcome: "completed",
      eventSeq: 1,
      sequence: 1,
    });
    expect(store.db.prepare("SELECT next_sequence as nextSequence FROM integration_stream_sequence WHERE id=1").get())
      .toEqual({ nextSequence: 2 });
  });

  it("re-enters the v33 preflight without changing a runtime-produced canonical pair", () => {
    const { store, adapter, run, attempt } = fixture("attempt-v33-reentry");
    const lease = adapter.attempts.acquireExecutionLease({
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      ownerId: "executor-reentry",
      leaseMs: 30_000,
    });
    const candidate = adapter.attempts.recordCandidateResult({
      id: "candidate-v33-reentry",
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      leaseToken: lease.token,
      fence: lease.fence,
      response: "re-entry result",
    });
    adapter.supervisorDecisions.recordSupervisorDecision({
      id: "decision-v33-reentry",
      runId: run.id,
      attempt: 1,
      checkpointSeq: 0,
      trigger: "settled",
      action: "complete_taskrun",
      reasonCode: "verified",
      rationale: "verified",
      confidence: 1,
      instruction: "",
      candidateResponseHash: candidate.responseHash,
      status: "proposed",
      error: "",
      createdAt: 10,
      executedAt: null,
      evaluator: "system",
      evaluatorModel: "",
    });
    approve(adapter, attempt.id);
    adapter.attempts.settleAttempt({
      attemptId: attempt.id,
      expectedVersion: candidate.attemptVersion,
      leaseToken: lease.token,
      fence: lease.fence,
      candidateResultId: candidate.id,
      supervisorDecisionId: "decision-v33-reentry",
      status: "completed",
      reason: "approved",
      timestamp: 100,
    });
    const before = {
      legacy: store.db.prepare("SELECT * FROM learning_projection_outbox ORDER BY outbox_sequence").all(),
      integration: store.db.prepare("SELECT * FROM integration_outbox ORDER BY outbox_sequence").all(),
      sequence: store.db.prepare("SELECT * FROM integration_stream_sequence").all(),
    };

    expect(() => prepareLearningIntegrationV33(store.db, 33, 200)).not.toThrow();
    expect({
      legacy: store.db.prepare("SELECT * FROM learning_projection_outbox ORDER BY outbox_sequence").all(),
      integration: store.db.prepare("SELECT * FROM integration_outbox ORDER BY outbox_sequence").all(),
      sequence: store.db.prepare("SELECT * FROM integration_stream_sequence").all(),
    }).toEqual(before);
  });

  it("recovers an interrupted Attempt with stale fences zero-write and one idempotent pair", () => {
    const { store, adapter, run, attempt } = fixture("attempt-recover-v33");
    requireCanonicalProducerOrder(store, run.id, attempt.id);
    const lease = adapter.attempts.acquireExecutionLease({
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      ownerId: "executor-recovery",
      leaseMs: 10,
      timestamp: 100,
    });
    const recover = (leaseToken = lease.token, fence = lease.fence) =>
      adapter.attempts.recoverInterruptedAttempt({
        attemptId: attempt.id,
        expectedVersion: attempt.version,
        ownerId: "executor-recovery",
        leaseToken,
        fence,
        reason: "execution authority lost",
        timestamp: 200,
      });
    const baseline = mutationSnapshot(store, run.id, attempt.id);

    expect(() => recover("stale-token")).toThrow(/token mismatch/);
    expect(mutationSnapshot(store, run.id, attempt.id)).toEqual(baseline);
    expect(() => recover(lease.token, lease.fence + 1)).toThrow(/fence mismatch/);
    expect(mutationSnapshot(store, run.id, attempt.id)).toEqual(baseline);
    store.db.exec(`CREATE TRIGGER reject_recovery_integration_pair BEFORE INSERT ON integration_outbox
      BEGIN SELECT RAISE(ABORT, 'recovery integration pair rejected'); END`);
    expect(() => recover()).toThrow(/recovery integration pair rejected/);
    expect(mutationSnapshot(store, run.id, attempt.id)).toEqual(baseline);
    store.db.exec("DROP TRIGGER reject_recovery_integration_pair");

    expect(recover()).toMatchObject({ recovered: true, attempt: { status: "interrupted" } });
    expectCanonicalPair(store, {
      runId: run.id,
      attemptId: attempt.id,
      lifecycle: "run.interrupted",
      outcome: "interrupted",
      eventSeq: 1,
      sequence: 1,
    });
    const settled = mutationSnapshot(store, run.id, attempt.id);
    expect(recover()).toMatchObject({ recovered: false });
    expect(mutationSnapshot(store, run.id, attempt.id)).toEqual(settled);
  });

  it("cancels through one pair and rolls back terminal side rows when legacy insertion fails", () => {
    const { store, adapter, run, attempt } = fixture("attempt-cancel-v33");
    requireCanonicalProducerOrder(store, run.id, attempt.id);
    const cancel = () => adapter.attempts.cancelAttempt({
      attemptId: attempt.id,
      reason: "cancelled by user",
      timestamp: 300,
    });
    const baseline = mutationSnapshot(store, run.id, attempt.id);
    store.db.exec(`CREATE TRIGGER reject_cancel_legacy_pair BEFORE INSERT ON learning_projection_outbox
      BEGIN SELECT RAISE(ABORT, 'cancel legacy pair rejected'); END`);

    expect(cancel).toThrow(/cancel legacy pair rejected/);
    expect(mutationSnapshot(store, run.id, attempt.id)).toEqual(baseline);
    store.db.exec("DROP TRIGGER reject_cancel_legacy_pair");

    expect(cancel()).toMatchObject({ cancelled: true, attempt: { status: "cancelled" } });
    expectCanonicalPair(store, {
      runId: run.id,
      attemptId: attempt.id,
      lifecycle: "run.cancelled",
      outcome: "cancelled",
      eventSeq: 1,
      sequence: 1,
    });
  });
});
