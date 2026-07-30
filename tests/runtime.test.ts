import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { AgentService } from "../src/core/agent-service.js";
import { Store } from "../src/store/store.js";
import type { AgentRuntime, RuntimeFactory } from "../src/runtime/types.js";

function assistantMessage(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
}

class CheckpointRuntime implements AgentRuntime {
  private resolvePrompt?: () => void;
  constructor(private readonly options: Parameters<RuntimeFactory>[0]) {}
  prompt() { return new Promise<void>((resolve) => { this.resolvePrompt = resolve; }); }
  async steer() {}
  abort() { this.resolvePrompt?.(); }
  getMessages() { return []; }
  getError() { return undefined; }
  emit(type: string, data: Record<string, unknown>) {
    const event = this.options.store.appendEvent(this.options.runId, type, data);
    this.options.onEvent?.(event);
    return event;
  }
}

class ControlledRuntime implements AgentRuntime {
  private resolvePrompt?: () => void;
  private rejectPrompt?: (error: Error) => void;
  constructor(private readonly messages: AgentMessage[]) {}
  prompt() { return new Promise<void>((resolve, reject) => { this.resolvePrompt = resolve; this.rejectPrompt = reject; }); }
  async steer() {}
  abort() {}
  resolve() { this.resolvePrompt?.(); }
  reject(error: Error) { this.rejectPrompt?.(error); }
  getMessages() { return this.messages; }
  getError() { return undefined; }
}

class FakeRuntime implements AgentRuntime {
  aborted = false;
  steered: string[] = [];
  prompts: string[] = [];
  constructor(private readonly messages: AgentMessage[]) {}
  async prompt(query: string) { this.prompts.push(query); }
  async steer(instruction: string) { this.steered.push(instruction); }
  abort() { this.aborted = true; }
  getMessages() { return this.messages; }
  getError() { return undefined; }
}

class CallbackRuntime implements AgentRuntime {
  prompts: string[] = [];
  constructor(private readonly message: AgentMessage, private readonly onPrompt: (query: string) => void = () => {}) {}
  async prompt(query: string) { this.prompts.push(query); this.onPrompt(query); }
  async steer() {}
  abort() {}
  getMessages() { return [this.message]; }
  getError() { return undefined; }
}

class DeferredRuntime implements AgentRuntime {
  aborted = false;
  private rejectPrompt?: (error: Error) => void;
  prompt() { return new Promise<void>((_resolve, reject) => { this.rejectPrompt = reject; }); }
  async steer() {}
  abort() { this.aborted = true; this.rejectPrompt?.(new Error("aborted")); }
  getMessages() { return []; }
  getError() { return undefined; }
}

class RejectingAbortRuntime extends DeferredRuntime {
  override async abort() {
    super.abort();
    throw new Error("abort cleanup failed");
  }
}

class SlowAbortRuntime extends DeferredRuntime {
  settled = false;
  override async abort() {
    await new Promise((resolve) => setTimeout(resolve, 20));
    super.abort();
    this.settled = true;
  }
}

class ActiveDeferredRuntime extends DeferredRuntime {
  constructor(private readonly emitActivity: () => void, private readonly intervalMs: number) { super(); }
  private timer?: ReturnType<typeof setInterval>;
  override prompt() {
    this.timer = setInterval(this.emitActivity, this.intervalMs);
    return super.prompt().finally(() => { if (this.timer) clearInterval(this.timer); });
  }
  override abort() { if (this.timer) clearInterval(this.timer); super.abort(); }
}

describe("AgentService runtime boundary", () => {
  it("throttles partial checkpoints and persists tool boundaries immediately", async () => {
    const store = new Store(":memory:");
    const writes = vi.spyOn(store, "upsertCheckpoint");
    const session = store.createSession();
    let runtime!: CheckpointRuntime;
    const service = new AgentService(store, "/tmp", (options) => runtime = new CheckpointRuntime(options));
    const run = await service.start(session.id, "checkpoint stream");
    expect(writes).toHaveBeenCalledTimes(1);
    runtime.emit("message.delta", { delta: "A" });
    runtime.emit("message.delta", { delta: "B" });
    expect(store.getCheckpoint(run.id)).toMatchObject({ active: true, assistantPartial: "", lastEventSeq: 2 });
    expect(writes).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(store.getCheckpoint(run.id)).toMatchObject({ assistantPartial: "AB", lastEventSeq: 4 });
    expect(writes).toHaveBeenCalledTimes(2);
    runtime.emit("tool.started", { toolCallId: "call-1", toolName: "read", args: { path: "a" } });
    expect(store.getCheckpoint(run.id)?.currentTool).toMatchObject({ toolCallId: "call-1", toolName: "read" });
    expect(writes).toHaveBeenCalledTimes(3);
    runtime.emit("tool.completed", { toolCallId: "call-1", toolName: "read", isError: false });
    expect(store.getCheckpoint(run.id)?.currentTool).toBeNull();
    expect(writes).toHaveBeenCalledTimes(4);
    await service.closeRuntimes();
    expect(store.getCheckpoint(run.id)?.active).toBe(false);
    store.close();
  });

  it("preserves partial progress across restart and resets it for resume", async () => {
    const directory = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp("/tmp/tagent-checkpoint-restart-"));
    const filename = `${directory}/tagent.db`;
    const firstStore = new Store(filename);
    const session = firstStore.createSession();
    const run = firstStore.createRun(session.id, "restart checkpoint");
    firstStore.upsertCheckpoint({ runId: run.id, attempt: 1, active: true, assistantPartial: "partial answer", currentTool: { toolCallId: "call-1", toolName: "bash" }, lastEventSeq: 7, lastTranscriptSeq: 2 });
    firstStore.close();

    const secondStore = new Store(filename);
    const service = new AgentService(secondStore, "/tmp", () => new DeferredRuntime());
    expect(secondStore.getRun(run.id)).toMatchObject({ status: "interrupted", checkpoint: { active: false, assistantPartial: "partial answer", currentTool: null, attempt: 1 } });
    const resumed = service.resume(run.id);
    expect(resumed).toMatchObject({ status: "running", attempt: 2, checkpoint: { active: true, assistantPartial: "", currentTool: null, attempt: 2 } });
    await service.closeRuntimes();
    secondStore.close();
  });

  it("constructs agents through the injected runtime factory", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const runtime = new FakeRuntime([assistantMessage("done")]);
    const factory: RuntimeFactory = vi.fn(() => runtime);
    const service = new AgentService(store, "/tmp", factory, { maxContinuations: 0 });
    const run = await service.start(session.id, "test factory");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(factory).toHaveBeenCalledOnce();
    expect(runtime.prompts).toEqual(["test factory"]);
    expect(store.getRun(run.id)?.status).toBe("blocked");
    store.close();
  });

  it("does not let an expired continuation owner complete the Run", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "expired owner completion");
    store.blockRun(run.id, "gate");
    store.queueContinuation(run.id, "gate");
    let oldRuntime!: ControlledRuntime;
    let calls = 0;
    const service = new AgentService(store, "/tmp", () => {
      calls += 1;
      if (calls === 1) return oldRuntime = new ControlledRuntime([assistantMessage("late")]);
      return new CallbackRuntime(assistantMessage("new owner"), () => {
        store.upsertPlanItem(run.id, { key: "recover", title: "Recover", status: "done", required: true, position: 1 });
      });
    }, { maxContinuations: 1 });
    service.recoverContinuations();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const active = store.listContinuations(run.id)[0];
    store.db.prepare("UPDATE run_continuations SET lease_until = ? WHERE id = ?").run(Date.now() - 1, active.id);
    oldRuntime.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toBe(2);
    expect(store.getRun(run.id)).toMatchObject({ status: "completed", attempt: 3 });
    expect(store.listEvents(run.id).filter((event) => event.type === "run.completed")).toHaveLength(1);
    await service.closeRuntimes();
    store.close();
  });

  it("schedules recovery when a previous owner's continuation lease expires", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "delayed lease recovery");
    store.blockRun(run.id, "plan missing");
    store.queueContinuation(run.id, "plan missing");
    const old = store.claimContinuation(run.id, "dead-owner", 30_000)!;
    store.db.prepare("UPDATE run_continuations SET lease_until = ? WHERE id = ?").run(Date.now() + 25, old.continuation.id);
    let calls = 0;
    const service = new AgentService(store, "/tmp", () => new CallbackRuntime(assistantMessage("recovered"), () => {
      calls += 1;
      store.upsertPlanItem(run.id, { key: "recover", title: "Recover", status: "done", required: true, position: 1 });
    }), { maxContinuations: 1 });
    expect(service.recoverContinuations()).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(calls).toBe(1);
    expect(store.getRun(run.id)).toMatchObject({ status: "completed", attempt: 3 });
    expect(store.listEvents(run.id).some((event) => event.type === "continuation.recovered")).toBe(true);
    await service.closeRuntimes();
    store.close();
  });

  it("waits for asynchronous runtime aborts before closing", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const runtime = new SlowAbortRuntime();
    const service = new AgentService(store, "/tmp", () => runtime);
    await service.start(session.id, "graceful close");
    const closing = service.closeRuntimes();
    expect(runtime.settled).toBe(false);
    await closing;
    expect(runtime.settled).toBe(true);
    expect(store.getRun((store.listRuns(session.id)[0]).id)?.status).toBe("interrupted");
    store.close();
  });

  it("releases a continuation lease instead of failing it during graceful close", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "close continuation");
    store.blockRun(run.id, "gate");
    store.queueContinuation(run.id, "gate");
    const runtime = new SlowAbortRuntime();
    const service = new AgentService(store, "/tmp", () => runtime);
    service.recoverContinuations();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.listContinuations(run.id)[0].status).toBe("running");
    await service.closeRuntimes();
    expect(store.listContinuations(run.id)[0]).toMatchObject({ status: "queued", leaseOwner: "" });
    expect(store.getRun(run.id)).toMatchObject({ status: "blocked", phase: "blocked" });
    store.close();
  });

  it("audits an asynchronous runtime abort failure without changing cancelled state", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const runtime = new RejectingAbortRuntime();
    const service = new AgentService(store, "/tmp", () => runtime);
    const run = await service.start(session.id, "async abort failure");
    expect(service.cancel(run.id)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getRun(run.id)?.status).toBe("cancelled");
    expect(store.listEvents(run.id).some((event) => event.type === "runtime.abort.failed" && event.data.error === "abort cleanup failed")).toBe(true);
    store.close();
  });

  it("loads the newest session window when history exceeds the store limit", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const insert = store.db.prepare("INSERT INTO messages (session_id, role, content, created_at) VALUES (?, 'user', ?, ?)");
    const batch = store.db.transaction(() => {
      for (let index = 0; index < 10_002; index += 1) insert.run(session.id, `message-${index}`, index);
    });
    batch();
    let options: Parameters<RuntimeFactory>[0] | undefined;
    const service = new AgentService(store, "/tmp", (value) => { options = value; return new FakeRuntime([assistantMessage("done")]); }, { maxContinuations: 0, maxContextTurns: 2 });
    await service.start(session.id, "latest?");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(options?.initialMessages?.at(-1)).toMatchObject({ role: "user", content: "message-10001" });
    expect(JSON.stringify(options?.initialMessages)).not.toContain("message-0\"");
    store.close();
  });

  it("loads session history after reopening the persistent store", async () => {
    const directory = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp("/tmp/tagent-session-history-"));
    const filename = `${directory}/tagent.db`;
    const firstStore = new Store(filename);
    const session = firstStore.createSession();
    firstStore.appendMessage(session.id, "user", "Persistent fact: release channel is stable");
    firstStore.appendMessage(session.id, "assistant", "The release channel is stable.");
    firstStore.close();

    const secondStore = new Store(filename);
    let options: Parameters<RuntimeFactory>[0] | undefined;
    const service = new AgentService(secondStore, "/tmp", (value) => { options = value; return new FakeRuntime([assistantMessage("stable")]); }, { maxContinuations: 0 });
    await service.start(session.id, "Which release channel did we choose?");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(options?.initialMessages?.[0]).toMatchObject({ role: "user", content: "Persistent fact: release channel is stable" });
    expect(options?.initialMessages?.[1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "The release channel is stable." }] });
    secondStore.close();
  });

  it("loads prior session messages into a new run without duplicating the current query", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    store.appendMessage(session.id, "user", "Remember project codename Atlas");
    store.appendMessage(session.id, "assistant", "The project codename is Atlas.");
    let options: Parameters<RuntimeFactory>[0] | undefined;
    const runtime = new FakeRuntime([assistantMessage("Atlas")]);
    const service = new AgentService(store, "/tmp", (value) => { options = value; return runtime; }, { maxContinuations: 0 });

    const run = await service.start(session.id, "What is the project codename?");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(options?.initialMessages?.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(options?.initialMessages?.[0]).toMatchObject({ role: "user", content: "Remember project codename Atlas" });
    expect(options?.initialMessages?.[1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "The project codename is Atlas." }] });
    expect(runtime.prompts).toEqual(["What is the project codename?"]);
    expect(JSON.stringify(options?.initialMessages)).not.toContain("What is the project codename?");
    expect(store.listEvents(run.id).some((event) => event.type === "context.loaded"
      && event.data.source === "session"
      && event.data.keptMessages === 2
      && typeof event.data.systemTokens === "number"
      && typeof event.data.promptTokens === "number"
      && typeof event.data.outputReserveTokens === "number"
      && typeof event.data.safetyReserveTokens === "number"
      && typeof event.data.messageBudgetTokens === "number")).toBe(true);
    store.close();
  });

  it("prunes session history by complete turns for a new run", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    store.appendMessage(session.id, "user", `old-${"A".repeat(12_000)}`);
    store.appendMessage(session.id, "assistant", `old-${"B".repeat(12_000)}`);
    store.appendMessage(session.id, "user", "latest user fact");
    store.appendMessage(session.id, "assistant", "latest assistant answer");
    let options: Parameters<RuntimeFactory>[0] | undefined;
    const service = new AgentService(store, "/tmp", (value) => { options = value; return new FakeRuntime([assistantMessage("done")]); }, { maxContinuations: 0, contextWindow: 2_000, contextReserveTokens: 200, model: { contextWindow: 2_000, maxTokens: 200 } as never });

    const run = await service.start(session.id, "follow up");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(options?.initialMessages?.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(options?.initialMessages?.[0]).toMatchObject({ content: "latest user fact" });
    expect(store.listEvents(run.id).some((event) => event.type === "context.pruned" && event.data.source === "session" && event.data.originalMessages === 4 && event.data.keptMessages === 2)).toBe(true);
    store.close();
  });

  it("resumes the same durable run through a new runtime attempt", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const first = new FakeRuntime([assistantMessage("needs plan")]);
    const second = new FakeRuntime([assistantMessage("still gated")]);
    const options: Array<Parameters<RuntimeFactory>[0]> = [];
    const factory = vi.fn<RuntimeFactory>((runtimeOptions) => {
      options.push(runtimeOptions);
      return options.length === 1 ? first : second;
    });
    const service = new AgentService(store, "/tmp", factory, { maxContinuations: 0 });
    const started = await service.start(session.id, "resume goal", "stable-request");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getRun(started.id)?.status).toBe("blocked");

    const resumed = service.resume(started.id);
    expect(resumed.id).toBe(started.id);
    expect(resumed.requestId).toBe("stable-request");
    expect(resumed.attempt).toBe(2);
    expect(resumed.resumedAt).toBeTypeOf("number");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(factory).toHaveBeenCalledTimes(2);
    expect(options[1].initialMessages).toEqual([]);
    expect(second.prompts[0]).toContain("Resume this interrupted or blocked TaskRun");
    expect(second.prompts[0]).toContain("Completion-gate requirements override conflicting instructions");
    expect(second.prompts[0]).toContain("resume goal");
    expect(store.listMessages(session.id).filter((message) => message.role === "user")).toHaveLength(1);
    expect(store.listEvents(started.id).some((event) => event.type === "run.resumed" && event.data.attempt === 2)).toBe(true);
    store.close();
  });

  it("loads persisted transcript into a resumed runtime", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "continue context", "transcript-request");
    const user = { role: "user", content: "remember alpha", timestamp: 1 } as const;
    const assistant = assistantMessage("alpha remembered");
    store.appendTranscript(run.id, 1, user);
    store.appendTranscript(run.id, 1, assistant);
    store.blockRun(run.id, "gate");
    let options: Parameters<RuntimeFactory>[0] | undefined;
    const runtime = new FakeRuntime([assistantMessage("done")]);
    const service = new AgentService(store, "/tmp", (value) => { options = value; return runtime; });
    service.resume(run.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(options?.initialMessages).toEqual([user, assistant]);
    expect(runtime.prompts[0]).toContain("persisted pi transcript messages");
    expect(store.listEvents(run.id).find((event) => event.type === "run.resumed")?.data).toMatchObject({ mode: "transcript-continuation", transcriptCount: 2 });
    store.close();
  });

  it("recovers and completes a persisted continuation after restart", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "restart continuation");
    store.blockRun(run.id, "plan missing");
    const continuation = store.queueContinuation(run.id, "plan missing");
    store.updateContinuation(continuation.id, "running");
    store.resumeRun(run.id);
    const service = new AgentService(store, "/tmp", () => new CallbackRuntime(assistantMessage("recovered"), () => {
      store.upsertPlanItem(run.id, { key: "recover", title: "Recover", status: "done", required: true, position: 1 });
    }), { maxContinuations: 2, maxRunTokens: 1000 });
    expect(service.recoverContinuations()).toEqual([run.id]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getRun(run.id)).toMatchObject({ status: "completed", attempt: 3 });
    expect(store.listContinuations(run.id)[0]).toMatchObject({ status: "completed", error: "" });
    expect(store.listEvents(run.id).some((event) => event.type === "continuation.recovered")).toBe(true);
    store.close();
  });

  it("prunes old transcript turns before resume", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "prune context");
    const oldUser = { role: "user", content: "A".repeat(2400), timestamp: 1 } as const;
    const oldAssistant = assistantMessage("B".repeat(2400));
    const newUser = { role: "user", content: "latest", timestamp: 3 } as const;
    const newAssistant = assistantMessage("latest answer");
    for (const message of [oldUser, oldAssistant, newUser, newAssistant]) store.appendTranscript(run.id, 1, message);
    store.blockRun(run.id, "gate");
    let options: Parameters<RuntimeFactory>[0] | undefined;
    const service = new AgentService(store, "/tmp", (value) => { options = value; return new FakeRuntime([assistantMessage("done")]); }, { maxContinuations: 0, contextWindow: 1_000, contextReserveTokens: 100, model: { contextWindow: 1_000, maxTokens: 100 } as never });
    service.resume(run.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(options?.initialMessages).toEqual([newUser, newAssistant]);
    expect(store.listEvents(run.id).some((event) => event.type === "context.pruned" && event.data.source === "transcript" && event.data.originalMessages === 4 && event.data.keptMessages === 2)).toBe(true);
    store.close();
  });

  it("assigns dynamic budgets by task complexity and respects hard limits", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const service = new AgentService(store, "/tmp", () => new FakeRuntime([]), { maxContinuations: 40, maxRunTokens: 700_000, runTimeoutMs: 3_000_000 });
    const simple = store.createRun(session.id, "Say hello");
    expect(service.getBudget(simple.id)).toEqual({ tier: "simple", maxContinuations: 4, maxTokens: 80_000, runTimeoutMs: 300_000 });
    const complex = store.createRun(session.id, "Implement and test a multi module frontend backend database migration architecture");
    for (let index = 0; index < 8; index += 1) store.upsertPlanItem(complex.id, { key: `p${index}`, title: `Step ${index}`, status: "pending", required: true, position: index });
    for (let index = 0; index < 3; index += 1) store.upsertCheck(complex.id, { key: `c${index}`, title: `Check ${index}`, status: "pending", required: true, command: "", evidence: "", stale: false });
    expect(service.getBudget(complex.id)).toEqual({ tier: "extended", maxContinuations: 40, maxTokens: 700_000, runTimeoutMs: 3_000_000 });
    store.close();
  });

  it("automatically continues a gate-blocked run and completes it", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let runId = "";
    let calls = 0;
    const runtimes: CallbackRuntime[] = [];
    const service = new AgentService(store, "/tmp", () => {
      calls += 1;
      const runtime = new CallbackRuntime(assistantMessage(calls === 1 ? "blocked" : "done"), () => {
        if (calls === 2) {
          store.upsertPlanItem(runId, { key: "work", title: "Finish work", status: "done", required: true, position: 1 });
          store.upsertCheck(runId, { key: "verify", title: "Verify work", status: "passed", required: true, command: "test", evidence: "passed", stale: false });
        }
      });
      runtimes.push(runtime);
      return runtime;
    }, { maxContinuations: 2, maxRunTokens: 1000 });
    const run = await service.start(session.id, "auto continue");
    runId = run.id;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(2);
    expect(store.getRun(run.id)).toMatchObject({ status: "completed", attempt: 2 });
    expect(store.listContinuations(run.id)[0]).toMatchObject({ ordinal: 1, status: "completed" });
    expect(store.listMessages(session.id).filter((message) => message.role === "assistant").map((message) => message.content)).toEqual(["done"]);
    expect(runtimes[1].prompts[0]).toContain("Automatic continuation 1");
    store.close();
  });

  it("sustains dozens of continuations in one durable run", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let runId = "";
    let calls = 0;
    const service = new AgentService(store, "/tmp", () => {
      calls += 1;
      return new CallbackRuntime(assistantMessage(calls > 40 ? "done" : "continue"), () => {
        if (calls > 40) store.upsertPlanItem(runId, { key: "finish", title: "Finish", status: "done", required: true, position: 1 });
      });
    }, { dynamicBudget: false, maxContinuations: 64, maxRunTokens: 1_000_000, runTimeoutMs: 60_000 });
    const run = await service.start(session.id, "long durable run");
    runId = run.id;
    for (let index = 0; index < 200 && store.getRun(run.id)?.status !== "completed"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(calls).toBe(41);
    expect(store.getRun(run.id)).toMatchObject({ status: "completed", attempt: 41 });
    expect(store.listContinuations(run.id)).toHaveLength(40);
    expect(store.listContinuations(run.id).every((item) => item.status === "completed" || item.status === "blocked")).toBe(true);
    store.close();
  });

  it("stops automatic continuation after the configured limit", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let calls = 0;
    const service = new AgentService(store, "/tmp", () => { calls += 1; return new CallbackRuntime(assistantMessage("blocked")); }, { maxContinuations: 1, maxRunTokens: 1000 });
    const run = await service.start(session.id, "stay blocked");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(2);
    expect(store.getRun(run.id)?.status).toBe("blocked");
    expect(store.listContinuations(run.id)).toHaveLength(1);
    expect(store.listEvents(run.id).some((event) => event.type === "continuation.exhausted" && event.data.reason === "max_continuations")).toBe(true);
    store.close();
  });

  it("does not queue continuation when the token budget is exhausted", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const costly = assistantMessage("blocked");
    if (costly.role === "assistant") costly.usage.totalTokens = 10;
    const service = new AgentService(store, "/tmp", () => new CallbackRuntime(costly), { maxContinuations: 2, maxRunTokens: 10 });
    const run = await service.start(session.id, "token budget");
    store.appendTranscript(run.id, 1, costly);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.listContinuations(run.id)).toHaveLength(0);
    expect(store.listEvents(run.id).some((event) => event.type === "continuation.exhausted" && event.data.reason === "token_budget")).toBe(true);
    store.close();
  });

  it("fails a run only after its idle watchdog sees no progress", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const runtime = new DeferredRuntime();
    const service = new AgentService(store, "/tmp", () => runtime, { runTimeoutMs: 10, runHardTimeoutMs: 1_000, dynamicBudget: false });
    const run = await service.start(session.id, "timeout");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runtime.aborted).toBe(true);
    expect(store.getRun(run.id)).toMatchObject({ status: "failed", blockedReason: "Run idle for 10ms without progress" });
    expect(store.listEvents(run.id).at(-1)?.data).toMatchObject({ reason: "idle_timeout", limitMs: 10 });
    store.close();
  });

  it("refreshes the idle watchdog while the runtime keeps making progress", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let runtime!: ActiveDeferredRuntime;
    let activityCount = 0;
    const service = new AgentService(store, "/tmp", (options) => {
      runtime = new ActiveDeferredRuntime(() => { activityCount += 1; options.onActivity?.(); }, 5);
      return runtime;
    }, { runTimeoutMs: 40, runHardTimeoutMs: 1_000, dynamicBudget: false });
    const run = await service.start(session.id, "active long run");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runtime.aborted).toBe(false);
    expect(store.getRun(run.id)?.status).toBe("running");
    expect(activityCount).toBeGreaterThan(5);
    service.cancel(run.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    store.close();
  });

  it("enforces the absolute hard timeout even when progress continues", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let runtime!: ActiveDeferredRuntime;
    const service = new AgentService(store, "/tmp", (options) => {
      runtime = new ActiveDeferredRuntime(() => options.onActivity?.(), 5);
      return runtime;
    }, { runTimeoutMs: 40, runHardTimeoutMs: 70, dynamicBudget: false });
    const run = await service.start(session.id, "hard timeout");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runtime.aborted).toBe(true);
    expect(store.getRun(run.id)).toMatchObject({ status: "failed", blockedReason: "Run exceeded 70ms absolute hard timeout" });
    expect(store.listEvents(run.id).at(-1)?.data).toMatchObject({ reason: "hard_timeout", limitMs: 70 });
    store.close();
  });

  it("does not let a late abort failure overwrite cancelled state", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const runtime = new DeferredRuntime();
    const service = new AgentService(store, "/tmp", () => runtime);
    const run = await service.start(session.id, "cancel race");
    expect(service.cancel(run.id)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtime.aborted).toBe(true);
    expect(store.getRun(run.id)?.status).toBe("cancelled");
    expect(store.listEvents(run.id).at(-1)?.type).toBe("run.cancelled");
    store.close();
  });

  it("repairs pending transcript tool calls when a cancelled runtime settles", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const runtime = new DeferredRuntime();
    const service = new AgentService(store, "/tmp", () => runtime);
    const run = await service.start(session.id, "cancel repair");
    store.appendTranscript(run.id, 1, {
      role: "assistant", content: [{ type: "toolCall", id: "pending-call", name: "read", arguments: { path: "a.txt" } }], api: "openai-completions", provider: "test", model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now(),
    });
    expect(service.cancel(run.id)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.listTranscript(run.id).at(-1)).toMatchObject({ role: "toolResult", toolCallId: "pending-call", isError: true, details: { synthetic: true, reason: "cancelled" } });
    expect(store.listEvents(run.id).some((event) => event.type === "transcript.repaired")).toBe(true);
    store.close();
  });
});
