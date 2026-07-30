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
    expect(store.getSchemaVersion()).toBe(1);
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
