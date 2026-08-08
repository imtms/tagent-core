import { afterEach, describe, expect, it } from "vitest";
import type { FencedRuntimeMutationContext } from "@tagent/execution/ports";
import { LegacyStoreAdapter, Store } from "@tagent/persistence-sqlite";
import type { SynchronousResult } from "@tagent/persistence-sqlite/unit-of-work";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

function fixture() {
  const store = new Store(":memory:");
  stores.push(store);
  const adapter = new LegacyStoreAdapter(store, {
    run<T>(work: () => T & SynchronousResult<T>): T { return store.db.transaction(work)(); },
  });
  const run = adapter.taskRuns.createRun(adapter.sessions.createSession().id, "fenced runtime mutation");
  const attempt = adapter.attempts.getActiveAttempt(run.id)!;
  const lease = adapter.attempts.acquireExecutionLease({
    attemptId: attempt.id,
    expectedVersion: attempt.version,
    ownerId: "runtime",
    leaseMs: 30_000,
  });
  const context: FencedRuntimeMutationContext = {
    attemptId: attempt.id,
    expectedVersion: attempt.version,
    leaseToken: lease.token,
    fence: lease.fence,
  };
  return { store, adapter, run, attempt, context };
}

function inputFields() {
  return [{
    key: "target",
    label: "Target",
    description: "Deployment target",
    inputType: "text" as const,
    required: true,
    placeholder: "staging",
  }];
}

describe("Fenced RuntimeMutationPort", () => {
  it("validates the complete Attempt, lease, and TaskRun projection before mutation", () => {
    const { store, adapter, run, attempt, context } = fixture();
    const append = (candidate: FencedRuntimeMutationContext = context) =>
      adapter.runtimeMutations.appendEvent(candidate, "runtime.fenced", {});
    const eventCount = () => (store.db.prepare("SELECT COUNT(*) count FROM run_events").get() as { count: number }).count;
    const rejected = (mutation: () => void, restore?: () => void) => {
      expect(mutation).toThrow();
      expect(eventCount()).toBe(0);
      restore?.();
    };

    rejected(() => append({ ...context, attemptId: "attempt:missing:1" }));
    rejected(() => append({ ...context, expectedVersion: context.expectedVersion + 1 }));
    rejected(() => append({ ...context, leaseToken: "wrong-token" }));
    rejected(() => append({ ...context, fence: context.fence + 1 }));

    store.db.prepare("UPDATE execution_leases SET attempt_version=attempt_version+1 WHERE attempt_id=?")
      .run(attempt.id);
    rejected(
      () => append(),
      () => store.db.prepare("UPDATE execution_leases SET attempt_version=? WHERE attempt_id=?")
        .run(attempt.version, attempt.id),
    );

    store.db.prepare("UPDATE execution_leases SET released_at=? WHERE attempt_id=?").run(Date.now(), attempt.id);
    rejected(
      () => append(),
      () => store.db.prepare("UPDATE execution_leases SET released_at=NULL WHERE attempt_id=?").run(attempt.id),
    );

    store.db.prepare("UPDATE execution_leases SET lease_until=0,heartbeat_at=0 WHERE attempt_id=?").run(attempt.id);
    rejected(
      () => append(),
      () => store.db.prepare("UPDATE execution_leases SET lease_until=?,heartbeat_at=? WHERE attempt_id=?")
        .run(Date.now() + 30_000, Date.now(), attempt.id),
    );

    store.db.prepare("UPDATE attempts SET status='waiting_input',active=0 WHERE id=?").run(attempt.id);
    rejected(
      () => append(),
      () => store.db.prepare("UPDATE attempts SET status='running',active=1 WHERE id=?").run(attempt.id),
    );

    store.db.prepare("UPDATE runs SET attempt=attempt+1 WHERE id=?").run(run.id);
    rejected(
      () => append(),
      () => store.db.prepare("UPDATE runs SET attempt=? WHERE id=?").run(attempt.ordinal, run.id),
    );

    store.db.prepare("UPDATE runs SET status='blocked' WHERE id=?").run(run.id);
    rejected(
      () => append(),
      () => store.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run.id),
    );

    expect(append()).toMatchObject({ runId: run.id, seq: 1, type: "runtime.fenced" });
  });

  it("rejects stale tokens before every runtime-owned mutation has side effects", () => {
    const { store, adapter, context } = fixture();
    const stale = { ...context, leaseToken: "stale-token" };
    const snapshot = () => store.db.prepare(`SELECT
      (SELECT COUNT(*) FROM run_events) events,
      (SELECT COUNT(*) FROM run_transcript) transcript,
      (SELECT COUNT(*) FROM user_input_requests) inputs,
      (SELECT COUNT(*) FROM run_checkpoints) checkpoints,
      (SELECT COUNT(*) FROM operations) operations,
      (SELECT COUNT(*) FROM tool_attempts) tools,
      (SELECT COUNT(*) FROM plan_items) plans,
      (SELECT COUNT(*) FROM run_checks) checks,
      (SELECT COUNT(*) FROM artifacts) artifacts,
      (SELECT phase FROM runs LIMIT 1) phase`).get();
    const baseline = snapshot();
    const attempts = [
      () => adapter.runtimeMutations.appendEvent(stale, "runtime.event", {}),
      () => adapter.runtimeMutations.appendTranscript(stale, {} as never),
      () => adapter.runtimeMutations.setRunPhase(stale, "plan"),
      () => adapter.runtimeMutations.advanceRunPhase(stale, "implement"),
      () => adapter.runtimeMutations.requestUserInput(stale, "Target?", inputFields(), "tool-input"),
      () => adapter.runtimeMutations.upsertCheckpoint(stale, {
        active: true,
        assistantPartial: "partial",
        currentTool: null,
        lastEventSeq: 0,
        lastTranscriptSeq: 0,
      }),
      () => adapter.runtimeMutations.claimOperation(stale, "operation-1", "bash", {}),
      () => adapter.runtimeMutations.updateOperation(stale, "operation-1", { status: "failed" }),
      () => adapter.runtimeMutations.recordToolAttempt(stale, "tool-1", "read", {}),
      () => adapter.runtimeMutations.completeToolAttempt(stale, "tool-1", true),
      () => adapter.runtimeMutations.upsertPlanItem(stale, {
        key: "plan-1", title: "Plan", status: "pending", required: true, position: 1,
      }),
      () => adapter.runtimeMutations.markChecksStale(stale),
      () => adapter.runtimeMutations.upsertCheck(stale, {
        key: "check-1", title: "Check", status: "pending", required: true,
        command: "", evidence: "", stale: false,
      }),
      () => adapter.runtimeMutations.applyTaskRunBatch(stale, [{
        action: "plan", item: { key: "batch-plan", title: "Batch", status: "done", required: true, position: 1 },
      }]),
      () => adapter.runtimeMutations.addArtifact(stale, {
        id: "artifact-1", kind: "text", title: "Artifact", content: "content", uri: "",
      }),
    ];
    for (const mutate of attempts) {
      expect(mutate).toThrow(/token/);
      expect(snapshot()).toEqual(baseline);
    }

    expect(adapter.runtimeMutations.appendEvent(context, "runtime.event", {})).toMatchObject({ seq: 1 });
  });

  it("applies a task_run batch atomically behind one execution-fence validation", () => {
    const { store, adapter, run, context } = fixture();
    store.addArtifact(run.id, { id: "duplicate", title: "Existing", kind: "artifact", content: "", uri: "" });
    expect(() => adapter.runtimeMutations.applyTaskRunBatch(context, [
      { action: "plan", item: { key: "rollback", title: "Rollback", status: "done", required: true, position: 1 } },
      { action: "phase", phase: "review" },
      { action: "artifact", artifact: { id: "duplicate", title: "Duplicate", kind: "artifact", content: "", uri: "" } },
    ])).toThrow();
    expect(store.getRun(run.id)).toMatchObject({ phase: "discover", plan: [], artifacts: [expect.objectContaining({ id: "duplicate", title: "Existing" })] });
  });

  it("atomically settles request_user_input, its event, and the active tool attempt", () => {
    const { store, adapter, run, attempt, context } = fixture();
    adapter.runtimeMutations.recordToolAttempt(context, "tool-input", "task_run", { action: "request_user_input" });
    store.db.exec(`CREATE TRIGGER reject_waiting_input_event BEFORE INSERT ON run_events BEGIN
      SELECT RAISE(ABORT, 'waiting input event rejected');
    END`);

    expect(() => adapter.runtimeMutations.requestUserInput(context, "Target?", inputFields(), "tool-input"))
      .toThrow(/waiting input event rejected/);
    expect(store.getRun(run.id)).toMatchObject({ status: "running", attempt: 1, lastEventSeq: 0 });
    expect(adapter.attempts.getAttempt(attempt.id)).toMatchObject({ status: "running", version: 1, active: true });
    expect(store.db.prepare("SELECT status FROM tool_attempts WHERE tool_call_id='tool-input'").get())
      .toEqual({ status: "running" });
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM user_input_requests").get()).toEqual({ count: 0 });

    store.db.exec("DROP TRIGGER reject_waiting_input_event");
    const settled = adapter.runtimeMutations.requestUserInput(context, "Target?", inputFields(), "tool-input");
    expect(settled).toMatchObject({
      request: { runId: run.id, status: "pending" },
      event: { runId: run.id, seq: 1, type: "run.waiting_for_input" },
      toolAttemptCompleted: true,
    });
    expect(store.getRun(run.id)).toMatchObject({ status: "waiting_input", lastEventSeq: 1 });
    expect(adapter.attempts.getAttempt(attempt.id)).toMatchObject({
      status: "waiting_input", version: 2, legacyEventSeq: 1, active: false,
    });
    expect(store.db.prepare("SELECT status FROM tool_attempts WHERE tool_call_id='tool-input'").get())
      .toEqual({ status: "succeeded" });
    expect(() => adapter.runtimeMutations.appendEvent(context, "stale.callback", {})).toThrow(/version|running/);
    expect(store.listEvents(run.id)).toHaveLength(1);
  });
});
