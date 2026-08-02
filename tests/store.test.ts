import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/store.js";

const stores: Store[] = [];
const analysis = (summary: string, priority = 500) => ({ summary, intent: "new_task" as const, targetRunId: null, priority, urgency: "normal" as const, relation: "independent" as const, acceptanceCriteria: [`Complete ${summary}`], scope: summary, nonGoals: [], confidence: 1, reason: "test", routerVersion: "test" });
const createStore = () => {
  const store = new Store(":memory:");
  stores.push(store);
  return store;
};
afterEach(() => stores.splice(0).forEach((store) => store.close()));

describe("Store", () => {
  it("persists a user input pause and accepts a validated submission", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "needs deployment target");
    const request = store.requestUserInput(run.id, "Choose the deployment target", [{ key: "target", label: "Target", description: "Environment name", inputType: "text", required: true, placeholder: "staging" }]);
    expect(store.getRun(run.id)).toMatchObject({ status: "waiting_input", phase: "waiting_input", pendingUserInput: { id: request.id, prompt: "Choose the deployment target" } });
    expect(() => store.resumeRun(run.id)).toThrow("waiting for the requested user input");
    expect(() => store.submitUserInput(request.id, {})).toThrow("Target is required");
    store.submitUserInput(request.id, { target: "staging" });
    expect(store.getRun(run.id)?.pendingUserInput).toBeNull();
    expect(store.resumeRun(run.id)).toMatchObject({ status: "running", phase: "implement", attempt: 2 });
    store.close();
  });
  it("creates a Session only once for an external requestId", () => {
    const store = createStore();
    const first = store.createSession("First", "external-session-1");
    const duplicate = store.createSession("Changed", "external-session-1");
    expect(duplicate).toEqual(first);
    expect(store.listSessions()).toHaveLength(1);
  });

  it("renames a workspace and updates its timestamp", () => {
    const store = createStore();
    const session = store.createSession("Before");
    const renamed = store.renameSession(session.id, "  After  ");
    expect(renamed).toMatchObject({ id: session.id, title: "After" });
    expect(renamed!.updatedAt).toBeGreaterThanOrEqual(session.updatedAt);
    expect(store.renameSession("missing", "Name")).toBeUndefined();
  });

  it("exposes the latest TaskRun status with each workspace", () => {
    const store = createStore();
    const idle = store.createSession("Idle");
    const active = store.createSession("Active");
    const firstRun = store.createRun(active.id, "first");
    store.finalizeRun(firstRun.id, "completed");
    const latestRun = store.createRun(active.id, "latest");
    store.setRunPhase(latestRun.id, "implement");

    expect(store.getSession(idle.id)).toMatchObject({ latestRunStatus: null, latestRunPhase: null });
    expect(store.getSession(active.id)).toMatchObject({ latestRunStatus: "running", latestRunPhase: "implement" });
    expect(store.listSessions().find((item) => item.id === active.id)).toMatchObject({ latestRunStatus: "running", latestRunPhase: "implement" });
  });

  it("persists, deduplicates, deletes, and atomically claims Session Supervisor inbox items", () => {
    const store = createStore();
    const session = store.createSession();
    const first = store.enqueueSessionInbox(session.id, "first", analysis("first"), "request-1");
    expect(store.enqueueSessionInbox(session.id, "duplicate body", analysis("duplicate body"), "request-1").id).toBe(first.id);
    const second = store.enqueueSessionInbox(session.id, "second", analysis("second"), "request-2");
    const third = store.enqueueSessionInbox(session.id, "third", analysis("third"), "request-3");
    expect(store.deleteSessionInboxItem(second.id, session.id)).toBe(true);
    expect(store.deleteSessionInboxItem(second.id, session.id)).toBe(false);
    const claimed = store.claimNextSessionInbox(session.id)!;
    expect(claimed.item).toMatchObject({ id: first.id, status: "started", decision: "start_taskrun", runId: claimed.run.id });
    expect(claimed.run.goal).toBe("first");
    expect(store.claimNextSessionInbox(session.id)).toBeUndefined();
    store.finalizeRun(claimed.run.id, "completed");
    expect(store.claimNextSessionInbox(session.id)?.item.id).toBe(third.id);
  });

  it("prioritizes analyzed inbox work and persists a TaskRun contract", () => {
    const store = createStore(); const session = store.createSession();
    const low = store.enqueueSessionInbox(session.id, "low work", analysis("Concise low goal", 100), "priority-low");
    const urgentAnalysis = { ...analysis("Critical correction", 950), urgency: "critical" as const, acceptanceCriteria: ["Do the critical work", "Verify it"] };
    const high = store.enqueueSessionInbox(session.id, "long raw critical input that should not become the goal", urgentAnalysis, "priority-high");
    expect(store.listSessionInbox(session.id).map((item) => item.id)).toEqual([high.id, low.id]);
    const claimed = store.claimNextSessionInbox(session.id)!;
    expect(claimed.item.id).toBe(high.id);
    expect(claimed.run.goal).toBe("Critical correction");
    expect(claimed.run.contract).toMatchObject({ sourceInput: "long raw critical input that should not become the goal", summary: "Critical correction", acceptanceCriteria: ["Do the critical work", "Verify it"], sourceInboxIds: [high.id] });
  });

  it("deduplicates equivalent pending analyzed work", () => {
    const store = createStore(); const session = store.createSession();
    const first = store.enqueueSessionInbox(session.id, "first wording", analysis("same canonical goal"), "dedupe-1");
    expect(store.findMergeCandidate(session.id, analysis("Same canonical goal"))?.id).toBe(first.id);
  });

  it("keeps a durable receipt when equivalent pending work is merged", () => {
    const store = createStore(); const session = store.createSession();
    const first = store.enqueueSessionInbox(session.id, "first wording", analysis("same canonical goal"), "dedupe-receipt-1");
    const source = store.enqueueSessionInbox(session.id, "second wording", analysis("same canonical goal"), "dedupe-receipt-2");
    expect(store.markSessionInboxDuplicate(source.id, first.id, session.id)).toMatchObject({ id: source.id, requestId: "dedupe-receipt-2", status: "deleted", decision: "merge", error: `Duplicate of ${first.id}` });
    expect(store.getSessionSubmission(session.id, "dedupe-receipt-2")?.id).toBe(source.id);
  });

  it("edits and reorders only queued Session inbox items", () => {
    const store = createStore();
    const session = store.createSession();
    const first = store.enqueueSessionInbox(session.id, "first", analysis("first"), "edit-first");
    const second = store.enqueueSessionInbox(session.id, "second", analysis("second"), "edit-second");
    const third = store.enqueueSessionInbox(session.id, "third", analysis("third"), "edit-third");

    expect(store.updateSessionInboxItem(second.id, session.id, "  changed second  ")).toMatchObject({ content: "changed second" });
    expect(store.updateSessionInboxItem(second.id, session.id, " ")).toBeUndefined();
    expect(store.reorderSessionInbox(session.id, [third.id, first.id, second.id])?.map((item) => [item.id, item.position])).toEqual([
      [third.id, 1], [first.id, 2], [second.id, 3],
    ]);
    expect(store.listSessionInbox(session.id).map((item) => item.id)).toEqual([third.id, first.id, second.id]);
    expect(store.reorderSessionInbox(session.id, [first.id, second.id])).toBeUndefined();

    expect(store.claimSessionInboxNow(third.id, session.id).status).toBe("started");
    expect(store.updateSessionInboxItem(third.id, session.id, "too late")).toBeUndefined();
  });

  it("keeps blocked Session input queued automatically but lets a user start a selected item", () => {
    const store = createStore();
    const session = store.createSession();
    const blocked = store.createRun(session.id, "blocked task");
    store.blockRun(blocked.id, "waiting for review");
    const first = store.enqueueSessionInbox(session.id, "first", analysis("first"), "manual-first");
    const second = store.enqueueSessionInbox(session.id, "second", analysis("second"), "manual-second");

    expect(store.claimNextSessionInbox(session.id)).toBeUndefined();
    const started = store.claimSessionInboxNow(second.id, session.id);
    expect(started).toMatchObject({ status: "started", item: { id: second.id, status: "started" }, run: { goal: "second", status: "running" } });
    expect(store.getRun(blocked.id)).toMatchObject({ status: "blocked", blockedReason: "waiting for review" });
    expect(store.getSessionInboxItem(first.id)).toMatchObject({ status: "queued", position: first.position });
  });

  it("rejects manual Session inbox start while another Run or continuation is active", () => {
    const store = createStore();
    const session = store.createSession();
    const queued = store.enqueueSessionInbox(session.id, "queued", analysis("queued"), "manual-conflict");
    const running = store.createRun(session.id, "running");
    expect(store.claimSessionInboxNow(queued.id, session.id)).toEqual({ status: "running", runId: running.id });
    store.finalizeRun(running.id, "completed");

    const blocked = store.createRun(session.id, "blocked");
    store.blockRun(blocked.id, "gate");
    const continuation = store.queueContinuation(blocked.id, "gate");
    expect(store.claimSessionInboxNow(queued.id, session.id)).toEqual({ status: "continuation", continuationId: continuation.id });
  });

  it("allows terminal Runs to stop blocking automatic Session inbox dispatch", () => {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const store = createStore();
      const session = store.createSession();
      const previous = store.createRun(session.id, status);
      store.finalizeRun(previous.id, status);
      const queued = store.enqueueSessionInbox(session.id, `after ${status}`, analysis(`after ${status}`), `after-${status}`);
      expect(store.claimNextSessionInbox(session.id)?.item.id).toBe(queued.id);
    }
  });

  it("allows only one manual claimant and does not reclaim a started item after reopen", async () => {
    const filename = path.join(mkdtempSync(path.join(tmpdir(), "tagent-manual-inbox-")), "store.db");
    const firstStore = new Store(filename); const secondStore = new Store(filename);
    stores.push(firstStore, secondStore);
    const session = firstStore.createSession();
    const blocked = firstStore.createRun(session.id, "blocked");
    firstStore.blockRun(blocked.id, "gate");
    const queued = firstStore.enqueueSessionInbox(session.id, "manual", analysis("manual"), "manual-race");
    const claims = await Promise.all([
      Promise.resolve().then(() => firstStore.claimSessionInboxNow(queued.id, session.id)),
      Promise.resolve().then(() => secondStore.claimSessionInboxNow(queued.id, session.id)),
    ]);
    expect(claims.filter((claim) => claim.status === "started")).toHaveLength(1);
    expect(firstStore.listRuns(session.id)).toHaveLength(2);
    firstStore.close(); secondStore.close();
    stores.splice(0);

    const reopened = new Store(filename); stores.push(reopened);
    expect(reopened.claimNextSessionInbox(session.id)).toBeUndefined();
    expect(reopened.listRuns(session.id)).toHaveLength(2);
    expect(reopened.getSessionInboxItem(queued.id)).toMatchObject({ status: "started", claimedAt: expect.any(Number), startedAt: expect.any(Number) });
  });

  it("does not start a blocked continuation while a manually selected Run is running", () => {
    const store = createStore();
    const session = store.createSession();
    const blocked = store.createRun(session.id, "blocked");
    store.blockRun(blocked.id, "gate");
    store.queueContinuation(blocked.id, "gate");
    store.db.prepare("UPDATE run_continuations SET status = 'cancelled' WHERE run_id = ?").run(blocked.id);
    const queued = store.enqueueSessionInbox(session.id, "manual", analysis("manual"), "manual-fence");
    expect(store.claimSessionInboxNow(queued.id, session.id).status).toBe("started");
    const continuation = store.queueContinuation(blocked.id, "new gate");
    expect(store.claimContinuation(blocked.id, "owner", 30_000)).toBeUndefined();
    expect(store.listContinuations(blocked.id).find((item) => item.id === continuation.id)?.status).toBe("queued");
  });

  it("allows only one Session inbox claimant across store connections", () => {
    const filename = path.join(mkdtempSync(path.join(tmpdir(), "tagent-inbox-claim-")), "store.db");
    const firstStore = new Store(filename); const secondStore = new Store(filename);
    stores.push(firstStore, secondStore);
    const session = firstStore.createSession();
    firstStore.enqueueSessionInbox(session.id, "one", analysis("one"), "claim-one");
    firstStore.enqueueSessionInbox(session.id, "two", analysis("two"), "claim-two");
    const first = firstStore.claimNextSessionInbox(session.id);
    const second = secondStore.claimNextSessionInbox(session.id);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(firstStore.listRuns(session.id)).toHaveLength(1);
    expect(firstStore.listSessionInbox(session.id)).toEqual([expect.objectContaining({ content: "two", status: "queued" })]);
  });

  it("does not let an older blocked Run keep the queue blocked after the latest Task succeeds", () => {
    const store = createStore();
    const session = store.createSession();
    const older = store.createRun(session.id, "older blocked work");
    store.blockRun(older.id, "waiting for review");
    const successful = store.createRun(session.id, "newer successful work");
    store.finalizeRun(successful.id, "completed");
    const queued = store.enqueueSessionInbox(session.id, "next task", analysis("next task"), "after-latest-success");

    expect(store.claimNextSessionInbox(session.id)?.item.id).toBe(queued.id);
    expect(store.getRun(older.id)).toMatchObject({ status: "blocked", blockedReason: "waiting for review" });
  });

  it("atomically retries the same inbox TaskRun after a retryable launch failure", () => {
    const filename = path.join(mkdtempSync(path.join(tmpdir(), "tagent-launch-retry-")), "store.db");
    const firstStore = new Store(filename); const secondStore = new Store(filename);
    stores.push(firstStore, secondStore);
    const session = firstStore.createSession();
    const item = firstStore.enqueueSessionInbox(session.id, "retry me", analysis("retry me"), "retry-me");
    const claimed = firstStore.claimNextSessionInbox(session.id)!;
    firstStore.recordSessionInboxLaunchFailure(item.id, claimed.run.id, "temporary initialization failure");
    firstStore.transitionRun(claimed.run.id, ["running"], "failed", "run.failed", { error: "temporary initialization failure", reason: "runtime_initialization_failed", stage: "runtime_initialize", retryable: true, inboxItemId: item.id }, "temporary initialization failure", 1);

    const results = [firstStore.retryInboxLaunch(claimed.run.id), secondStore.retryInboxLaunch(claimed.run.id)];
    expect(results.filter((result) => result.status === "started")).toHaveLength(1);
    expect(results.filter((result) => result.status === "not_retryable")).toHaveLength(1);
    expect(firstStore.listRuns(session.id)).toHaveLength(1);
    expect(firstStore.getRun(claimed.run.id)).toMatchObject({ id: claimed.run.id, status: "running", attempt: 2, launchRetryable: false });
    expect(firstStore.getSessionInboxItem(item.id)).toMatchObject({ status: "started", runId: claimed.run.id, error: "" });
  });

  it("reopens a committed launch retry as the same interrupted TaskRun", () => {
    const filename = path.join(mkdtempSync(path.join(tmpdir(), "tagent-launch-retry-restart-")), "store.db");
    const firstStore = new Store(filename);
    const session = firstStore.createSession();
    const item = firstStore.enqueueSessionInbox(session.id, "retry across restart", analysis("retry across restart"), "retry-restart");
    const claimed = firstStore.claimNextSessionInbox(session.id)!;
    firstStore.recordSessionInboxLaunchFailure(item.id, claimed.run.id, "init failed");
    firstStore.transitionRun(claimed.run.id, ["running"], "failed", "run.failed", { reason: "runtime_initialization_failed", retryable: true }, "init failed", 1);
    expect(firstStore.retryInboxLaunch(claimed.run.id).status).toBe("started");
    firstStore.close();

    const secondStore = new Store(filename); stores.push(secondStore);
    secondStore.markInterrupted();
    expect(secondStore.listRuns(session.id)).toHaveLength(1);
    expect(secondStore.getRun(claimed.run.id)).toMatchObject({ id: claimed.run.id, status: "interrupted", attempt: 2, launchRetryable: false });
    expect(secondStore.getSessionInboxItem(item.id)).toMatchObject({ status: "started", runId: claimed.run.id });
  });

  it("rejects launch retry while another TaskRun or continuation can execute", () => {
    const store = createStore();
    const session = store.createSession();
    const item = store.enqueueSessionInbox(session.id, "retry me", analysis("retry me"), "retry-conflict");
    const claimed = store.claimNextSessionInbox(session.id)!;
    store.recordSessionInboxLaunchFailure(item.id, claimed.run.id, "init failed");
    store.transitionRun(claimed.run.id, ["running"], "failed", "run.failed", { reason: "runtime_initialization_failed", retryable: true }, "init failed", 1);
    const running = store.createRun(session.id, "other");
    expect(store.retryInboxLaunch(claimed.run.id)).toMatchObject({ status: "running", runId: running.id });
    store.finalizeRun(running.id, "completed");
    const blocked = store.createRun(session.id, "blocked"); store.blockRun(blocked.id, "gate");
    const continuation = store.queueContinuation(blocked.id, "gate");
    expect(store.retryInboxLaunch(claimed.run.id)).toMatchObject({ status: "continuation", continuationId: continuation.id });
  });

  it("does not mark ordinary execution failures as launch-retryable", () => {
    const store = createStore();
    const session = store.createSession();
    const item = store.enqueueSessionInbox(session.id, "ordinary failure", analysis("ordinary failure"), "ordinary-failure");
    const claimed = store.claimNextSessionInbox(session.id)!;
    store.transitionRun(claimed.run.id, ["running"], "failed", "run.failed", { error: "tool failed" }, "tool failed", 1);
    expect(store.getRun(claimed.run.id)?.launchRetryable).toBe(false);
    expect(store.retryInboxLaunch(claimed.run.id).status).toBe("not_retryable");
    expect(store.getSessionInboxItem(item.id)?.status).toBe("started");
  });

  it("defers queued items and merges related input before TaskRun creation", () => {
    const store = createStore();
    const session = store.createSession();
    const first = store.enqueueSessionInbox(session.id, "primary", analysis("primary"), "merge-1");
    const second = store.enqueueSessionInbox(session.id, "detail", analysis("detail"), "merge-2");
    expect(store.decideSessionInboxItem(first.id, session.id, "defer")).toBe(true);
    expect(store.claimNextSessionInbox(session.id)?.item.id).toBe(second.id);
    store.finalizeRun(store.getActiveRun(session.id)!.id, "completed");
    expect(store.decideSessionInboxItem(first.id, session.id, "pending")).toBe(true);
    const third = store.enqueueSessionInbox(session.id, "extra", analysis("extra"), "merge-3");
    expect(store.mergeSessionInboxItems(third.id, first.id, session.id)).toBe(true);
    expect(store.getSessionInboxItem(first.id)?.content).toContain("Additional queued instruction:\nextra");
    expect(store.getSessionInboxItem(third.id)).toMatchObject({ status: "deleted", decision: "merge" });
  });

  it("keeps queued Session inbox input out of conversation history until selected", () => {
    const store = createStore();
    const session = store.createSession();
    store.appendMessage(session.id, "assistant", "history");
    store.enqueueSessionInbox(session.id, "future task", analysis("future task"), "future");
    expect(store.listMessages(session.id).map((item) => item.content)).toEqual(["history"]);
  });

  it("persists sessions and ordered messages", () => {
    const store = createStore();
    const session = store.createSession("Core work");
    store.appendMessage(session.id, "user", "hello");
    store.appendMessage(session.id, "assistant", "world");
    expect(store.listMessages(session.id).map((message) => message.content)).toEqual(["hello", "world"]);
  });

  it("pages older chat messages by stable id without overlap", () => {
    const store = createStore();
    const session = store.createSession("Long chat");
    for (let index = 1; index <= 205; index += 1) store.appendMessage(session.id, index % 2 ? "user" : "assistant", `message-${index}`);
    const latest = store.listMessages(session.id, 80);
    const older = store.listMessages(session.id, 80, latest[0].id);
    expect(latest).toHaveLength(80);
    expect(older).toHaveLength(80);
    expect(latest[0].content).toBe("message-126");
    expect(older[0].content).toBe("message-46");
    expect(older.at(-1)!.id).toBeLessThan(latest[0].id);
  });

  it("marks in-flight control delivery outcome unknown after restart", () => {
    const filename = path.join(mkdtempSync(path.join(tmpdir(), "tagent-store-")), "control-restart.db");
    const first = new Store(filename);
    const session = first.createSession();
    const run = first.createRun(session.id, "control restart");
    const admitted = first.enqueueControl(run.id, "request-1", "steer", "change", 4);
    expect(first.claimControlItem(run.id, 1)).toMatchObject({ id: admitted.item!.id, status: "delivering" });
    first.close();
    const second = new Store(filename);
    expect(second.getControlItem(admitted.item!.id)).toMatchObject({ status: "outcome_unknown", error: expect.stringContaining("outcome was unknown") });
    second.close();
  });

  it("persists, deduplicates, bounds, and attempt-fences control inbox items", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "control inbox");
    const first = store.enqueueControl(run.id, "request-1", "steer", "change", 1);
    expect(first).toMatchObject({ status: "accepted", item: { attempt: 1, status: "queued" } });
    expect(store.enqueueControl(run.id, "request-1", "steer", "change", 1)).toMatchObject({ status: "duplicate", item: { id: first.item!.id } });
    expect(store.enqueueControl(run.id, "request-2", "follow_up", "later", 1)).toEqual({ status: "full" });
    expect(store.claimControlItem(run.id, 1)).toMatchObject({ id: first.item!.id, status: "delivering" });
    expect(store.completeControlItem(first.item!.id, "delivered")).toBe(true);
    expect(store.listControlInbox(run.id)[0]).toMatchObject({ status: "delivered", completedAt: expect.any(Number) });

    const second = store.enqueueControl(run.id, "request-2", "follow_up", "later", 1);
    expect(second.status).toBe("accepted");
    store.db.prepare("UPDATE runs SET attempt = 2 WHERE id = ?").run(run.id);
    expect(store.claimControlItem(run.id, 2)).toBeUndefined();
    expect(store.getControlItem(second.item!.id)).toMatchObject({ status: "superseded" });
  });

  it("persists event consumer ACKs and fences stale generations", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "consumer ack");
    store.appendEvent(run.id, "message.delta", { delta: "a" });
    store.appendEvent(run.id, "run.completed", {});
    const first = store.claimEventConsumer(run.id, "web-client");
    expect(first).toMatchObject({ generation: 1, ackedSeq: 0 });
    expect(store.ackEventConsumer(run.id, "web-client", first.generation, 1)).toBe("accepted");
    const second = store.claimEventConsumer(run.id, "web-client");
    expect(second).toMatchObject({ generation: 2, ackedSeq: 1 });
    expect(store.ackEventConsumer(run.id, "web-client", first.generation, 2)).toBe("stale");
    expect(store.ackEventConsumer(run.id, "web-client", second.generation, 0)).toBe("invalid");
    expect(store.ackEventConsumer(run.id, "web-client", second.generation, 3)).toBe("invalid");
    expect(store.ackEventConsumer(run.id, "web-client", second.generation, 2)).toBe("accepted");
    expect(store.getEventConsumer(run.id, "web-client")).toMatchObject({ ackedSeq: 2, terminalAckedSeq: 2 });
  });

  it("does not renew an already expired continuation lease", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "expired renewal");
    store.blockRun(run.id, "gate");
    store.queueContinuation(run.id, "gate");
    const claimed = store.claimContinuation(run.id, "owner", 10_000)!;
    store.db.prepare("UPDATE run_continuations SET lease_until = ? WHERE id = ?").run(Date.now() - 1, claimed.continuation.id);
    expect(store.renewContinuationLease(claimed.continuation.id, "owner", 30_000)).toBe(false);
  });

  it("fences terminal Run transitions by attempt", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "attempt fence");
    store.blockRun(run.id, "gate");
    store.queueContinuation(run.id, "gate");
    const claimed = store.claimContinuation(run.id, "owner", 30_000)!;
    expect(claimed.run.attempt).toBe(2);
    expect(store.transitionRun(run.id, ["running"], "failed", "run.failed", { error: "late" }, "late", 1)).toBeUndefined();
    expect(store.getRun(run.id)).toMatchObject({ status: "running", attempt: 2 });
    expect(store.listEvents(run.id).map((event) => event.type)).toEqual(["continuation.started"]);
  });

  it("advances task phases from structured work without allowing regressions", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "phase progression");
    expect(store.getRun(run.id)?.phase).toBe("discover");
    store.upsertPlanItem(run.id, { key: "work", title: "Work", status: "pending", required: true, position: 1 });
    expect(store.getRun(run.id)?.phase).toBe("plan");
    store.upsertPlanItem(run.id, { key: "work", title: "Work", status: "in_progress", required: true, position: 1 });
    expect(store.getRun(run.id)?.phase).toBe("implement");
    store.upsertCheck(run.id, { key: "test", title: "Test", status: "running", required: true, command: "npm test", evidence: "", stale: false });
    expect(store.getRun(run.id)?.phase).toBe("verify");
    store.setRunPhase(run.id, "review");
    store.setRunPhase(run.id, "discover");
    expect(store.getRun(run.id)?.phase).toBe("review");
    store.close();
  });

  it("keeps phase progression monotonic across store connections", async () => {
    const filename = path.join(mkdtempSync(path.join(tmpdir(), "tagent-store-")), "phase-race.db");
    const first = new Store(filename);
    const second = new Store(filename);
    const session = first.createSession();
    const run = first.createRun(session.id, "phase race");
    await Promise.all([
      Promise.resolve().then(() => first.advanceRunPhase(run.id, "verify")),
      Promise.resolve().then(() => second.advanceRunPhase(run.id, "plan")),
    ]);
    expect(first.getRun(run.id)?.phase).toBe("verify");
    first.close();
    second.close();
  });

  it("repairs unpaired tool calls exactly once", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "repair");
    store.appendTranscript(run.id, 1, {
      role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "sleep 1" } }], api: "openai-completions", provider: "test", model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1,
    });
    expect(store.repairTranscript(run.id, "cancelled")).toEqual([{ toolCallId: "call-1", toolName: "bash" }]);
    expect(store.repairTranscript(run.id, "resume")).toEqual([]);
    expect(store.listTranscript(run.id).at(-1)).toMatchObject({ role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: true, details: { synthetic: true, reason: "cancelled" } });
  });

  it("only recovers queued or expired continuation leases after restart", () => {
    const store = createStore();
    const firstSession = store.createSession();
    const firstRun = store.createRun(firstSession.id, "expired");
    store.db.prepare("UPDATE runs SET status = 'blocked' WHERE id = ?").run(firstRun.id);
    store.queueContinuation(firstRun.id, "expired");
    const expired = store.claimContinuation(firstRun.id, "dead-owner", 1)!;
    store.db.prepare("UPDATE run_continuations SET lease_until = ? WHERE id = ?").run(100, expired.continuation.id);

    const secondSession = store.createSession();
    const secondRun = store.createRun(secondSession.id, "live");
    store.db.prepare("UPDATE runs SET status = 'blocked' WHERE id = ?").run(secondRun.id);
    store.queueContinuation(secondRun.id, "live");
    const live = store.claimContinuation(secondRun.id, "live-owner", 10_000)!;
    store.db.prepare("UPDATE run_continuations SET lease_until = ? WHERE id = ?").run(20_000, live.continuation.id);

    expect(store.recoverContinuationsAfterRestart(1_000).map((item) => item.id)).toEqual([expired.continuation.id]);
    expect(store.listContinuations(firstRun.id)[0]).toMatchObject({ status: "queued", leaseOwner: "", leaseUntil: null });
    expect(store.listContinuations(secondRun.id)[0]).toMatchObject({ status: "running", leaseOwner: "live-owner", leaseUntil: 20_000 });
    expect(store.getRun(secondRun.id)?.status).toBe("running");
  });

  it("releases only the stopping continuation owner's leases", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "release");
    store.db.prepare("UPDATE runs SET status = 'blocked' WHERE id = ?").run(run.id);
    store.queueContinuation(run.id, "release");
    const claimed = store.claimContinuation(run.id, "owner-a", 10_000)!;
    expect(store.releaseContinuationLeases("owner-b")).toEqual([]);
    expect(store.listContinuations(run.id)[0].status).toBe("running");
    expect(store.releaseContinuationLeases("owner-a")).toEqual([{ id: claimed.continuation.id, runId: run.id, ordinal: 1 }]);
    expect(store.listContinuations(run.id)[0]).toMatchObject({ status: "queued", leaseOwner: "" });
    expect(store.getRun(run.id)).toMatchObject({ status: "blocked", phase: "blocked" });
  });

  it("normalizes assistant text and paired tool calls for the Web transcript", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "transcript view");
    store.appendTranscript(run.id, 1, {
      role: "assistant", content: [{ type: "thinking", thinking: "Inspect the file before deciding." }, { type: "text", text: "Before" }, { type: "toolCall", id: "call-1", name: "read", arguments: { path: "a.txt" } }], api: "openai-completions", provider: "test", model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 1,
    });
    store.appendTranscript(run.id, 1, { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "file contents" }], details: {}, isError: false, timestamp: 2 });
    expect(store.listTranscriptView(run.id)).toEqual([
      expect.objectContaining({ kind: "thinking", text: "Inspect the file before deciding.", redacted: false }),
      expect.objectContaining({ kind: "assistant", text: "Before" }),
      expect.objectContaining({ kind: "tool", toolName: "read", arguments: { path: "a.txt" }, result: "file contents", status: "completed" }),
    ]);
  });

  it("renews and fences continuation leases by owner", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "lease fencing");
    store.blockRun(run.id, "gate");
    store.queueContinuation(run.id, "gate");
    const claimed = store.claimContinuation(run.id, "current-owner", 1_000)!;
    const initialLease = claimed.continuation.leaseUntil!;
    expect(store.renewContinuationLease(claimed.continuation.id, "old-owner", 60_000)).toBe(false);
    expect(store.renewContinuationLease(claimed.continuation.id, "current-owner", 60_000)).toBe(true);
    expect(store.listContinuations(run.id)[0].leaseUntil).toBeGreaterThan(initialLease);
    expect(store.updateContinuation(claimed.continuation.id, "completed", "", "old-owner")).toBe(false);
    expect(store.updateContinuation(claimed.continuation.id, "completed", "", "current-owner")).toBe(true);
    expect(store.listContinuations(run.id)[0]).toMatchObject({ status: "completed", leaseOwner: "", leaseUntil: null });
  });

  it("atomically claims one continuation across store connections", async () => {
    const filename = path.join(mkdtempSync(path.join(tmpdir(), "tagent-store-")), "continuation-claim.db");
    const firstStore = new Store(filename);
    const session = firstStore.createSession();
    const run = firstStore.createRun(session.id, "claim continuation");
    firstStore.blockRun(run.id, "gate");
    firstStore.queueContinuation(run.id, "gate");
    const secondStore = new Store(filename);
    const claims = await Promise.all([
      Promise.resolve().then(() => firstStore.claimContinuation(run.id, "worker-a", 30_000)),
      Promise.resolve().then(() => secondStore.claimContinuation(run.id, "worker-b", 30_000)),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(firstStore.getRun(run.id)).toMatchObject({ status: "running", attempt: 2, lastEventSeq: 1 });
    expect(firstStore.listContinuations(run.id)[0]).toMatchObject({ status: "running", leaseOwner: expect.stringMatching(/^worker-/), leaseUntil: expect.any(Number) });
    expect(firstStore.listEvents(run.id)).toHaveLength(1);
    firstStore.close();
    secondStore.close();
  });

  it("allows only one active continuation per run", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "single active continuation");
    store.blockRun(run.id, "gate");
    store.queueContinuation(run.id, "first");
    expect(() => store.queueContinuation(run.id, "second")).toThrow("active continuation");
  });

  it("returns the newest message window in chronological order", () => {
    const store = createStore();
    const session = store.createSession();
    for (let index = 0; index < 6; index += 1) store.appendMessage(session.id, "user", `message-${index}`);
    expect(store.listRecentMessages(session.id, 3).map((message) => message.content)).toEqual(["message-3", "message-4", "message-5"]);
  });

  it("allocates monotonic run event sequences", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "test");
    expect(store.appendEvent(run.id, "one", {}).seq).toBe(1);
    expect(store.appendEvent(run.id, "two", {}).seq).toBe(2);
  });

  it("blocks completion until required plan and checks pass", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "ship it");
    expect(store.completeWithGate(run.id, "done").gate.passed).toBe(false);
    store.resumeRun(run.id);
    store.upsertPlanItem(run.id, { key: "build", title: "Build", status: "done", required: true, position: 1 });
    store.upsertCheck(run.id, { key: "test", title: "Tests", status: "passed", required: true, command: "npm test", evidence: "ok", stale: false });
    const result = store.completeWithGate(run.id, "done");
    expect(result.gate.passed).toBe(true);
    expect(result.run.status).toBe("completed");
  });

  it("records the current schema version", () => {
    const store = createStore();
    expect(store.getSchemaVersion()).toBe(16);
  });

  it("migrates an older database to schema version 16", () => {
    const filename = path.join(mkdtempSync(path.join(tmpdir(), "tagent-store-")), "migration.db");
    const store = new Store(filename);
    store.db.exec("DROP TABLE run_checkpoints; DROP TABLE tool_attempts; DROP TABLE operations; UPDATE schema_meta SET version = 1 WHERE id = 1;");
    store.close();
    const migrated = new Store(filename);
    expect(migrated.getSchemaVersion()).toBe(16);
    expect((migrated.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('approval_requests','context_manifests','control_inbox','event_consumers','gate_evaluations','operations','progress_snapshots','run_checkpoints','session_supervisor_inbox','spawn_proposals','supervisor_decisions','taskrun_edges','tool_attempts') ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name)).toEqual(["approval_requests", "context_manifests", "control_inbox", "event_consumers", "gate_evaluations", "operations", "progress_snapshots", "run_checkpoints", "session_supervisor_inbox", "spawn_proposals", "supervisor_decisions", "taskrun_edges", "tool_attempts"]);
    migrated.close();
  });


  it("persists immutable per-attempt context manifests", () => {
    const store = createStore(); const session = store.createSession(); const run = store.createRun(session.id, "manifest");
    store.recordContextManifest({ id: "manifest-1", runId: run.id, attempt: 1, source: "session", items: [{ kind: "user_prompt", sourceId: "prompt-1", selected: true, reason: "current input", estimatedTokens: 10 }], stats: { keptTurns: 1 }, manifestHash: "abc", createdAt: 100 });
    expect(store.getLatestContextManifest(run.id)).toMatchObject({ id: "manifest-1", manifestHash: "abc", items: [{ sourceId: "prompt-1", selected: true }] });
    expect(store.getRun(run.id)?.supervision.latestContextManifest?.id).toBe("manifest-1");
  });
  it("persists and archives the latest Run checkpoint", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "checkpoint");
    store.upsertCheckpoint({ runId: run.id, attempt: 1, active: true, assistantPartial: "hello", currentTool: { toolCallId: "call-1", toolName: "read" }, lastEventSeq: 3, lastTranscriptSeq: 1 });
    expect(store.getRun(run.id)?.checkpoint).toMatchObject({ active: true, assistantPartial: "hello", currentTool: { toolName: "read" }, lastEventSeq: 3 });
    store.transitionRun(run.id, ["running"], "cancelled", "run.cancelled", {}, "cancelled", 1);
    expect(store.getCheckpoint(run.id)).toMatchObject({ active: false, assistantPartial: "hello", currentTool: null, lastEventSeq: 3 });
  });

  it("does not rewrite an unchanged checkpoint", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "checkpoint dedupe");
    const checkpoint = { runId: run.id, attempt: 1, active: true, assistantPartial: "same", currentTool: null, lastEventSeq: 2, lastTranscriptSeq: 1 };
    const first = store.upsertCheckpoint(checkpoint);
    const writesBefore = store.db.totalChanges;
    const second = store.upsertCheckpoint(checkpoint);
    expect(store.db.totalChanges).toBe(writesBefore);
    expect(second.updatedAt).toBe(first.updatedAt);
  });

  it("counts transcript messages without parsing their JSON bodies", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "transcript count");
    store.appendTranscript(run.id, 1, { role: "user", content: "one", timestamp: 1 });
    store.appendTranscript(run.id, 1, { role: "user", content: "two", timestamp: 2 });
    expect(store.getTranscriptCount(run.id)).toBe(2);
  });

  it("does not let an older attempt overwrite a newer checkpoint", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "checkpoint fence");
    store.upsertCheckpoint({ runId: run.id, attempt: 2, active: true, assistantPartial: "new", currentTool: null, lastEventSeq: 5, lastTranscriptSeq: 2 });
    store.upsertCheckpoint({ runId: run.id, attempt: 1, active: true, assistantPartial: "old", currentTool: null, lastEventSeq: 9, lastTranscriptSeq: 3 });
    expect(store.getCheckpoint(run.id)).toMatchObject({ attempt: 2, assistantPartial: "new", lastEventSeq: 5 });
  });

  it("cancels duplicate active continuations before creating the schema v3 unique index", () => {
    const filename = path.join(mkdtempSync(path.join(tmpdir(), "tagent-store-")), "continuation-migration.db");
    const store = new Store(filename);
    const session = store.createSession();
    const run = store.createRun(session.id, "migration duplicates");
    store.blockRun(run.id, "gate");
    store.db.exec("DROP INDEX idx_continuations_one_active");
    const insert = store.db.prepare("INSERT INTO run_continuations (id, run_id, ordinal, status, reason, created_at) VALUES (?, ?, ?, 'queued', 'gate', ?)");
    insert.run("first", run.id, 1, 1);
    insert.run("second", run.id, 2, 2);
    store.db.prepare("UPDATE schema_meta SET version = 2 WHERE id = 1").run();
    store.close();

    const migrated = new Store(filename);
    expect(migrated.listContinuations(run.id).map((item) => ({ id: item.id, status: item.status }))).toEqual([
      { id: "first", status: "queued" },
      { id: "second", status: "cancelled" },
    ]);
    migrated.close();
  });

  it("claims and replays operation receipts by canonical payload", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "operation");
    const first = store.claimOperation("op-1", run.id, 1, "tool.write", { path: "a", nested: { z: 1, a: 2 } });
    expect(first.claimed).toBe(true);
    store.updateOperation("op-1", { status: "succeeded", stage: "completed", result: { ok: true } });
    const replay = store.claimOperation("op-1", run.id, 1, "tool.write", { nested: { a: 2, z: 1 }, path: "a" });
    expect(replay).toMatchObject({ claimed: false, status: "succeeded", result: { ok: true } });
    expect(() => store.updateOperation("op-1", { status: "failed", error: "late" })).toThrow("cannot transition");
    expect(() => store.claimOperation("op-1", run.id, 1, "tool.write", { path: "b" })).toThrow("different payload");
  });

  it("allows only one operation claimant across store connections", async () => {
    const filename = path.join(mkdtempSync(path.join(tmpdir(), "tagent-store-")), "claim.db");
    const firstStore = new Store(filename);
    const session = firstStore.createSession();
    const run = firstStore.createRun(session.id, "claim race");
    const secondStore = new Store(filename);
    const claims = await Promise.all([
      Promise.resolve().then(() => firstStore.claimOperation("op-race", run.id, 1, "tool.write", { path: "a" }).claimed),
      Promise.resolve().then(() => secondStore.claimOperation("op-race", run.id, 1, "tool.write", { path: "a" }).claimed),
    ]);
    expect(claims.sort()).toEqual([false, true]);
    firstStore.close();
    secondStore.close();
  });

  it("marks unfinished operations outcome unknown after restart", () => {
    const filename = path.join(mkdtempSync(path.join(tmpdir(), "tagent-store-")), "restart.db");
    const store = new Store(filename);
    const session = store.createSession();
    const run = store.createRun(session.id, "operation restart");
    store.claimOperation("op-running", run.id, 1, "tool.bash", { command: "echo x" });
    store.updateOperation("op-running", { status: "running", stage: "executing" });
    store.close();
    const reopened = new Store(filename);
    expect(reopened.getOperation("op-running")).toMatchObject({ status: "outcome_unknown", stage: "service_restart" });
    reopened.close();
  });

  it("transitions terminal status and event atomically with compare-and-set", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "transition");
    const event = store.transitionRun(run.id, ["running"], "failed", "run.failed", { error: "x" }, "x");
    expect(event?.seq).toBe(1);
    expect(store.getRun(run.id)).toMatchObject({ status: "failed", blockedReason: "x", lastEventSeq: 1 });
    expect(store.transitionRun(run.id, ["running"], "cancelled", "run.cancelled", {})).toBeUndefined();
    expect(store.listEvents(run.id)).toHaveLength(1);
  });

  it("blocks repeated and repeatedly failing tool attempts", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "guard");
    for (let index = 1; index <= 5; index += 1) {
      const attempt = store.recordToolAttempt(run.id, 1, `call-${index}`, "read", { path: "same" });
      expect(attempt.guard.blocked).toBe(false);
      store.completeToolAttempt(run.id, 1, `call-${index}`, true);
    }
    expect(store.recordToolAttempt(run.id, 1, "call-6", "read", { path: "same" }).guard.blocked).toBe(true);

    const failureRun = store.createRun(session.id, "failure guard");
    for (let index = 1; index <= 3; index += 1) {
      store.recordToolAttempt(failureRun.id, 1, `fail-${index}`, "bash", { command: "false" });
      store.completeToolAttempt(failureRun.id, 1, `fail-${index}`, false, "failed");
    }
    expect(store.recordToolAttempt(failureRun.id, 1, "fail-4", "bash", { command: "false" }).guard.blocked).toBe(true);
  });

  it("persists continuation lifecycle records", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "continue");
    const continuation = store.queueContinuation(run.id, "missing check");
    expect(continuation).toMatchObject({ ordinal: 1, status: "queued", reason: "missing check" });
    store.updateContinuation(continuation.id, "running");
    store.updateContinuation(continuation.id, "completed");
    expect(store.listContinuations(run.id)[0]).toMatchObject({ status: "completed", startedAt: expect.any(Number), completedAt: expect.any(Number) });
    expect(store.getRun(run.id)?.continuations).toHaveLength(1);
  });

  it("requeues active continuations after restart", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "restart");
    store.blockRun(run.id, "gate");
    const continuation = store.queueContinuation(run.id, "gate");
    store.updateContinuation(continuation.id, "running");
    store.resumeRun(run.id);
    store.markInterrupted();
    expect(store.recoverContinuationsAfterRestart()).toEqual([{ id: continuation.id, runId: run.id, ordinal: 1 }]);
    expect(store.getRun(run.id)).toMatchObject({ status: "blocked", blockedReason: "Continuation recovered after service restart" });
    expect(store.listContinuations(run.id)[0]).toMatchObject({ status: "queued", error: "Recovered after lease expiry", startedAt: null });
  });

  it("returns the latest terminal run for a session", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "latest");
    store.finalizeRun(run.id, "completed");
    expect(store.getLatestRun(session.id)?.id).toBe(run.id);
    expect(store.getActiveRun(session.id)).toBeUndefined();
  });

  it("persists transcript messages and aggregates assistant usage", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "usage");
    store.appendTranscript(run.id, 1, { role: "user", content: "hello", timestamp: 1 });
    store.appendTranscript(run.id, 1, {
      role: "assistant", content: [{ type: "text", text: "world" }], api: "openai-completions", provider: "test", model: "test",
      usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: { input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0.02, total: 0.33 } },
      stopReason: "stop", timestamp: 2,
    });
    expect(store.listTranscript(run.id).map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(store.getRun(run.id)).toMatchObject({ transcriptCount: 2, usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: 0.33 } });
  });

  it("tracks resume attempts on the same run", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "resume", "stable");
    store.blockRun(run.id, "gate");
    const resumed = store.resumeRun(run.id);
    expect(resumed.id).toBe(run.id);
    expect(resumed.requestId).toBe("stable");
    expect(resumed.attempt).toBe(2);
    expect(resumed.resumedAt).toBeTypeOf("number");
  });

  it("rejects stale verification evidence", () => {
    const store = createStore();
    const session = store.createSession();
    const run = store.createRun(session.id, "test stale");
    store.upsertPlanItem(run.id, { key: "build", title: "Build", status: "done", required: true, position: 1 });
    store.upsertCheck(run.id, { key: "test", title: "Tests", status: "passed", required: true, command: "npm test", evidence: "old", stale: true });
    expect(store.getRun(run.id)?.completionGate.failures[0]?.reason).toBe("Evidence is stale");
  });
  it("returns the newest message window in chronological order", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    for (let index = 1; index <= 205; index += 1) store.appendMessage(session.id, "user", `message-${index}`);
    const messages = store.listMessages(session.id, 200);
    expect(messages).toHaveLength(200);
    expect(messages[0].content).toBe("message-6");
    expect(messages.at(-1)?.content).toBe("message-205");
    store.close();
  });

});
