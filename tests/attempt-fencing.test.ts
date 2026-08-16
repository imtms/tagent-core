import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGuardedSqlitePersistence, Store } from "@tagent/persistence-sqlite";
import { CoreWriterLease, WriterFenceGuard } from "@tagent/persistence-sqlite/writer";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => { if (store.db.open) store.close(); }));

describe("Attempt terminal fencing", () => {
  it("rejects stale AttemptId, version, lease token, and fence with zero side effects", () => {
    const filename = path.join(mkdtempSync(path.join(tmpdir(), "tagent-attempt-fence-")), "fence.db");
    const store = new Store(filename);
    stores.push(store);
    const lease = CoreWriterLease.claim(store.db, { ownerId: "writer-a", pid: process.pid, host: "test" })!;
    const adapter = createGuardedSqlitePersistence(store, new WriterFenceGuard(store.db, lease.authority));
    const session = adapter.sessions.createSession();
    const run = adapter.taskRuns.createRun(session.id, "fenced terminal");
    const attempt = adapter.attempts.getActiveAttempt(run.id)!;
    const executionLease = adapter.attempts.acquireExecutionLease({ attemptId: attempt.id, expectedVersion: attempt.version, ownerId: "executor", leaseMs: 30_000 });
    const candidate = adapter.attempts.recordCandidateResult({
      id: "candidate-1", attemptId: attempt.id, expectedVersion: attempt.version,
      leaseToken: executionLease.token, fence: executionLease.fence, response: "verified result",
    });
    expect(adapter.attempts.recordCandidateResult({
      id: "candidate-1", attemptId: attempt.id, expectedVersion: attempt.version,
      leaseToken: executionLease.token, fence: executionLease.fence, response: "verified result",
    })).toEqual(candidate);
    expect(() => adapter.attempts.recordCandidateResult({
      id: "candidate-2", attemptId: attempt.id, expectedVersion: attempt.version,
      leaseToken: executionLease.token, fence: executionLease.fence, response: "different result",
    })).toThrow(/different Candidate/);
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM candidate_results WHERE attempt_id=?").get(attempt.id))
      .toEqual({ count: 1 });
    expect(adapter.attempts.getAttempt(attempt.id)).toMatchObject({
      status: "settling", active: true, version: candidate.attemptVersion,
    });
    adapter.supervisorDecisions.recordSupervisorDecision({
      id: "decision-1", runId: run.id, attempt: attempt.ordinal, checkpointSeq: 0,
      trigger: "settled", action: "complete_taskrun", reasonCode: "verified",
      rationale: "verified candidate", confidence: 1, instruction: "",
      candidateResponseHash: candidate.responseHash, status: "proposed", error: "",
      createdAt: Date.now(), executedAt: null, evaluator: "system", evaluatorModel: "",
    });
    const snapshot = () => store.db.prepare(`SELECT
      (SELECT COUNT(*) FROM attempt_transition_audit) audit,
      (SELECT COUNT(*) FROM run_events) events,
      (SELECT version FROM attempts WHERE id=?) version,
      (SELECT status FROM attempts WHERE id=?) attemptStatus,
      (SELECT status FROM candidate_results WHERE id=?) candidateStatus,
      (SELECT status FROM runs WHERE id=?) runStatus,
      (SELECT status FROM supervisor_decisions WHERE id='decision-1') decisionStatus,
      (SELECT COUNT(*) FROM messages WHERE role='assistant') assistantMessages`)
      .get(attempt.id, attempt.id, candidate.id, run.id);
    const baseline = snapshot();
    const settle = (overrides: Record<string, unknown>) => adapter.attempts.settleAttempt({
      attemptId: attempt.id, expectedVersion: candidate.attemptVersion, leaseToken: executionLease.token,
      fence: executionLease.fence, candidateResultId: candidate.id, supervisorDecisionId: "decision-1",
      status: "completed", reason: "approved",
      ...overrides,
    });

    expect(() => settle({ attemptId: "attempt:missing:1" })).toThrow(/Attempt/);
    expect(snapshot()).toEqual(baseline);
    expect(() => settle({ expectedVersion: candidate.attemptVersion + 1 })).toThrow(/version/);
    expect(snapshot()).toEqual(baseline);
    expect(() => settle({ leaseToken: "stale-token" })).toThrow(/token/);
    expect(snapshot()).toEqual(baseline);
    expect(() => settle({ fence: executionLease.fence + 1 })).toThrow(/fence/);
    expect(snapshot()).toEqual(baseline);

    store.db.exec(`CREATE TRIGGER reject_attempt_checkpoint
      BEFORE INSERT ON run_checkpoints BEGIN
        SELECT RAISE(ABORT, 'attempt checkpoint rejected');
      END`);
    expect(() => settle({})).toThrow(/checkpoint rejected/);
    expect(snapshot()).toEqual(baseline);
    store.db.exec("DROP TRIGGER reject_attempt_checkpoint");

    expect(settle({})).toMatchObject({ status: "completed", active: false, version: candidate.attemptVersion + 1 });
    expect(store.getRun(run.id)).toMatchObject({ status: "completed" });
    expect(store.listEvents(run.id).at(-1)).toMatchObject({ type: "run.completed", seq: 1 });
    expect(adapter.supervisorDecisions.listSupervisorDecisions(run.id)).toMatchObject([{ id: "decision-1", status: "executed" }]);
    expect(adapter.sessions.listMessages(session.id)).toMatchObject([{ role: "assistant", content: "verified result" }]);
  });

  it("keeps Attempt mutations behind the stale-writer guard", () => {
    const filename = path.join(mkdtempSync(path.join(tmpdir(), "tagent-attempt-writer-")), "writer.db");
    const firstStore = new Store(filename); stores.push(firstStore);
    const firstLease = CoreWriterLease.claim(firstStore.db, { ownerId: "writer-a", pid: process.pid, host: "test" })!;
    const stale = createGuardedSqlitePersistence(firstStore, new WriterFenceGuard(firstStore.db, firstLease.authority));
    const session = stale.sessions.createSession();
    const run = stale.taskRuns.createRun(session.id, "stale writer");
    const attempt = stale.attempts.getActiveAttempt(run.id)!;
    expect(firstLease.release()).toBe(true);

    const secondStore = new Store(filename); stores.push(secondStore);
    const currentLease = CoreWriterLease.claim(secondStore.db, { ownerId: "writer-b", pid: process.pid, host: "test" })!;
    const before = firstStore.db.prepare("SELECT COUNT(*) AS count FROM execution_leases").get();
    expect(() => stale.attempts.acquireExecutionLease({ attemptId: attempt.id, expectedVersion: attempt.version, ownerId: "executor", leaseMs: 30_000 })).toThrow(/writer authority lost/i);
    expect(firstStore.db.prepare("SELECT COUNT(*) AS count FROM execution_leases").get()).toEqual(before);
    expect(currentLease.release()).toBe(true);
  });

  it("rejects the CandidateResult when Governance blocks the review Attempt", () => {
    const store = new Store(":memory:");
    stores.push(store);
    const writer = CoreWriterLease.claim(store.db, {
      ownerId: "writer-blocked", pid: process.pid, host: "test",
    })!;
    const adapter = createGuardedSqlitePersistence(store, new WriterFenceGuard(store.db, writer.authority));
    const session = adapter.sessions.createSession();
    const run = adapter.taskRuns.createRun(session.id, "blocked review candidate");
    const attempt = adapter.attempts.getActiveAttempt(run.id)!;
    const lease = adapter.attempts.acquireExecutionLease({
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      ownerId: "executor",
      leaseMs: 30_000,
    });
    const candidate = adapter.attempts.recordCandidateResult({
      id: "candidate-blocked",
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      leaseToken: lease.token,
      fence: lease.fence,
      response: "candidate requiring more evidence",
    });
    adapter.supervisorDecisions.recordSupervisorDecision({
      id: "decision-blocked", runId: run.id, attempt: attempt.ordinal, checkpointSeq: 0,
      trigger: "settled", action: "start_continuation", reasonCode: "missing_evidence",
      rationale: "more evidence required", confidence: 1, instruction: "collect evidence",
      candidateResponseHash: candidate.responseHash, status: "proposed", error: "",
      createdAt: Date.now(), executedAt: null, evaluator: "system", evaluatorModel: "",
    });
    expect(adapter.attempts.settleAttempt({
      attemptId: attempt.id,
      expectedVersion: candidate.attemptVersion,
      leaseToken: lease.token,
      fence: lease.fence,
      candidateResultId: candidate.id,
      supervisorDecisionId: "decision-blocked",
      status: "blocked",
      reason: "missing evidence",
    })).toMatchObject({ status: "blocked", active: false });
    expect(store.db.prepare("SELECT status FROM candidate_results WHERE id=?").get(candidate.id))
      .toEqual({ status: "rejected" });
    expect(store.getRun(run.id)).toMatchObject({ status: "blocked", blockedReason: "missing evidence" });
    expect(store.listEvents(run.id).map((event) => event.type))
      .toEqual(["message.rejected", "run.blocked"]);
  });

  it("renews the same execution fence while a unique Candidate is under Governance review", () => {
    const store = new Store(":memory:");
    stores.push(store);
    const writer = CoreWriterLease.claim(store.db, {
      ownerId: "writer-review", pid: process.pid, host: "test",
    })!;
    const adapter = createGuardedSqlitePersistence(store, new WriterFenceGuard(store.db, writer.authority));
    const session = adapter.sessions.createSession();
    const run = adapter.taskRuns.createRun(session.id, "long governance review");
    const attempt = adapter.attempts.getActiveAttempt(run.id)!;
    const lease = adapter.attempts.acquireExecutionLease({
      attemptId: attempt.id, expectedVersion: attempt.version, ownerId: "executor",
      leaseMs: 20, timestamp: 100,
    });
    const candidate = adapter.attempts.recordCandidateResult({
      id: "candidate-review", attemptId: attempt.id, expectedVersion: attempt.version,
      leaseToken: lease.token, fence: lease.fence, response: "reviewed result", timestamp: 110,
    });
    adapter.supervisorDecisions.recordSupervisorDecision({
      id: "decision-review", runId: run.id, attempt: 1, checkpointSeq: 0,
      trigger: "settled", action: "complete_taskrun", reasonCode: "verified", rationale: "verified",
      confidence: 1, instruction: "", candidateResponseHash: candidate.responseHash,
      status: "proposed", error: "", createdAt: 111, executedAt: null,
      evaluator: "system", evaluatorModel: "",
    });
    expect(adapter.attempts.renewExecutionLease({
      attemptId: attempt.id, ownerId: "executor", leaseToken: lease.token,
      fence: lease.fence, leaseMs: 100, timestamp: 119,
    })).toMatchObject({ leaseUntil: 219, attemptVersion: attempt.version });
    expect(adapter.attempts.settleAttempt({
      attemptId: attempt.id, expectedVersion: candidate.attemptVersion,
      leaseToken: lease.token, fence: lease.fence, candidateResultId: candidate.id,
      supervisorDecisionId: "decision-review", status: "completed", reason: "approved", timestamp: 200,
    })).toMatchObject({ status: "completed", version: candidate.attemptVersion + 1 });
  });

  it("recovers an expired same-fence Attempt atomically, idempotently, and leaves stale fences zero-write", () => {
    const store = new Store(":memory:");
    stores.push(store);
    const writer = CoreWriterLease.claim(store.db, {
      ownerId: "writer-recovery", pid: process.pid, host: "test",
    })!;
    const adapter = createGuardedSqlitePersistence(store, new WriterFenceGuard(store.db, writer.authority));
    const session = adapter.sessions.createSession();
    const run = adapter.taskRuns.createRun(session.id, "recover execution authority");
    const attempt = adapter.attempts.getActiveAttempt(run.id)!;
    const lease = adapter.attempts.acquireExecutionLease({
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      ownerId: "executor-recovery",
      leaseMs: 10,
      timestamp: 100,
    });
    const snapshot = () => store.db.prepare(`SELECT
      (SELECT status FROM runs WHERE id=?) runStatus,
      (SELECT status FROM attempts WHERE id=?) attemptStatus,
      (SELECT version FROM attempts WHERE id=?) attemptVersion,
      (SELECT released_at FROM execution_leases WHERE attempt_id=?) releasedAt,
      (SELECT COUNT(*) FROM run_events WHERE run_id=?) events,
      (SELECT COUNT(*) FROM attempt_transition_audit WHERE attempt_id=?) audit`)
      .get(run.id, attempt.id, attempt.id, attempt.id, run.id, attempt.id);
    const baseline = snapshot();
    const recover = (overrides: Record<string, unknown> = {}) => adapter.attempts.recoverInterruptedAttempt({
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      ownerId: "executor-recovery",
      leaseToken: lease.token,
      fence: lease.fence,
      reason: "execution authority lost",
      timestamp: 200,
      ...overrides,
    });

    expect(() => recover({ leaseToken: "stale-token" })).toThrow(/token mismatch/);
    expect(snapshot()).toEqual(baseline);
    expect(() => recover({ fence: lease.fence + 1 })).toThrow(/fence mismatch/);
    expect(snapshot()).toEqual(baseline);
    store.db.exec(`CREATE TRIGGER reject_recovery_checkpoint
      BEFORE INSERT ON run_checkpoints BEGIN
        SELECT RAISE(ABORT, 'recovery checkpoint rejected');
      END`);
    expect(() => recover()).toThrow(/recovery checkpoint rejected/);
    expect(snapshot()).toEqual(baseline);
    store.db.exec("DROP TRIGGER reject_recovery_checkpoint");

    const recovered = recover();
    expect(recovered).toMatchObject({
      recovered: true,
      attempt: { status: "interrupted", active: false },
      event: { type: "run.interrupted" },
    });
    expect(store.getRun(run.id)).toMatchObject({ status: "interrupted", resumable: true });
    expect(store.db.prepare("SELECT released_at FROM execution_leases WHERE attempt_id=?").get(attempt.id))
      .toEqual({ released_at: 200 });
    const repeated = recover();
    expect(repeated).toMatchObject({ recovered: false });
    expect(repeated.event).toBeUndefined();
    expect(store.listEvents(run.id).filter((event) => event.type === "run.interrupted")).toHaveLength(1);

    expect(store.resumeRun(run.id)).toMatchObject({ status: "running", attempt: 2 });
    expect(() => recover()).toThrow(/recovery state is inconsistent/);
    expect(store.listEvents(run.id).filter((event) => event.type === "run.interrupted")).toHaveLength(1);
  });
});
