import { afterEach, describe, expect, it } from "vitest";
import {
  ATTEMPT_STATUSES,
  assertAttemptTransition,
  attemptIdFor,
  canTransitionAttempt,
  isActiveAttemptStatus,
  type AttemptStatus,
} from "@tagent/execution/domain";
import { SqlitePersistence, Store } from "@tagent/persistence-sqlite";
import type { SynchronousResult } from "@tagent/persistence-sqlite/unit-of-work";
import { transitionTaskRun } from "./support/test-persistence.js";

const stores: Store[] = [];

function fixture() {
  const store = new Store(":memory:");
  stores.push(store);
  const adapter = new SqlitePersistence(store, {
    run<T>(work: () => T & SynchronousResult<T>): T {
      return store.db.transaction(work)();
    },
  });
  return { store, adapter };
}

afterEach(() => stores.splice(0).forEach((store) => store.close()));

describe("Attempt shadow domain", () => {
  it("enforces the first-class Attempt state machine exhaustively", () => {
    const allowed: Readonly<Record<AttemptStatus, readonly AttemptStatus[]>> = {
      queued: ["starting", "failed", "cancelled", "interrupted"],
      starting: ["running", "failed", "cancelled", "interrupted"],
      running: ["settling", "waiting_input", "blocked", "failed", "cancelled", "interrupted"],
      settling: ["completed", "blocked", "failed", "cancelled", "interrupted"],
      waiting_input: ["blocked"],
      blocked: [],
      completed: [],
      failed: [],
      cancelled: [],
      interrupted: [],
      superseded: [],
    };
    for (const from of ATTEMPT_STATUSES) {
      for (const to of ATTEMPT_STATUSES) {
        const expected = allowed[from].includes(to);
        expect(canTransitionAttempt(from, to), `${from} -> ${to}`).toBe(expected);
        if (expected) expect(() => assertAttemptTransition(from, to)).not.toThrow();
        else expect(() => assertAttemptTransition(from, to)).toThrow(/cannot transition/);
      }
    }
    expect(ATTEMPT_STATUSES.filter(isActiveAttemptStatus)).toEqual(["queued", "starting", "running", "settling"]);
  });

  it("uses deterministic AttemptIds and projects initial and resumed attempts", () => {
    const { store, adapter } = fixture();
    const session = adapter.sessions.createSession();
    const run = adapter.taskRuns.createRun(session.id, "attempt projection", "run-request");

    expect(attemptIdFor(run.id, 1)).toBe(`attempt:${run.id}:1`);
    expect(adapter.attempts.getAttemptForRun(run.id, 1)).toMatchObject({
      id: attemptIdFor(run.id, 1), runId: run.id, ordinal: 1,
      trigger: "initial", status: "running", active: true, version: 1,
    });

    transitionTaskRun(store, run.id, "block", "needs another pass");
    store.resumeRun(run.id);

    expect(adapter.attempts.listAttempts(run.id)).toMatchObject([
      { id: attemptIdFor(run.id, 1), status: "blocked", active: false },
      { id: attemptIdFor(run.id, 2), trigger: "resume", status: "running", active: true, version: 1 },
    ]);
  });

  it("projects input, continuation, retry, recovery, and terminal scenarios", () => {
    const { store, adapter } = fixture();
    const session = adapter.sessions.createSession();

    const inputRun = adapter.taskRuns.createRun(session.id, "input");
    const input = adapter.taskRuns.requestUserInput(inputRun.id, "Target?", [{
      key: "target",
      label: "Target",
      description: "Deployment target",
      inputType: "text",
      required: true,
      placeholder: "staging",
    }]);
    adapter.taskRuns.submitUserInput(input.id, { target: "staging" });
    store.resumeRun(inputRun.id);
    expect(adapter.attempts.getAttemptForRun(inputRun.id, 2)).toMatchObject({ trigger: "input", active: true });

    const continuationRun = adapter.taskRuns.createRun(adapter.sessions.createSession().id, "continuation");
    transitionTaskRun(store, continuationRun.id, "block", "gate");
    adapter.continuations.queueContinuation(continuationRun.id, "gate");
    const claimed = adapter.continuations.claimContinuation(continuationRun.id, "worker", 30_000)!;
    expect(adapter.attempts.getAttemptForRun(continuationRun.id, claimed.run.attempt)).toMatchObject({ trigger: "continuation", active: true });

    const retrySession = adapter.sessions.createSession();
    const inbox = adapter.submissions.enqueueSessionInbox(retrySession.id, "retry", {
      summary: "retry", objectives: [{ id: "objective-1", summary: "retry", timing: "current", kind: "change" }],
      intent: "new_task", targetRunId: null, priority: 500, urgency: "normal", relation: "independent",
      acceptanceCriteria: ["retry"], scope: "retry", nonGoals: [], confidence: 1, reason: "test", routerVersion: "test",
    }, "retry-request");
    const retryRun = adapter.submissions.claimSessionInboxNow(inbox.id, retrySession.id);
    expect(retryRun.status).toBe("started");
    if (retryRun.status !== "started") throw new Error("retry fixture did not start");
    adapter.submissions.recordSessionInboxLaunchFailure(inbox.id, retryRun.run.id, "initialize failed");
    store.transitionRun(retryRun.run.id, ["running"], "failed", "run.failed", { reason: "runtime_initialization_failed", retryable: true }, "failed", 1);
    const retried = adapter.submissions.retryInboxLaunch(retryRun.run.id);
    expect(retried.status).toBe("started");
    expect(adapter.attempts.getAttemptForRun(retryRun.run.id, 2)).toMatchObject({ trigger: "retry", active: true });

    const recoveryRun = adapter.taskRuns.createRun(adapter.sessions.createSession().id, "recovery");
    store.markInterrupted();
    expect(adapter.attempts.getAttemptForRun(recoveryRun.id, 1)).toMatchObject({ status: "interrupted", active: false });

    const terminalRun = adapter.taskRuns.createRun(adapter.sessions.createSession().id, "terminal");
    store.transitionRun(terminalRun.id, ["running"], "completed", "run.completed", {}, "", 1);
    expect(adapter.attempts.getAttemptForRun(terminalRun.id, 1)).toMatchObject({ status: "completed", active: false });
  });
});
