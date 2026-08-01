import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { AgentService } from "../src/core/agent-service.js";
import { Store } from "../src/store/store.js";
import { TaskRunSupervisor } from "../src/core/supervisor.js";
import type { AgentRuntime, RuntimeFactory } from "../src/runtime/types.js";
import type { MemoryFacade } from "../src/memory/memory-service.js";

function assistantMessage(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
}

class CheckpointRuntime implements AgentRuntime {
  private resolvePrompt?: () => void;
  constructor(private readonly options: Parameters<RuntimeFactory>[0]) {}
  prompt() { return new Promise<void>((resolve) => { this.resolvePrompt = resolve; }); }
  async steer() { return "accepted" as const; }
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
  async steer() { return "accepted" as const; }
  abort() { this.resolvePrompt?.(); }
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
  async steer(instruction: string) { this.steered.push(instruction); return "accepted" as const; }
  abort() { this.aborted = true; }
  getMessages() { return this.messages; }
  getError() { return undefined; }
}

class InboxRuntime implements AgentRuntime {
  private resolvePrompt?: () => void;
  delivered: Array<{ kind: string; content: string }> = [];
  prompt() { return new Promise<void>((resolve) => { this.resolvePrompt = resolve; }); }
  async steer(content: string) { this.delivered.push({ kind: "steer", content }); return "accepted" as const; }
  async followUp(content: string) { this.delivered.push({ kind: "follow_up", content }); return "accepted" as const; }
  abort() { this.resolvePrompt?.(); }
  getMessages() { return []; }
  getError() { return undefined; }
}

class CallbackRuntime implements AgentRuntime {
  prompts: string[] = [];
  constructor(private readonly message: AgentMessage, private readonly onPrompt: (query: string) => void = () => {}) {}
  async prompt(query: string) { this.prompts.push(query); this.onPrompt(query); }
  async steer() { return "accepted" as const; }
  abort() {}
  getMessages() { return [this.message]; }
  getError() { return undefined; }
}

class DeferredRuntime implements AgentRuntime {
  aborted = false;
  private rejectPrompt?: (error: Error) => void;
  prompt() { return new Promise<void>((_resolve, reject) => { this.rejectPrompt = reject; }); }
  async steer() { return "accepted" as const; }
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
  it("persists an admitted user message before asynchronous memory recall completes", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let finishRecall!: (value: Awaited<ReturnType<MemoryFacade["recall"]>>) => void;
    const recall = new Promise<Awaited<ReturnType<MemoryFacade["recall"]>>>((resolve) => { finishRecall = resolve; });
    const memory = { recall: vi.fn(() => recall), enqueueCapture: vi.fn(async () => ({ jobId: "capture-1" })) } as unknown as MemoryFacade;
    const service = new AgentService(store, "/tmp", () => new DeferredRuntime(), {}, memory, "test-scope");

    const admitted = service.enqueueSessionInput(session.id, "visible immediately", "async-memory-admission");

    expect(admitted.run).toMatchObject({ goal: "visible immediately", status: "running" });
    expect(store.listMessages(session.id)).toEqual([expect.objectContaining({ role: "user", content: "visible immediately" })]);
    expect(memory.recall).toHaveBeenCalledOnce();
    finishRecall({ cards: [], coldTopics: [], promptSection: "", trace: { topicIds: [], candidateCount: 0, deniedCount: 0 } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.closeRuntimes();
    store.close();
  });

  it("routes active-run corrections into steer instead of a new TaskRun", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const runtime = new InboxRuntime();
    const service = new AgentService(store, "/tmp", () => runtime, { controlInboxCapacity: 4 });
    const first = service.enqueueSessionInput(session.id, "发布 0.1.4", "route-base");
    const routed = service.enqueueSessionInput(session.id, "不要重启服务，端口改成 3220", "route-steer");
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.listRuns(session.id)).toHaveLength(1);
    expect(routed.item).toMatchObject({ status: "routed", decision: "steer", runId: first.run!.id, analysis: { intent: "steer_active" } });
    expect(runtime.delivered).toContainEqual({ kind: "steer", content: "不要重启服务，端口改成 3220" });
    await service.closeRuntimes(); store.close();
  });

  it("keeps explicit postponed work deferred", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const service = new AgentService(store, "/tmp", () => new DeferredRuntime());
    const routed = service.enqueueSessionInput(session.id, "暂时不做", "defer-one");
    expect(routed.run).toBeNull();
    expect(routed.item).toMatchObject({ decision: "defer", analysis: { intent: "defer" } });
    expect(store.listRuns(session.id)).toHaveLength(0);
    await service.closeRuntimes(); store.close();
  });

  it("turns explicit parallel input into a spawn proposal", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const service = new AgentService(store, "/tmp", () => new DeferredRuntime());
    const first = service.enqueueSessionInput(session.id, "修复 Web UI", "parallel-base");
    const routed = service.enqueueSessionInput(session.id, "同时并行设计另一个独立的移动端客户端", "parallel-child");
    expect(store.listRuns(session.id)).toHaveLength(1);
    expect(routed.item).toMatchObject({ status: "routed", decision: "spawn_proposal", runId: first.run!.id });
    expect(store.listSpawnProposals(first.run!.id)).toEqual([expect.objectContaining({ relation: "parallel", status: "proposed" })]);
    await service.closeRuntimes(); store.close();
  });

  it("queues continuous Session input and starts the next TaskRun serially", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const runtimes: ControlledRuntime[] = [];
    const service = new AgentService(store, "/tmp", () => {
      const runtime = new ControlledRuntime([assistantMessage("done")]);
      runtimes.push(runtime);
      return runtime;
    });
    const first = service.enqueueSessionInput(session.id, "first task", "inbox-1");
    const second = service.enqueueSessionInput(session.id, "second task", "inbox-2");
    expect(first.run).toMatchObject({ goal: "first task", status: "running" });
    expect(second.run).toBeNull();
    expect(store.listSessionInbox(session.id)).toEqual([expect.objectContaining({ content: "second task", status: "queued" })]);
    expect(store.listMessages(session.id).map((item) => item.content)).toEqual(["first task"]);
    store.upsertPlanItem(first.run!.id, { key: "done", title: "Done", status: "done", required: true, position: 1 });
    runtimes[0].resolve();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(store.listRuns(session.id).map((run) => run.goal)).toEqual(["second task", "first task"]);
    expect(store.getActiveRun(session.id)?.goal).toBe("second task");
    expect(store.listMessages(session.id).filter((item) => item.role === "user").map((item) => item.content)).toEqual(["first task", "second task"]);
    await service.closeRuntimes();
    store.close();
  });

  it("keeps later Session input queued while the current TaskRun is blocked for continuation", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const runtimes: ControlledRuntime[] = [];
    const service = new AgentService(store, "/tmp", () => {
      const runtime = new ControlledRuntime([assistantMessage("not complete")]);
      runtimes.push(runtime);
      return runtime;
    });
    service.enqueueSessionInput(session.id, "blocked task", "blocked-1");
    service.enqueueSessionInput(session.id, "later task", "blocked-2");
    runtimes[0].resolve();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.listRuns(session.id)).toHaveLength(1);
    expect(store.listSessionInbox(session.id)).toEqual([expect.objectContaining({ content: "later task", status: "queued" })]);
    await service.closeRuntimes();
    store.close();
  });

  it("recovers queued Session Supervisor inbox work after restart", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const blocking = store.createRun(session.id, "old run");
    store.enqueueSessionInbox(session.id, "recover me", {
      summary: "recover me", intent: "new_task", targetRunId: null, priority: 500,
      urgency: "normal", relation: "independent", acceptanceCriteria: ["recover me"],
      scope: "recover me", nonGoals: [], confidence: 1, reason: "test", routerVersion: "test",
    }, "recover-inbox");
    store.finalizeRun(blocking.id, "completed");
    const service = new AgentService(store, "/tmp", () => new DeferredRuntime());
    expect(service.recoverSessionInbox()).toHaveLength(1);
    expect(store.getActiveRun(session.id)?.goal).toBe("recover me");
    await service.closeRuntimes();
    store.close();
  });

  it("persists and serially delivers idempotent control input into Pi runtime queues", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let runtime!: InboxRuntime;
    const service = new AgentService(store, "/tmp", () => runtime = new InboxRuntime(), { controlInboxCapacity: 4 });
    const run = await service.start(session.id, "durable controls");
    const [first, duplicate, second] = await Promise.all([
      service.steer(run.id, "change direction", "control-1"),
      service.steer(run.id, "change direction", "control-1"),
      service.followUp(run.id, "then verify", "control-2"),
    ]);
    expect(first.status).toBe("accepted");
    expect(duplicate.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    expect(runtime.delivered).toEqual([
      { kind: "steer", content: "change direction" },
      { kind: "follow_up", content: "then verify" },
    ]);
    expect(store.listControlInbox(run.id)).toEqual([
      expect.objectContaining({ requestId: "control-1", status: "delivered", attempt: 1 }),
      expect.objectContaining({ requestId: "control-2", status: "delivered", attempt: 1 }),
    ]);
    expect(store.listEvents(run.id).some((event) => event.type === "control.duplicate")).toBe(true);
    await service.closeRuntimes();
    store.close();
  });

  it("compensates a spawned Run when runtime launch throws", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const parent = store.createRun(session.id, "parent");
    store.finalizeRun(parent.id, "completed");
    const proposal = store.createSpawnProposal(parent.id, "child", [], "follow_up");
    store.updateSpawnProposalStatus(proposal.id, "approved");
    const service = new AgentService(store, "/tmp", () => { throw new Error("factory failed"); });
    expect(() => service.spawnProposal(proposal.id)).toThrow("factory failed");
    const persisted = store.listSpawnProposals(parent.id)[0];
    expect(persisted.status).toBe("rejected");
    expect(store.getRun(persisted.spawnedRunId)).toMatchObject({ status: "failed", blockedReason: expect.stringContaining("factory failed") });
    expect(store.listEvents(persisted.spawnedRunId).at(-1)).toMatchObject({ type: "run.failed", data: expect.objectContaining({ reason: "spawn_launch_failed" }) });
    store.close();
  });

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
    runtime.emit("tool.started", { toolCallId: "call-1", toolName: "read", args: { path: "/private/workspace/credential.json", content: "Bearer secret-token" } });
    expect(store.getCheckpoint(run.id)?.currentTool).toMatchObject({ toolCallId: "call-1", toolName: "read", startedAt: expect.any(Number), lastActivityAt: expect.any(Number) });
    expect(JSON.stringify(store.getCheckpoint(run.id)?.currentTool)).not.toContain("secret-token");
    expect(writes).toHaveBeenCalledTimes(3);
    runtime.emit("tool.progress", { toolCallId: "call-1", toolName: "read", summary: "API key: secret-output" });
    expect(store.getCheckpoint(run.id)?.currentTool).toMatchObject({ lastActivityAt: expect.any(Number) });
    expect(JSON.stringify(store.getCheckpoint(run.id)?.currentTool)).not.toContain("secret-output");
    expect(writes).toHaveBeenCalledTimes(4);
    runtime.emit("tool.completed", { toolCallId: "call-1", toolName: "read", isError: false });
    expect(store.getCheckpoint(run.id)?.currentTool).toBeNull();
    expect(writes).toHaveBeenCalledTimes(5);
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

  it("runs Supervisor restart reconciliation only once per service instance", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const service = new AgentService(store, "/tmp", () => new DeferredRuntime());
    service.recoverContinuations();
    const run = store.createRun(session.id, "active supervisor decision");
    const decision = new TaskRunSupervisor(store, { repeatedFailureThreshold: 1, maxSteersPerAttempt: 1, minEventsBetweenInterventions: 1 }).reviewCheckpoint(run.id, { runId: run.id, seq: 1, type: "tool.completed", data: { toolName: "bash", isError: true }, createdAt: Date.now() });
    expect(decision?.status).toBe("proposed");
    service.recoverContinuations();
    expect(store.listSupervisorDecisions(run.id)[0].status).toBe("proposed");
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

  it("reconciles a persisted Supervisor continuation decision after a crash gap", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "supervisor crash gap");
    store.upsertPlanItem(run.id, { key: "work", title: "Work", status: "pending", required: true, position: 1 });
    const supervisor = new TaskRunSupervisor(store);
    const review = supervisor.reviewSettled(store.getRun(run.id)!, 3, "not done");
    expect(review.decision.action).toBe("start_continuation");
    store.transitionRun(run.id, ["running"], "blocked", "run.blocked", {}, "work pending", 1);
    supervisor.markExecuted(review.decision.id, "executed");
    expect(store.listContinuations(run.id)).toHaveLength(0);
    for (const pending of store.listSupervisorContinuationsNeedingReconcile()) {
      expect(pending.runId).toBe(run.id);
      store.queueContinuation(pending.runId, `Recovered Supervisor continuation decision ${pending.decisionId}`);
    }
    expect(store.listContinuations(run.id)).toEqual([expect.objectContaining({ status: "queued", reason: expect.stringContaining(review.decision.id) })]);
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
    expect(service.getBudget(simple.id)).toEqual({ tier: "simple", softTokens: 80_000, maxContinuations: 40, maxTokens: 700_000, runTimeoutMs: 300_000 });
    const complex = store.createRun(session.id, "Implement and test a multi module frontend backend database migration architecture");
    const admittedBudget = service.getBudget(complex.id);
    for (let index = 0; index < 8; index += 1) store.upsertPlanItem(complex.id, { key: `p${index}`, title: `Step ${index}`, status: "pending", required: true, position: index });
    for (let index = 0; index < 3; index += 1) store.upsertCheck(complex.id, { key: `c${index}`, title: `Check ${index}`, status: "pending", required: true, command: "", evidence: "", stale: false });
    expect(admittedBudget).toEqual({ tier: "complex", softTokens: 640_000, maxContinuations: 40, maxTokens: 700_000, runTimeoutMs: 2_700_000 });
    expect(service.getBudget(complex.id)).toEqual(admittedBudget);
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

  it("treats the dynamic token tier as guidance while preserving the configured hard ceiling", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let captured: Parameters<RuntimeFactory>[0] | undefined;
    let aborted = false;
    let steered = "";
    const service = new AgentService(store, "/tmp", (options) => {
      captured = options;
      return {
        async prompt() {
          options.onTokenBudgetWarning?.({ totalTokens: 80_000, softLimit: options.softRunTokens!, hardLimit: options.maxRunTokens });
          await new Promise((resolve) => setTimeout(resolve, 0));
        },
        async steer(instruction) { steered = instruction; return "accepted" as const; },
        abort() { aborted = true; },
        getMessages() { return []; },
        getError() { return undefined; },
      };
    }, { maxContinuations: 40, maxRunTokens: 700_000, runTimeoutMs: 3_000_000 });
    const run = await service.start(session.id, "Say hello");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(captured?.softRunTokens).toBe(80_000);
    expect(captured?.maxRunTokens).toBe(700_000);
    expect(aborted).toBe(false);
    expect(store.getRun(run.id)?.status).not.toBe("blocked");
    expect(steered).toContain("hard ceiling is 700,000");
    expect(store.listEvents(run.id).some((event) => event.type === "run.token_budget.warning")).toBe(true);
    await service.closeRuntimes();
    store.close();
  });

  it("aborts an active runtime as soon as cumulative usage crosses its token budget", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let aborted = false;
    const service = new AgentService(store, "/tmp", (options) => ({
      async prompt() {
        const costly = assistantMessage("still working");
        if (costly.role === "assistant") costly.usage.totalTokens = 12;
        store.appendTranscript(options.runId, store.getRun(options.runId)!.attempt, costly);
        options.onTokenBudgetExceeded?.({ totalTokens: 12, limit: options.maxRunTokens! });
        await new Promise((resolve) => setTimeout(resolve, 0));
      },
      async steer() { return "accepted" as const; },
      abort() { aborted = true; },
      getMessages() { return []; },
      getError() { return undefined; },
    }), { dynamicBudget: false, maxContinuations: 2, maxRunTokens: 10 });
    const run = await service.start(session.id, "bounded active run");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(aborted).toBe(true);
    expect(store.getRun(run.id)).toMatchObject({ status: "blocked", blockedReason: expect.stringContaining("token budget") });
    expect(store.listContinuations(run.id)).toHaveLength(0);
    expect(store.listEvents(run.id).some((event) => event.type === "continuation.exhausted" && event.data.reason === "token_budget")).toBe(true);
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
  it("persists approval and requires a decision before resume", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "production deployment");
    store.upsertPlanItem(run.id, { key: "approval", title: "Production deployment approval", status: "blocked", required: true, position: 1 });
    class ApprovalRuntime extends DeferredRuntime {
      override async prompt() { this.messages = [assistantMessage("waiting")]; }
    }
    const service = new AgentService(store, "/tmp", () => new ApprovalRuntime());
    // Exercise the same durable state produced by settled supervision without relying on provider timing.
    const decision = new TaskRunSupervisor(store).reviewSettled(store.getRun(run.id)!, 1, "waiting").decision;
    store.blockRun(run.id, decision.rationale);
    const approval = store.ensureApprovalRequest(run.id, decision.id, decision.rationale);
    expect(() => service.resume(run.id)).toThrow(/approval decision/);
    store.resolveApprovalRequest(approval.id, "rejected", "user", "not now");
    expect(store.getRun(run.id)?.supervision.approvalRequests).toEqual([expect.objectContaining({ status: "rejected" })]);
    await service.closeRuntimes();
    store.close();
  });

});
