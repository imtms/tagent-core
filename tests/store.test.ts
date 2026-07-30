import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store/store.js";

const stores: Store[] = [];
const createStore = () => {
  const store = new Store(":memory:");
  stores.push(store);
  return store;
};
afterEach(() => stores.splice(0).forEach((store) => store.close()));

describe("Store", () => {
  it("persists sessions and ordered messages", () => {
    const store = createStore();
    const session = store.createSession("Core work");
    store.appendMessage(session.id, "user", "hello");
    store.appendMessage(session.id, "assistant", "world");
    expect(store.listMessages(session.id).map((message) => message.content)).toEqual(["hello", "world"]);
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
    expect(store.getSchemaVersion()).toBe(3);
  });

  it("migrates an older database to schema version 3", () => {
    const filename = path.join(mkdtempSync(path.join(tmpdir(), "tagent-store-")), "migration.db");
    const store = new Store(filename);
    store.db.exec("DROP TABLE tool_attempts; DROP TABLE operations; UPDATE schema_meta SET version = 1 WHERE id = 1;");
    store.close();
    const migrated = new Store(filename);
    expect(migrated.getSchemaVersion()).toBe(3);
    expect((migrated.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('operations', 'tool_attempts') ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name)).toEqual(["operations", "tool_attempts"]);
    migrated.close();
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
    expect(store.listContinuations(run.id)[0]).toMatchObject({ status: "queued", error: "Recovered after service restart", startedAt: null });
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
});
