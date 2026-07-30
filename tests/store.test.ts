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
