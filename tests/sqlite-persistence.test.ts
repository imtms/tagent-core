import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import type { SessionInputAnalysis } from "@tagent/admission/domain";
import type { MutationUnitOfWork, SynchronousResult } from "@tagent/persistence-sqlite/unit-of-work";
import { CoreWriterLease, WriterFenceGuard } from "@tagent/persistence-sqlite/writer";
import {
  createGuardedSqlitePersistence,
  GuardedSqliteUnitOfWork,
  SqlitePersistence,
  Store,
} from "@tagent/persistence-sqlite";

const stores: Store[] = [];

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
});

function transactionalUnitOfWork(store: Store): MutationUnitOfWork {
  return {
    run<T>(work: () => T & SynchronousResult<T>): T {
      return store.db.transaction(work)();
    },
  };
}

function createAdapter(store: Store) {
  return new SqlitePersistence(store, transactionalUnitOfWork(store));
}

function inputAnalysis(summary: string): SessionInputAnalysis {
  return {
    summary,
    objectives: [{ id: "objective-1", summary, timing: "current", kind: "change" }],
    intent: "new_task",
    targetRunId: null,
    priority: 500,
    urgency: "normal",
    relation: "independent",
    acceptanceCriteria: ["Persist once"],
    scope: summary,
    nonGoals: [],
    confidence: 1,
    reason: "adapter parity test",
    routerVersion: "test-v1",
  };
}

describe("SqlitePersistence", () => {
  it("preserves admission request deduplication", () => {
    const store = new Store(":memory:");
    stores.push(store);
    const adapter = createAdapter(store);

    const firstSession = adapter.sessions.createSession("First title", "session-request-1");
    const retriedSession = adapter.sessions.createSession("Changed title", "session-request-1");
    expect(retriedSession).toEqual(firstSession);
    expect(adapter.sessions.listSessions()).toEqual([firstSession]);

    const firstSubmission = adapter.submissions.enqueueSessionInbox(
      firstSession.id,
      "Original submission",
      inputAnalysis("Original submission"),
      "submission-request-1",
    );
    const retriedSubmission = adapter.submissions.enqueueSessionInbox(
      firstSession.id,
      "Original submission",
      inputAnalysis("Original submission"),
      "submission-request-1",
    );
    expect(retriedSubmission).toEqual(firstSubmission);
    expect(() => adapter.submissions.enqueueSessionInbox(
      firstSession.id,
      "Changed retry body",
      inputAnalysis("Changed retry body"),
      "submission-request-1",
    )).toThrow("idempotency conflict");
    expect(adapter.submissions.listSessionInbox(firstSession.id, true)).toEqual([firstSubmission]);
    expect(adapter).not.toHaveProperty("db");
    expect(adapter).not.toHaveProperty("store");
  });

  it("serves TaskRun idempotency and pending-input lookups through named ports", () => {
    const store = new Store(":memory:");
    stores.push(store);
    const adapter = createAdapter(store);
    const run = adapter.taskRuns.createRun(adapter.sessions.createSession().id, "lookup run", "run-request-1");
    const request = adapter.taskRuns.requestUserInput(run.id, "Choose", [{
      key: "choice",
      label: "Choice",
      description: "Select an option",
      inputType: "text",
      required: true,
      placeholder: "option",
    }]);

    expect(adapter.taskRuns.getRunByRequestId("run-request-1")?.id).toBe(run.id);
    expect(adapter.taskRuns.getRunByRequestId("missing")).toBeUndefined();
    expect(adapter.taskRuns.getPendingUserInputRequestById(request.id)).toEqual(request);
    expect(adapter.taskRuns.getPendingUserInputRequestById("missing")).toBeUndefined();
  });

  it("serves durable message sources without exposing SQLite", () => {
    const store = new Store(":memory:");
    stores.push(store);
    const adapter = createAdapter(store);
    const session = adapter.sessions.createSession();
    const user = adapter.sessions.appendMessage(session.id, "user", "Remember this preference");
    adapter.sessions.appendMessage(session.id, "assistant", "Acknowledged");

    expect(adapter.messageSources.getMessageSource(user.id)).toEqual({
      id: user.id,
      role: "user",
      content: user.content,
    });
    expect(adapter.messageSources.listDurableUserMessages()).toEqual([
      { id: user.id, content: user.content, sessionId: session.id, principalId: null },
    ]);
  });

  it("rolls back a Run transition and preserves contiguous event ordering", () => {
    const store = new Store(":memory:");
    stores.push(store);
    const adapter = createAdapter(store);
    const run = adapter.taskRuns.createRun(adapter.sessions.createSession().id, "atomic transition");
    const attempt = adapter.attempts.getActiveAttempt(run.id)!;
    const executionLease = adapter.attempts.acquireExecutionLease({
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      ownerId: "sqlite-persistence-test",
      leaseMs: 30_000,
    });
    const failRun = (reason: string) => adapter.taskRunTransitions.transitionRuntime({
      kind: "fail",
      reason,
      data: { reason },
    }, {
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      leaseToken: executionLease.token,
      executionFence: executionLease.fence,
    });
    const initial = adapter.events.appendEvent(run.id, "run.started", { source: "test" });
    adapter.checkpoints.upsertCheckpoint({
      runId: run.id,
      attempt: run.attempt,
      active: true,
      assistantPartial: "partial",
      currentTool: null,
      lastEventSeq: initial.seq,
      lastTranscriptSeq: 0,
    });
    store.db.exec(`
      CREATE TRIGGER reject_checkpoint_finalization
      BEFORE UPDATE ON run_checkpoints
      BEGIN
        SELECT RAISE(ABORT, 'checkpoint finalization rejected');
      END
    `);

    expect(() => failRun("rejected transition")).toThrow("checkpoint finalization rejected");
    expect(adapter.taskRuns.getRun(run.id)).toMatchObject({
      status: "running",
      lastEventSeq: initial.seq,
      blockedReason: "",
    });
    expect(adapter.events.listEvents(run.id)).toEqual([initial]);
    expect(adapter.checkpoints.getCheckpoint(run.id)).toMatchObject({
      active: true,
      assistantPartial: "partial",
      lastEventSeq: initial.seq,
    });

    store.db.exec("DROP TRIGGER reject_checkpoint_finalization");
    const transitioned = failRun("accepted transition").transitions[0]!.event;
    expect(transitioned).toMatchObject({ seq: initial.seq + 1, type: "run.failed" });
    expect(adapter.events.listEvents(run.id).map(({ seq, type }) => ({ seq, type }))).toEqual([
      { seq: 1, type: "run.started" },
      { seq: 2, type: "run.failed" },
    ]);
    expect(adapter.checkpoints.getCheckpoint(run.id)).toMatchObject({ active: false });
  });

  it("preserves consumer generations and ACK validation", () => {
    const store = new Store(":memory:");
    stores.push(store);
    const adapter = createAdapter(store);
    const run = adapter.taskRuns.createRun(adapter.sessions.createSession().id, "consumer ACKs");
    adapter.events.appendEvent(run.id, "message.delta", { delta: "first", ordinal: 1 });
    adapter.events.appendEvent(run.id, "message.delta", { delta: "second", ordinal: 1 });

    const firstClaim = adapter.eventConsumers.claimEventConsumer(run.id, "gateway");
    expect(adapter.eventConsumers.ackEventConsumer(run.id, "gateway", firstClaim.generation, 1)).toBe("accepted");
    const secondClaim = adapter.eventConsumers.claimEventConsumer(run.id, "gateway");
    expect(secondClaim).toMatchObject({ generation: firstClaim.generation + 1, ackedSeq: 1 });
    expect(adapter.eventConsumers.ackEventConsumer(run.id, "gateway", firstClaim.generation, 2)).toBe("stale");
    expect(adapter.eventConsumers.ackEventConsumer(run.id, "gateway", secondClaim.generation, 3)).toBe("invalid");
    expect(adapter.eventConsumers.ackEventConsumer(run.id, "gateway", secondClaim.generation, 2)).toBe("accepted");
    expect(adapter.eventConsumers.getEventConsumer(run.id, "gateway")).toMatchObject({
      generation: secondClaim.generation,
      ackedSeq: 2,
    });
  });

  it("rejects stale-owner mutations before Store state changes while allowing queries", () => {
    const store = new Store(":memory:");
    stores.push(store);
    const firstLease = CoreWriterLease.claim(store.db, {
      ownerId: "adapter-owner-a",
      pid: process.pid,
      host: "test-host",
    })!;
    const staleGuard = new WriterFenceGuard(store.db, firstLease.authority);
    const adapter = createGuardedSqlitePersistence(store, staleGuard);
    const existing = adapter.sessions.createSession("Existing session", "existing-request");
    expect(firstLease.release()).toBe(true);
    const currentLease = CoreWriterLease.claim(store.db, {
      ownerId: "adapter-owner-b",
      pid: process.pid,
      host: "test-host",
    })!;

    expect(adapter.sessions.getSession(existing.id)).toEqual(existing);
    expect(adapter.sessions.listSessions()).toEqual([existing]);
    expect(() => adapter.sessions.createSession("Must not persist", "stale-request"))
      .toThrow("Core writer authority lost");
    expect(adapter.sessions.listSessions()).toEqual([existing]);
    expect(store.getSession(existing.id)).toEqual(existing);
    expect(currentLease.release()).toBe(true);
  });

  it("keeps the guarded mutation bridge synchronous at type and runtime boundaries", () => {
    expectTypeOf<SynchronousResult<Promise<number>>>().toEqualTypeOf<never>();
    const store = new Store(":memory:");
    stores.push(store);
    const lease = CoreWriterLease.claim(store.db, {
      ownerId: "adapter-async-owner",
      pid: process.pid,
      host: "test-host",
    })!;
    const unitOfWork = new GuardedSqliteUnitOfWork(new WriterFenceGuard(store.db, lease.authority));
    const invokeUnsafely = unitOfWork.run.bind(unitOfWork) as unknown as (
      work: () => Promise<void>
    ) => Promise<void>;

    expect(() => invokeUnsafely(async () => {
      store.createSession("Async prefix must roll back", "async-prefix");
    })).toThrow("callbacks must be synchronous");
    expect(store.listSessions()).toEqual([]);
  });
});
