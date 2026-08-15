import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { attemptIdFor } from "@tagent/execution/domain";
import type { RuntimeTransitionCommand, RuntimeTransitionFence, SystemTransitionAuthority } from "@tagent/execution/ports";
import {
  Store,
  createGuardedSqlitePersistence,
  type SqlitePersistence,
} from "@tagent/persistence-sqlite";
import { CoreWriterLease, WriterAuthorityLostError, WriterFenceGuard } from "@tagent/persistence-sqlite/writer";

const nowSql = "(SELECT value FROM writer_test_clock WHERE id=1)";
const stores: Store[] = [];
const connections: Database.Database[] = [];
const temporaryDirectories: string[] = [];

interface Fixture {
  store: Store;
  adapter: SqlitePersistence;
  guard: WriterFenceGuard;
  writerLease: CoreWriterLease;
  filename: string;
  run: ReturnType<SqlitePersistence["taskRuns"]["createRun"]>;
  attempt: NonNullable<ReturnType<SqlitePersistence["attempts"]["getActiveAttempt"]>>;
  fence: RuntimeTransitionFence;
  setNow(value: number): void;
}

function fixture(): Fixture {
  const directory = mkdtempSync(path.join(tmpdir(), "tagent-transition-authority-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "core.sqlite");
  const store = new Store(filename, { deferStartupRecovery: true });
  stores.push(store);
  store.db.exec(`CREATE TABLE writer_test_clock (id INTEGER PRIMARY KEY CHECK (id=1),value INTEGER NOT NULL);
    INSERT INTO writer_test_clock VALUES (1,1000);`);
  const writerLease = CoreWriterLease.claim(
    store.db,
    { ownerId: "transition-writer", pid: process.pid, host: "test-host" },
    { leaseMs: 20_000, heartbeatIntervalMs: 5_000, skewMarginMs: 2_000, nowSql },
  )!;
  const guard = new WriterFenceGuard(store.db, writerLease.authority, { skewMarginMs: 2_000, nowSql });
  guard.installConnectionGuard();
  const adapter = createGuardedSqlitePersistence(store, guard);
  const session = adapter.sessions.createSession("transition-test");
  const run = adapter.taskRuns.createRun(session.id, "transition authority");
  const attempt = adapter.attempts.getActiveAttempt(run.id)!;
  const executionLease = adapter.attempts.acquireExecutionLease({
    attemptId: attempt.id,
    expectedVersion: attempt.version,
    ownerId: "runtime",
    leaseMs: 30_000,
  });
  return {
    store,
    adapter,
    guard,
    writerLease,
    filename,
    run,
    attempt,
    fence: {
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      leaseToken: executionLease.token,
      executionFence: executionLease.fence,
    },
    setNow: (value) => { store.db.prepare("UPDATE writer_test_clock SET value=? WHERE id=1").run(value); },
  };
}

function attemptSnapshot(receipt: Fixture) {
  return receipt.adapter.attempts.getAttempt(receipt.attempt.id);
}

function transitionFixtureRun(
  receipt: Fixture,
  runId: string,
  kind: RuntimeTransitionCommand["kind"],
  reason = "",
) {
  const attempt = receipt.adapter.attempts.getActiveAttempt(runId);
  if (!attempt) throw new Error(`Active Attempt for fixture Run ${runId} was not found`);
  if (attempt.id === receipt.fence.attemptId) {
    return receipt.adapter.taskRunTransitions.transitionRuntime({ kind, reason, data: { reason } }, receipt.fence);
  }
  const ownerId = `fixture-transition:${runId}`;
  const lease = receipt.adapter.attempts.acquireExecutionLease({
    attemptId: attempt.id,
    expectedVersion: attempt.version,
    ownerId,
    leaseMs: 30_000,
  });
  try {
    return receipt.adapter.taskRunTransitions.transitionRuntime(
      { kind, reason, data: { reason } },
      {
        attemptId: attempt.id,
        expectedVersion: attempt.version,
        leaseToken: lease.token,
        executionFence: lease.fence,
      },
    );
  } finally {
    receipt.adapter.attempts.releaseExecutionLease({
      attemptId: attempt.id,
      ownerId,
      leaseToken: lease.token,
      fence: lease.fence,
    });
  }
}

function open(filename: string): Database.Database {
  const db = new Database(filename);
  db.pragma("busy_timeout=2000");
  connections.push(db);
  return db;
}

function prepareAdmissionFailure(receipt: Fixture) {
  const item = receipt.adapter.submissions.enqueueSessionInbox(
    receipt.run.sessionId,
    "launch",
    {
      summary: "launch",
      objectives: [],
      intent: "new_task",
      targetRunId: null,
      priority: 500,
      urgency: "normal",
      relation: "independent",
      acceptanceCriteria: [],
      scope: "launch",
      nonGoals: [],
      confidence: 1,
      reason: "test",
      routerVersion: "test",
    },
  );
  receipt.store.db.prepare(`UPDATE session_supervisor_inbox SET status='started',run_id=? WHERE id=?`)
    .run(receipt.run.id, item.id);
  return {
    item,
    command: {
      kind: "admission_launch_failed" as const,
      attemptId: receipt.attempt.id,
      expectedVersion: receipt.attempt.version,
      inboxItemId: item.id,
      error: "model initialization failed",
      retryable: true,
    },
    authority: {
      kind: "admission_launch_failure" as const,
      component: "admission_coordinator" as const,
      inboxItemId: item.id,
    },
  };
}

afterEach(() => {
  connections.splice(0).reverse().forEach((db) => db.close());
  stores.splice(0).reverse().forEach((store) => store.close());
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("TaskRun transition authority persistence", () => {
  it("derives runtime scope from the execution fence and only performs reviewed terminal transitions", () => {
    const receipt = fixture();
    const result = receipt.adapter.taskRunTransitions.transitionRuntime({
      kind: "complete",
      reason: "",
      data: { responseHash: "sha256:test" },
    }, receipt.fence);

    expect(result.transitions).toEqual([expect.objectContaining({
      runId: receipt.run.id,
      sourceAttemptId: receipt.attempt.id,
      sourceOrdinal: 1,
      targetAttemptId: receipt.attempt.id,
      targetOrdinal: 1,
      fromStatus: "running",
      toStatus: "completed",
      precedingEvents: [],
      event: expect.objectContaining({
        type: "run.completed",
        seq: 1,
        data: { responseHash: "sha256:test" },
      }),
    })]);
    expect(receipt.adapter.taskRuns.getRun(receipt.run.id)).toMatchObject({
      status: "completed",
      phase: "done",
      lastEventSeq: 1,
    });
    expect(attemptSnapshot(receipt)).toMatchObject({ status: "completed", active: false, version: 2 });
    expect(receipt.adapter.taskRuns.getRun(receipt.run.id)?.blockedReason).toBe("");

    expect(() => receipt.adapter.taskRunTransitions.transitionRuntime({
      kind: "cancel" as never,
      reason: "not reviewed",
      data: {},
    }, receipt.fence)).toThrow(/not allowlisted/);
  });

  it("persists blocked preceding events in order with the main transition", () => {
    const receipt = fixture();
    const result = receipt.adapter.taskRunTransitions.transitionRuntime({
      kind: "block",
      reason: "policy rejected completion",
      data: { gate: "completion" },
      precedingEvents: [
        { kind: "message_rejected", data: { reason: "missing evidence" } },
        { kind: "message_rejected", data: { reason: "checks stale" } },
      ],
    }, receipt.fence);

    const outcome = result.transitions[0]!;
    expect(outcome.precedingEvents.map((event) => [event.seq, event.type])).toEqual([
      [1, "message.rejected"],
      [2, "message.rejected"],
    ]);
    expect(outcome.event).toMatchObject({ seq: 3, type: "run.blocked" });
    expect(receipt.store.listEvents(receipt.run.id).map((event) => event.type))
      .toEqual(["message.rejected", "message.rejected", "run.blocked"]);
  });

  it("persists a runtime failure payload while projecting the Run and Attempt terminal state", () => {
    const receipt = fixture();
    const result = receipt.adapter.taskRunTransitions.transitionRuntime({
      kind: "fail",
      reason: "Runtime exceeded its idle deadline",
      data: {
        reason: "idle_timeout",
        stage: "execute",
        timeoutMs: 30_000,
      },
    }, receipt.fence);

    expect(result.transitions).toEqual([expect.objectContaining({
      runId: receipt.run.id,
      sourceAttemptId: receipt.attempt.id,
      targetAttemptId: receipt.attempt.id,
      fromStatus: "running",
      toStatus: "failed",
      precedingEvents: [],
      event: expect.objectContaining({
        seq: 1,
        type: "run.failed",
        data: {
          reason: "idle_timeout",
          stage: "execute",
          timeoutMs: 30_000,
        },
      }),
    })]);
    expect(receipt.adapter.taskRuns.getRun(receipt.run.id)).toMatchObject({
      status: "failed",
      phase: "discover",
      blockedReason: "Runtime exceeded its idle deadline",
      lastEventSeq: 1,
      completedAt: expect.any(Number),
    });
    expect(attemptSnapshot(receipt)).toMatchObject({
      status: "failed",
      active: false,
      version: 2,
      eventSequence: 1,
    });
    expect(receipt.store.listEvents(receipt.run.id)).toEqual([
      expect.objectContaining({ seq: 1, type: "run.failed", data: { reason: "idle_timeout", stage: "execute", timeoutMs: 30_000 } }),
    ]);
  });

  it("rolls preceding events back when the main event or Run CAS fails", () => {
    for (const failure of ["event", "cas"] as const) {
      const receipt = fixture();
      receipt.store.db.exec(failure === "event"
        ? `CREATE TEMP TRIGGER reject_main_transition BEFORE INSERT ON run_events
          WHEN NEW.type='run.blocked' BEGIN SELECT RAISE(ABORT,'main event rejected'); END`
        : `CREATE TEMP TRIGGER reject_main_transition BEFORE UPDATE ON runs
          WHEN NEW.status='blocked' BEGIN SELECT RAISE(ABORT,'main CAS rejected'); END`);
      expect(() => receipt.adapter.taskRunTransitions.transitionRuntime({
        kind: "block",
        reason: "blocked",
        data: {},
        precedingEvents: [{ kind: "message_rejected", data: { reason: "must rollback" } }],
      }, receipt.fence)).toThrow(failure === "event" ? /main event rejected/ : /main CAS rejected/);
      expect(receipt.store.listEvents(receipt.run.id)).toEqual([]);
      expect(receipt.adapter.taskRuns.getRun(receipt.run.id)).toMatchObject({ status: "running", lastEventSeq: 0 });
      expect(attemptSnapshot(receipt)).toMatchObject({ status: "running", active: true, version: 1 });
      stores.splice(stores.indexOf(receipt.store), 1)[0].close();
    }
  });

  it("rejects stale Attempt identity, version, token, execution fence, lease state, and Run projection", () => {
    const receipt = fixture();
    const transition = (fence: RuntimeTransitionFence = receipt.fence) =>
      receipt.adapter.taskRunTransitions.transitionRuntime({
        kind: "fail",
        reason: "runtime failed",
        data: { stage: "execute" },
      }, fence);
    const unchanged = () => {
      expect(receipt.store.listEvents(receipt.run.id)).toEqual([]);
      expect(receipt.adapter.taskRuns.getRun(receipt.run.id)).toMatchObject({ status: "running" });
    };
    expect(() => transition({ ...receipt.fence, attemptId: "attempt:missing:1" })).toThrow(/does not exist/);
    unchanged();
    expect(() => transition({ ...receipt.fence, expectedVersion: receipt.fence.expectedVersion + 1 }))
      .toThrow(/version mismatch/);
    unchanged();
    expect(() => transition({ ...receipt.fence, leaseToken: "wrong-token" })).toThrow(/token mismatch/);
    unchanged();
    expect(() => transition({ ...receipt.fence, executionFence: receipt.fence.executionFence + 1 }))
      .toThrow(/fence mismatch/);
    unchanged();

    receipt.store.db.prepare("UPDATE execution_leases SET released_at=? WHERE attempt_id=?")
      .run(Date.now(), receipt.attempt.id);
    expect(() => transition()).toThrow(/released or expired/);
    unchanged();
    receipt.store.db.prepare("UPDATE execution_leases SET released_at=NULL WHERE attempt_id=?").run(receipt.attempt.id);

    receipt.store.db.prepare("UPDATE attempts SET status='blocked',active=0 WHERE id=?").run(receipt.attempt.id);
    expect(() => transition()).toThrow(/not active and running/);
    unchanged();
    receipt.store.db.prepare("UPDATE attempts SET status='running',active=1 WHERE id=?").run(receipt.attempt.id);

    receipt.store.db.prepare("UPDATE runs SET attempt=2 WHERE id=?").run(receipt.run.id);
    expect(() => transition()).toThrow(/projection is stale/);
    unchanged();
  });

  it("rejects stale writer authority before runtime transition or exact validation", () => {
    const receipt = fixture();
    receipt.setNow(23_001);
    const currentDb = open(receipt.filename);
    expect(CoreWriterLease.claim(
      currentDb,
      { ownerId: "replacement", pid: process.pid, host: "test-host" },
      { leaseMs: 20_000, heartbeatIntervalMs: 5_000, skewMarginMs: 2_000, nowSql },
    )).not.toBeNull();

    expect(() => receipt.adapter.taskRunTransitions.transitionRuntime({
      kind: "fail",
      reason: "must not transition",
      data: {},
    }, receipt.fence)).toThrow(WriterAuthorityLostError);
    expect(receipt.store.listEvents(receipt.run.id)).toEqual([]);
    expect(receipt.adapter.taskRuns.getRun(receipt.run.id)).toMatchObject({ status: "running" });
  });

  it("requires matching admission authority and current Attempt projection without an execution lease", () => {
    const receipt = fixture();
    const { item, command, authority } = prepareAdmissionFailure(receipt);
    receipt.store.db.prepare("DELETE FROM execution_leases WHERE attempt_id=?").run(receipt.attempt.id);
    expect(() => receipt.adapter.taskRunTransitions.transitionSystem(command, {
      kind: "manual_resume",
      actorId: "operator",
    })).toThrow(/does not permit/);
    expect(() => receipt.adapter.taskRunTransitions.transitionSystem(command, {
      kind: "admission_launch_failure",
      component: "admission_coordinator",
      inboxItemId: "wrong-item",
    })).toThrow(/does not permit/);
    expect(receipt.adapter.submissions.getSessionInboxItem(item.id)).toMatchObject({ status: "started", error: "" });

    receipt.store.db.exec(`CREATE TEMP TRIGGER require_admission_error_before_failure
      BEFORE UPDATE OF status ON runs
      WHEN NEW.status='failed' AND OLD.status='running'
        AND NOT EXISTS (SELECT 1 FROM session_supervisor_inbox
          WHERE run_id=NEW.id AND status='started' AND error='model initialization failed')
      BEGIN SELECT RAISE(ABORT,'admission error was not recorded first'); END`);

    const result = receipt.adapter.taskRunTransitions.transitionSystem(command, authority);
    expect(result.transitions).toEqual([expect.objectContaining({
      runId: receipt.run.id,
      sourceAttemptId: receipt.attempt.id,
      targetAttemptId: receipt.attempt.id,
      fromStatus: "running",
      toStatus: "failed",
      event: expect.objectContaining({ type: "run.failed" }),
    })]);
    expect(receipt.adapter.submissions.getSessionInboxItem(item.id)).toMatchObject({
      status: "started",
      error: "model initialization failed",
    });
  });

  it("rolls the admission inbox error back when its main Run event or CAS fails", () => {
    for (const failure of ["event", "cas"] as const) {
      const receipt = fixture();
      const { item, command, authority } = prepareAdmissionFailure(receipt);
      receipt.store.db.exec(failure === "event"
        ? `CREATE TEMP TRIGGER reject_admission_transition BEFORE INSERT ON run_events
          WHEN NEW.type='run.failed' BEGIN SELECT RAISE(ABORT,'admission event rejected'); END`
        : `CREATE TEMP TRIGGER reject_admission_transition BEFORE UPDATE ON runs
          WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'admission CAS rejected'); END`);

      expect(() => receipt.adapter.taskRunTransitions.transitionSystem(command, authority))
        .toThrow(failure === "event" ? /admission event rejected/ : /admission CAS rejected/);
      expect(receipt.adapter.submissions.getSessionInboxItem(item.id)).toMatchObject({
        status: "started",
        error: "",
      });
      expect(receipt.adapter.taskRuns.getRun(receipt.run.id)).toMatchObject({
        status: "running",
        phase: "discover",
        lastEventSeq: 0,
      });
      expect(attemptSnapshot(receipt)).toMatchObject({ status: "running", active: true, version: 1 });
      expect(receipt.store.listEvents(receipt.run.id)).toEqual([]);
    }
  });

  it("uses exact lifecycle authority and reports every interrupted source Attempt", () => {
    const receipt = fixture();
    const otherSession = receipt.adapter.sessions.createSession("other");
    const otherRun = receipt.adapter.taskRuns.createRun(otherSession.id, "other run");
    const otherAttempt = receipt.adapter.attempts.getActiveAttempt(otherRun.id)!;
    const wrong: SystemTransitionAuthority = {
      kind: "lifecycle_interrupt",
      component: "runtime_registry",
      phase: "shutdown",
    };
    expect(() => receipt.adapter.taskRunTransitions.transitionSystem(
      { kind: "startup_interrupt_active" },
      wrong,
    )).toThrow(/does not permit/);

    const result = receipt.adapter.taskRunTransitions.transitionSystem(
      { kind: "startup_interrupt_active" },
      { kind: "lifecycle_interrupt", component: "execution_lifecycle_service", phase: "startup" },
    );
    expect(result.transitions).toHaveLength(2);
    expect(result.transitions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        runId: receipt.run.id,
        sourceAttemptId: receipt.attempt.id,
        targetAttemptId: receipt.attempt.id,
        fromStatus: "running",
        toStatus: "interrupted",
        event: null,
      }),
      expect.objectContaining({
        runId: otherRun.id,
        sourceAttemptId: otherAttempt.id,
        targetAttemptId: otherAttempt.id,
        fromStatus: "running",
        toStatus: "interrupted",
        event: null,
      }),
    ]));
  });

  it("makes lifecycle interruption idempotent and leaves non-running Runs unchanged", () => {
    const receipt = fixture();
    const blockedSession = receipt.adapter.sessions.createSession("blocked");
    const blocked = receipt.adapter.taskRuns.createRun(blockedSession.id, "blocked run");
    transitionFixtureRun(receipt, blocked.id, "block", "review required");
    const completedSession = receipt.adapter.sessions.createSession("completed");
    const completed = receipt.adapter.taskRuns.createRun(completedSession.id, "completed run");
    transitionFixtureRun(receipt, completed.id, "complete");
    const blockedBefore = receipt.adapter.taskRuns.getRun(blocked.id);
    const completedBefore = receipt.adapter.taskRuns.getRun(completed.id);

    const first = receipt.adapter.taskRunTransitions.transitionSystem(
      { kind: "shutdown_interrupt_active" },
      { kind: "lifecycle_interrupt", component: "runtime_registry", phase: "shutdown" },
    );
    expect(first.transitions).toEqual([expect.objectContaining({
      runId: receipt.run.id,
      sourceAttemptId: receipt.attempt.id,
      targetAttemptId: receipt.attempt.id,
      fromStatus: "running",
      toStatus: "interrupted",
    })]);
    const interruptedRun = receipt.adapter.taskRuns.getRun(receipt.run.id);
    const interruptedAttempt = attemptSnapshot(receipt);

    const second = receipt.adapter.taskRunTransitions.transitionSystem(
      { kind: "shutdown_interrupt_active" },
      { kind: "lifecycle_interrupt", component: "runtime_registry", phase: "shutdown" },
    );
    expect(second.transitions).toEqual([]);
    expect(receipt.adapter.taskRuns.getRun(receipt.run.id)).toEqual(interruptedRun);
    expect(attemptSnapshot(receipt)).toEqual(interruptedAttempt);
    expect(receipt.adapter.taskRuns.getRun(blocked.id)).toEqual(blockedBefore);
    expect(receipt.adapter.taskRuns.getRun(completed.id)).toEqual(completedBefore);
  });

  it("fails closed before bulk interruption when a running Run lacks its active Attempt projection", () => {
    const receipt = fixture();
    const otherSession = receipt.adapter.sessions.createSession("broken projection");
    const otherRun = receipt.adapter.taskRuns.createRun(otherSession.id, "broken run");
    const otherAttempt = receipt.adapter.attempts.getActiveAttempt(otherRun.id)!;
    receipt.store.db.prepare("UPDATE attempts SET status='interrupted',active=0 WHERE id=?")
      .run(otherAttempt.id);

    expect(() => receipt.adapter.taskRunTransitions.transitionSystem(
      { kind: "shutdown_interrupt_active" },
      { kind: "lifecycle_interrupt", component: "runtime_registry", phase: "shutdown" },
    )).toThrow(/missing its active running Attempt projection/);
    expect(receipt.adapter.taskRuns.getRun(receipt.run.id)).toMatchObject({ status: "running" });
    expect(receipt.adapter.taskRuns.getRun(otherRun.id)).toMatchObject({ status: "running" });
    expect(attemptSnapshot(receipt)).toMatchObject({ status: "running", active: true });
  });

  it("resumes manual, approved, and submitted-input transitions into the next derived Attempt", () => {
    const scenarios = ["manual", "approval", "input"] as const;
    for (const scenario of scenarios) {
      const receipt = fixture();
      let command;
      let authority;
      if (scenario === "input") {
        const pending = receipt.adapter.taskRuns.requestUserInput(receipt.run.id, "Value?", [{
          key: "value",
          label: "Value",
          description: "",
          inputType: "text",
          required: true,
          placeholder: "value",
        }]);
        receipt.adapter.taskRuns.submitUserInput(pending.id, { value: "accepted" });
        const source = receipt.adapter.attempts.getAttempt(receipt.attempt.id)!;
        command = {
          kind: "resume_input" as const,
          attemptId: source.id,
          expectedVersion: source.version,
          inputRequestId: pending.id,
        };
        authority = { kind: "input_resume" as const, inputRequestId: pending.id };
      } else {
        transitionFixtureRun(receipt, receipt.run.id, "block", "review required");
        const source = receipt.adapter.attempts.getAttempt(receipt.attempt.id)!;
        if (scenario === "manual") {
          command = {
            kind: "resume_manual" as const,
            attemptId: source.id,
            expectedVersion: source.version,
            reason: "operator requested",
          };
          authority = { kind: "manual_resume" as const, actorId: "operator-1" };
        } else {
          receipt.store.db.prepare(`INSERT INTO supervisor_decisions
            (id,run_id,attempt,checkpoint_seq,trigger,action,reason_code,rationale,confidence,status,created_at)
            VALUES ('resume-decision',?,1,1,'test','resume_taskrun','test','test',1,'executed',1)`)
            .run(receipt.run.id);
          receipt.store.db.prepare(`INSERT INTO approval_requests
            (id,run_id,decision_id,action_type,target_type,target_id,reason,metadata_json,status,requested_at)
            VALUES ('resume-approval',?,'resume-decision','resume_taskrun','taskrun',?,'approved','{}','approved',1)`)
            .run(receipt.run.id, receipt.run.id);
          command = {
            kind: "resume_approval" as const,
            attemptId: source.id,
            expectedVersion: source.version,
            approvalId: "resume-approval",
          };
          authority = { kind: "approval_resume" as const, approvalId: "resume-approval" };
        }
      }
      const result = receipt.adapter.taskRunTransitions.transitionSystem(command, authority);
      expect(result.transitions).toEqual([expect.objectContaining({
        runId: receipt.run.id,
        sourceAttemptId: receipt.attempt.id,
        sourceOrdinal: 1,
        targetAttemptId: attemptIdFor(receipt.run.id, 2),
        targetOrdinal: 2,
        toStatus: "running",
        event: null,
      })]);
      expect(receipt.adapter.taskRuns.getRun(receipt.run.id)).toMatchObject({ status: "running", attempt: 2 });
      stores.splice(stores.indexOf(receipt.store), 1)[0].close();
    }
  });

  it("rejects system authority casts, mismatched evidence, stale versions, and extra keys", () => {
    const receipt = fixture();
    transitionFixtureRun(receipt, receipt.run.id, "block", "blocked");
    const source = receipt.adapter.attempts.getAttempt(receipt.attempt.id)!;
    const command = {
      kind: "resume_manual" as const,
      attemptId: source.id,
      expectedVersion: source.version,
      reason: "manual",
    };
    expect(() => receipt.adapter.taskRunTransitions.transitionSystem(command, {
      kind: "manual_resume",
      actorId: "",
    })).toThrow(/actorId/);
    expect(() => receipt.adapter.taskRunTransitions.transitionSystem(
      { ...command, expectedVersion: command.expectedVersion + 1 },
      { kind: "manual_resume", actorId: "operator" },
    )).toThrow(/version mismatch/);
    expect(() => receipt.adapter.taskRunTransitions.transitionSystem(
      { ...command, runId: receipt.run.id } as never,
      { kind: "manual_resume", actorId: "operator" },
    )).toThrow(/must contain exactly/);
    expect(() => receipt.adapter.taskRunTransitions.transitionSystem(
      command,
      { kind: "system" } as never,
    )).toThrow(/not allowlisted/);
    expect(receipt.adapter.taskRuns.getRun(receipt.run.id)).toMatchObject({ status: "blocked", attempt: 1 });
  });

  it("rejects stale writer authority before a system transition can write related state", () => {
    const receipt = fixture();
    const { item, command, authority } = prepareAdmissionFailure(receipt);
    receipt.setNow(23_001);
    const currentDb = open(receipt.filename);
    expect(CoreWriterLease.claim(
      currentDb,
      { ownerId: "replacement-system", pid: process.pid, host: "test-host" },
      { leaseMs: 20_000, heartbeatIntervalMs: 5_000, skewMarginMs: 2_000, nowSql },
    )).not.toBeNull();

    expect(() => receipt.adapter.taskRunTransitions.transitionSystem(command, authority))
      .toThrow(WriterAuthorityLostError);
    expect(receipt.adapter.submissions.getSessionInboxItem(item.id)).toMatchObject({
      status: "started",
      error: "",
    });
    expect(receipt.adapter.taskRuns.getRun(receipt.run.id)).toMatchObject({
      status: "running",
      phase: "discover",
      lastEventSeq: 0,
    });
    expect(attemptSnapshot(receipt)).toMatchObject({ status: "running", active: true, version: 1 });
    expect(receipt.store.listEvents(receipt.run.id)).toEqual([]);
  });
});
