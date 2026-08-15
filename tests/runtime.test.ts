import { describe, expect, it, vi } from "vitest";
import { symlinkSync, unlinkSync } from "node:fs";
import type { RuntimeMessage as AgentMessage } from "@tagent/execution/ports";
import { AgentService } from "@tagent/core-service/application";
import { loadConfig } from "@tagent/core-service/config";
import { Store } from "@tagent/persistence-sqlite/store";
import type { RunEventMap, RunEventType } from "@tagent/execution/domain";
import { ExecutionState, RunEventHub, RuntimeRegistry } from "@tagent/execution/composition";
import { createEnvironmentCredentialResolver, credentialReference } from "@tagent/execution/ports";
import { TaskRunSupervisor, SupervisorReviewError, TestSupervisorReviewer, passingTestAudit, type SupervisorAudit, type SupervisorReviewer } from "@tagent/core-service/composition";
import type {
  AttemptRuntimeFactory as RuntimeFactory,
  AttemptRuntimePort as AgentRuntime,
} from "@tagent/execution/ports";
import type { MemoryFacade } from "@tagent/memory";
import { agentPersistence } from "./support/test-persistence.js";
import { upsertTrustedCheck } from "./support/trusted-evidence.js";

function assistantMessage(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
}

function continuationAudit(reason = "More work is required."): SupervisorAudit {
  const failure = { kind: "contract", key: "completion", reason, disposition: "auto_fixable" as const };
  const failed = { passed: false, failures: [failure], summary: reason };
  const passed = { passed: true, failures: [], summary: "Passed." };
  return { action: "start_continuation", reasonCode: "auto_fixable_gate_failures", rationale: reason, confidence: 1, gates: { progress: passed, evidence: passed, contract: failed, completion: failed, continuation: passed } };
}
function reviewer(...audits: SupervisorAudit[]) { return new TestSupervisorReviewer(audits); }

class CheckpointRuntime implements AgentRuntime {
  private resolvePrompt?: () => void;
  constructor(private readonly options: Parameters<RuntimeFactory>[0]) {}
  prompt() { return new Promise<void>((resolve) => { this.resolvePrompt = resolve; }); }
  async steer() { return "accepted" as const; }
  abort() { this.resolvePrompt?.(); }
  async dispose() { await this.abort(); }
  getMessages(): AgentMessage[] { return []; }
  getError() { return undefined; }
  emit<TType extends RunEventType>(type: TType, data: RunEventMap[TType]) {
    this.options.eventSink.publish(type, data);
  }
}

class ControlledRuntime implements AgentRuntime {
  private resolvePrompt?: () => void;
  private rejectPrompt?: (error: Error) => void;
  constructor(private readonly messages: AgentMessage[]) {}
  prompt() { return new Promise<void>((resolve, reject) => { this.resolvePrompt = resolve; this.rejectPrompt = reject; }); }
  async steer() { return "accepted" as const; }
  abort() { this.resolvePrompt?.(); }
  async dispose() { await this.abort(); }
  resolve() { this.resolvePrompt?.(); }
  reject(error: Error) { this.rejectPrompt?.(error); }
  getMessages() { return this.messages; }
  getError(): string | undefined { return undefined; }
}

class FakeRuntime implements AgentRuntime {
  aborted = false;
  steered: string[] = [];
  prompts: string[] = [];
  constructor(private readonly messages: AgentMessage[]) {}
  async prompt(query: string) { this.prompts.push(query); }
  async steer(instruction: string) { this.steered.push(instruction); return "accepted" as const; }
  abort() { this.aborted = true; }
  async dispose() { await this.abort(); }
  getMessages() { return this.messages; }
  getError(): string | undefined { return undefined; }
}

class CooldownRuntime extends FakeRuntime {
  override getError() { return '{"type":"model_cooldown","reset_seconds":60}'; }
  getProviderFailure() { return { kind: "model_cooldown", retryable: true, retryAfterMs: 60_000 }; }
}

class RejectingDisposeRuntime extends FakeRuntime {
  override async dispose() { throw new Error("runtime disposer failed"); }
}

class InboxRuntime implements AgentRuntime {
  private resolvePrompt?: () => void;
  delivered: Array<{ kind: string; content: string }> = [];
  prompt() { return new Promise<void>((resolve) => { this.resolvePrompt = resolve; }); }
  async steer(content: string) { this.delivered.push({ kind: "steer", content }); return "accepted" as const; }
  async followUp(content: string) { this.delivered.push({ kind: "follow_up", content }); return "accepted" as const; }
  abort() { this.resolvePrompt?.(); }
  async dispose() { await this.abort(); }
  getMessages() { return []; }
  getError() { return undefined; }
}

class BlockingControlRuntime implements AgentRuntime {
  private resolvePrompt?: () => void;
  private resolveSteer?: (result: "accepted") => void;
  steerStarted = false;
  prompt() { return new Promise<void>((resolve) => { this.resolvePrompt = resolve; }); }
  steer() {
    this.steerStarted = true;
    return new Promise<"accepted">((resolve) => { this.resolveSteer = resolve; });
  }
  releaseSteer() { this.resolveSteer?.("accepted"); }
  abort() { this.resolveSteer?.("accepted"); this.resolvePrompt?.(); }
  async dispose() { await this.abort(); }
  getMessages() { return []; }
  getError() { return undefined; }
}

class BlockingSupervisorSteerRuntime extends BlockingControlRuntime {
  constructor(private readonly options: Parameters<RuntimeFactory>[0]) { super(); }
  emit<TType extends RunEventType>(type: TType, data: RunEventMap[TType]) {
    this.options.eventSink.publish(type, data);
  }
}

class CallbackRuntime implements AgentRuntime {
  prompts: string[] = [];
  constructor(private readonly message: AgentMessage, private readonly onPrompt: (query: string) => void = () => {}) {}
  async prompt(query: string) { this.prompts.push(query); this.onPrompt(query); }
  async steer() { return "accepted" as const; }
  abort() {}
  async dispose() { await this.abort(); }
  getMessages() { return [this.message]; }
  getError() { return undefined; }
}

class SkillRuntime extends CallbackRuntime {
  invoked: Array<{ name: string; query: string }> = [];
  override async prompt(): Promise<void> { throw new Error("Selected Skill must use explicit runtime invocation"); }
  async invokeSkill(name: string, query: string) { this.invoked.push({ name, query }); }
}

class DeferredRuntime implements AgentRuntime {
  aborted = false;
  private rejectPrompt?: (error: Error) => void;
  prompt() { return new Promise<void>((_resolve, reject) => { this.rejectPrompt = reject; }); }
  async steer() { return "accepted" as const; }
  abort() { this.aborted = true; this.rejectPrompt?.(new Error("aborted")); }
  async dispose() { await this.abort(); }
  getMessages(): AgentMessage[] { return []; }
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

class LatchingDisposeRuntime extends DeferredRuntime {
  disposeStarted = false;
  private release?: () => void;
  private readonly quiescence = new Promise<void>((resolve) => { this.release = resolve; });
  override async dispose() {
    this.disposeStarted = true;
    await this.quiescence;
    await super.dispose();
  }
  reachQuiescence() { this.release?.(); }
}

describe("AgentService runtime boundary", () => {
  it("carries a Core-managed Skill from Session binding through the frozen TaskRun into explicit runtime invocation", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const skill = store.createSkillRevision({
      name: "release-check", description: "Verify the selected release", content: "Follow the frozen release checklist.",
      filePath: ".tagent/skills/release-check/hash/SKILL.md", sha256: "a".repeat(64), sourceFilename: "SKILL.md",
    });
    store.replaceWorkspaceSkills(session.id, [skill.skillId]);
    let captured: Parameters<RuntimeFactory>[0] | undefined;
    let runtime: SkillRuntime | undefined;
    const service = new AgentService(agentPersistence(store), "/tmp", (options) => {
      captured = options;
      runtime = new SkillRuntime(assistantMessage("skill executed"));
      return runtime;
    }, { supervisorReviewer: reviewer(passingTestAudit()) });

    const run = await service.start(session.id, "Check release 1.2.3");
    await vi.waitFor(() => expect(runtime?.invoked).toHaveLength(1));
    expect(store.getRun(run.id)?.contract?.skills).toEqual([expect.objectContaining({ revisionId: skill.id, sha256: "a".repeat(64), content: "Follow the frozen release checklist." })]);
    expect(captured?.skills).toEqual([expect.objectContaining({ name: "release-check", sha256: "a".repeat(64), content: "Follow the frozen release checklist." })]);
    expect(runtime?.invoked[0]).toMatchObject({ name: "release-check" });
    expect(runtime?.invoked[0].query).toContain("Check release 1.2.3");
    await service.closeRuntimes();
    store.close();
  });

  it("persists an admitted user message before asynchronous memory recall completes", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let finishRecall!: (value: Awaited<ReturnType<MemoryFacade["recall"]>>) => void;
    const recall = new Promise<Awaited<ReturnType<MemoryFacade["recall"]>>>((resolve) => { finishRecall = resolve; });
    const memory = { recall: vi.fn(() => recall), enqueueCapture: vi.fn(async () => ({ jobId: "capture-1" })) } as unknown as MemoryFacade;
    const service = new AgentService(agentPersistence(store), "/tmp", () => new DeferredRuntime(), {}, memory, "test-scope");

    const admitted = await service.enqueueSessionInput(session.id, "visible immediately", "async-memory-admission");

    expect(admitted.run).toMatchObject({ goal: "visible immediately", status: "running" });
    expect(store.listMessages(session.id)).toEqual([expect.objectContaining({ role: "user", content: "visible immediately" })]);
    expect(memory.recall).toHaveBeenCalledOnce();
    finishRecall({
      cards: [],
      coldTopics: [],
      promptSection: "",
      trace: {
        version: 2,
        topicIds: [],
        candidateCount: 0,
        deniedCount: 0,
        embedding: { configured: false, degraded: false },
        policyTransforms: 0,
        coldTopicRoutes: [],
        candidates: [],
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await service.closeRuntimes();
    store.close();
  });

  it("cancels an admitted Run while asynchronous memory preparation is still active", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let recallSignal: AbortSignal | undefined;
    const memory = {
      recall: vi.fn((request: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        recallSignal = request.signal;
        request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
      })),
      enqueueCapture: vi.fn(async () => ({ jobId: "capture-cancel" })),
    } as unknown as MemoryFacade;
    const runtimeFactory = vi.fn(() => new DeferredRuntime());
    const service = new AgentService(agentPersistence(store), "/tmp", runtimeFactory, {}, memory, "test-scope");

    const admitted = await service.enqueueSessionInput(session.id, "cancel during memory recall", "cancel-preparation");
    expect(service.cancel(admitted.run!.id)).toBe(true);
    await vi.waitFor(() => expect(recallSignal?.aborted).toBe(true));
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(store.getRun(admitted.run!.id)).toMatchObject({ status: "cancelled" });
    await service.closeRuntimes();
    store.close();
  });

  it("aborts and joins asynchronous preparation before runtime shutdown returns", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let recallCleanupFinished = false;
    const memory = {
      recall: vi.fn((request: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
        request.signal?.addEventListener("abort", () => {
          setTimeout(() => { recallCleanupFinished = true; reject(request.signal?.reason); }, 20);
        }, { once: true });
      })),
      enqueueCapture: vi.fn(async () => ({ jobId: "capture-close" })),
    } as unknown as MemoryFacade;
    const runtimeFactory = vi.fn(() => new DeferredRuntime());
    const service = new AgentService(agentPersistence(store), "/tmp", runtimeFactory, {}, memory, "test-scope");

    const admitted = await service.enqueueSessionInput(session.id, "close during memory recall", "close-preparation");
    await service.closeRuntimes();
    expect(recallCleanupFinished).toBe(true);
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(store.getRun(admitted.run!.id)).toMatchObject({ status: "interrupted" });
    store.close();
  });

  it("treats rejected adjacent work as settled after joining it during shutdown", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "join rejected preparation");
    const persistence = agentPersistence(store);
    const state = new ExecutionState({
      persistence,
      workspace: "/tmp",
      runtimeFactory: () => new DeferredRuntime(),
      runtimeDefaults: {},
    });
    const registry = new RuntimeRegistry(state, { eventHub: new RunEventHub(state) });
    const controller = new AbortController();
    state.preparationTasks.set(run.id, {
      controller,
      promise: Promise.reject(new Error("preparation stopped after cancellation")),
    });

    await expect(registry.closeRuntimes()).resolves.toEqual([]);

    expect(controller.signal.aborted).toBe(true);
    expect(state.preparationTasks.size).toBe(0);
    expect(store.getRun(run.id)).toMatchObject({ status: "interrupted" });
    store.close();
  });

  it("reports runtime disposal rejection as a quiescence failure", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "reject runtime disposal");
    const persistence = agentPersistence(store);
    const state = new ExecutionState({
      persistence,
      workspace: "/tmp",
      runtimeFactory: () => new DeferredRuntime(),
      runtimeDefaults: {},
    });
    const registry = new RuntimeRegistry(state, { eventHub: new RunEventHub(state) });
    state.runtimes.set(run.id, new RejectingDisposeRuntime([]));

    await expect(registry.closeRuntimes()).rejects.toThrow("Runtime shutdown failed to reach quiescence");

    expect(state.runtimes.has(run.id)).toBe(true);
    store.close();
  });

  it("passes the configured Router output budget to the OpenAI-compatible request", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const originalFetch = globalThis.fetch;
    let requestBody = "";
    globalThis.fetch = vi.fn(async (_url, init) => {
      requestBody = String(init?.body);
      const analysis = {
        summary: "Analyze and optimize the runtime",
        objectives: [{ summary: "Analyze and optimize the runtime", timing: "current", kind: "change" }],
        intent: "new_task", targetActiveRun: false, priority: 500, urgency: "normal", relation: "independent",
        acceptanceCriteria: ["The runtime is optimized and verified"], scope: "runtime", nonGoals: [], confidence: 1, reason: "Explicit request",
      };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(analysis) } }] }), { headers: { "content-type": "application/json" } });
    });
    const service = new AgentService(agentPersistence(store), "/tmp", () => new DeferredRuntime(), {
      routerModel: { id: "router-test", api: "openai-completions", baseUrl: "https://router.test/v1", maxTokens: 321 } as never,
      credential: { reference: credentialReference("TEST_API_KEY"), resolver: createEnvironmentCredentialResolver({ TEST_API_KEY: "test-key" }) },
    });
    try {
      await service.enqueueSessionInput(session.id, "Analyze and optimize this runtime end to end, including all performance-sensitive paths and verification evidence. ".repeat(5), "router-budget");
      expect(JSON.parse(requestBody)).toMatchObject({ model: "router-test", max_completion_tokens: 321, stream: true });
    } finally {
      await service.closeRuntimes();
      globalThis.fetch = originalFetch;
      store.close();
    }
  });

  it("routes active-run corrections into steer instead of a new TaskRun", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const runtime = new InboxRuntime();
    const service = new AgentService(agentPersistence(store), "/tmp", () => runtime, { controlInboxCapacity: 4 });
    const first = await service.enqueueSessionInput(session.id, "发布 0.1.4", "route-base");
    const routed = await service.enqueueSessionInput(session.id, "不要重启服务，端口改成 3220", "route-steer");
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.listRuns(session.id)).toHaveLength(1);
    expect(routed.item).toMatchObject({ status: "routed", decision: "steer", runId: first.run!.id, analysis: { intent: "steer_active" } });
    expect(runtime.delivered).toContainEqual({ kind: "steer", content: "不要重启服务，端口改成 3220" });
    await service.closeRuntimes(); store.close();
  });

  it("splits compound active input into steer, follow-up, and parallel governance actions", async () => {
    const store = new Store(":memory:"); const session = store.createSession();
    const service = new AgentService(agentPersistence(store), "/tmp", () => new DeferredRuntime());
    const first = await service.enqueueSessionInput(session.id, "修复 Supervisor", "compound-base");
    const active = first.run!;
    const routed = await service.enqueueSessionInput(session.id, "先不要部署。完成后更新文档。同时并行检查另一个仓库", "compound-route");
    expect(routed.run?.id).toBe(active.id);
    expect((routed as { relatedItems?: unknown[] }).relatedItems).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(store.listControlInbox(active.id)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "steer", content: expect.stringContaining("先不要部署") }), expect.objectContaining({ kind: "follow_up", content: expect.stringContaining("完成后更新文档") })]));
    expect(store.listSessionInbox(session.id)).toEqual([expect.objectContaining({ content: expect.stringContaining("并行检查另一个仓库"), status: "queued", analysis: expect.objectContaining({ relation: "parallel", targetRunId: active.id }) })]);
    await service.closeRuntimes(); store.close();
  });

  it("keeps explicit postponed work deferred", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const service = new AgentService(agentPersistence(store), "/tmp", () => new DeferredRuntime());
    const routed = await service.enqueueSessionInput(session.id, "暂时不做", "defer-one");
    expect(routed.run).toBeNull();
    expect(routed.item).toMatchObject({ decision: "defer", analysis: { intent: "defer" } });
    expect(store.listRuns(session.id)).toHaveLength(0);
    await service.closeRuntimes(); store.close();
  });

  it("keeps explicit parallel input as a related queued Session Inbox task", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const service = new AgentService(agentPersistence(store), "/tmp", () => new DeferredRuntime());
    const first = await service.enqueueSessionInput(session.id, "修复 Web UI", "parallel-base");
    const routed = await service.enqueueSessionInput(session.id, "同时并行设计另一个独立的移动端客户端", "parallel-child");
    expect(store.listRuns(session.id)).toHaveLength(1);
    expect(routed.item).toMatchObject({ status: "queued", decision: "pending", runId: null, analysis: { relation: "parallel", targetRunId: first.run!.id } });
    expect(store.listSessionInbox(session.id)).toEqual([expect.objectContaining({ id: routed.item.id, status: "queued", analysis: expect.objectContaining({ relation: "parallel", targetRunId: first.run!.id }) })]);
    await service.closeRuntimes(); store.close();
  });

  it("queues continuous Session input and starts the next TaskRun serially", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const runtimes: ControlledRuntime[] = [];
    const service = new AgentService(agentPersistence(store), "/tmp", () => {
      const runtime = new ControlledRuntime([assistantMessage(runtimes.length === 0 ? "The first task is complete. The requested first task was executed and its result was verified; there are no remaining blockers or incomplete acceptance criteria." : "The second task is now running and will produce its own complete verified result before TaskRun completion.")]);
      runtimes.push(runtime);
      return runtime;
    });
    const first = await service.enqueueSessionInput(session.id, "first task", "inbox-1");
    const second = await service.enqueueSessionInput(session.id, "second task", "inbox-2");
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
    const service = new AgentService(agentPersistence(store), "/tmp", () => {
      const runtime = new ControlledRuntime([assistantMessage("not complete")]);
      runtimes.push(runtime);
      return runtime;
    }, { maxContinuations: 0, supervisorReviewer: reviewer(continuationAudit()) });
    await service.enqueueSessionInput(session.id, "blocked task", "blocked-1");
    await service.enqueueSessionInput(session.id, "later task", "blocked-2");
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
      summary: "recover me", objectives: [{ id: "objective-1", summary: "recover me", timing: "current", kind: "other" }], intent: "new_task", targetRunId: null, priority: 500,
      urgency: "normal", relation: "independent", acceptanceCriteria: ["recover me"],
      scope: "recover me", nonGoals: [], confidence: 1, reason: "test", routerVersion: "test",
    }, "recover-inbox");
    store.finalizeRun(blocking.id, "completed");
    const service = new AgentService(agentPersistence(store), "/tmp", () => new DeferredRuntime());
    expect(service.recoverSessionInbox()).toHaveLength(1);
    expect(store.getActiveRun(session.id)?.goal).toBe("recover me");
    await service.closeRuntimes();
    store.close();
  });

  it("persists and serially delivers idempotent control input into Pi runtime queues", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let runtime!: InboxRuntime;
    const service = new AgentService(agentPersistence(store), "/tmp", () => runtime = new InboxRuntime(), { controlInboxCapacity: 4 });
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

  it("supersedes a control delivery that returns after its Attempt was cancelled", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const runtime = new BlockingControlRuntime();
    const service = new AgentService(agentPersistence(store), "/tmp", () => runtime);
    const run = await service.start(session.id, "cancel a delivering control");
    const delivery = service.steer(run.id, "late steering", "late-control");
    for (let index = 0; index < 100 && !runtime.steerStarted; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(runtime.steerStarted).toBe(true);
    expect(service.cancel(run.id)).toBe(true);
    const cancelSeq = store.listEvents(run.id).find((event) => event.type === "run.cancelled")!.seq;

    runtime.releaseSteer();
    await delivery;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store.listControlInbox(run.id)).toEqual([
      expect.objectContaining({ requestId: "late-control", status: "superseded" }),
    ]);
    expect(store.listEvents(run.id).filter((event) => event.seq > cancelSeq)).toEqual([]);
    expect(store.listEvents(run.id).some((event) => event.type === "control.delivered")).toBe(false);
    await service.closeRuntimes();
    store.close();
  });

  it("does not commit a late Supervisor steer decision after cancellation", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let runtime!: BlockingSupervisorSteerRuntime;
    const service = new AgentService(agentPersistence(store), "/tmp", (options) => {
      runtime = new BlockingSupervisorSteerRuntime(options);
      return runtime;
    });
    const run = await service.start(session.id, "cancel a Supervisor steer");
    for (let index = 1; index <= 3; index += 1) {
      runtime.emit("tool.completed", {
        toolCallId: `failed-${index}`,
        toolName: "read",
        isError: true,
      });
    }
    for (let index = 0; index < 100 && !runtime.steerStarted; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(runtime.steerStarted).toBe(true);
    expect(store.listSupervisorDecisions(run.id, 1)).toEqual([
      expect.objectContaining({ action: "steer", status: "proposed" }),
    ]);
    expect(service.cancel(run.id)).toBe(true);
    const cancelSeq = store.listEvents(run.id).find((event) => event.type === "run.cancelled")!.seq;

    runtime.releaseSteer();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(store.listSupervisorDecisions(run.id, 1)).toEqual([
      expect.objectContaining({ action: "steer", status: "superseded" }),
    ]);
    expect(store.listEvents(run.id).filter((event) => event.seq > cancelSeq)).toEqual([]);
    expect(store.listEvents(run.id).some((event) => event.type === "supervisor.decision")).toBe(false);
    await service.closeRuntimes();
    store.close();
  });

  it("requires unified approval before a related parallel Inbox task can start", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const service = new AgentService(agentPersistence(store), "/tmp", () => new DeferredRuntime());
    const parent = await service.enqueueSessionInput(session.id, "parent", "parallel-approval-parent");
    const related = await service.enqueueSessionInput(session.id, "同时并行处理独立子任务", "parallel-approval-child");
    expect(service.startSessionInputNow(session.id, related.item.id)).toMatchObject({ status: "approval_required", runId: parent.run!.id });
    const approval = service.requestParallelSessionInputApproval(session.id, related.item.id);
    await service.approveRunApproval(approval.id);
    const [edge] = store.listTaskRunEdges(parent.run!.id);
    expect(edge).toMatchObject({ relation: "parallel" });
    if (!edge) throw new Error("parallel TaskRun edge was not created");
    expect(store.getRun(edge.toRunId)?.contract).toMatchObject({ parentRunId: parent.run!.id, relation: "parallel", sourceInboxIds: [related.item.id] });
    await service.closeRuntimes(); store.close();
  });

  it("pauses external actions before runtime launch and binds approval to the resumed Attempt", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let runtimeOptions: Parameters<RuntimeFactory>[0] | undefined;
    const service = new AgentService(agentPersistence(store), "/tmp", (options) => {
      runtimeOptions = options;
      return new DeferredRuntime();
    });
    const admitted = await service.enqueueSessionInput(session.id, "请部署到生产环境。", "external-pre-effect-approval");
    const runId = admitted.run!.id;
    expect(store.getRun(runId)).toMatchObject({ status: "blocked", attempt: 1 });
    expect(runtimeOptions).toBeUndefined();
    const approval = store.listApprovalRequests(runId)[0]!;
    expect(approval).toMatchObject({ actionType: "execute_external_action", status: "pending", metadata: { approvedAttempt: 2 } });
    await service.approveRunApproval(approval.id);
    expect(runtimeOptions).toBeDefined();
    expect(runtimeOptions!.eventSink.beforeToolCall({ toolCallId: "external-read", toolName: "read", args: { path: "README.md" } })).toEqual({ blocked: false });
    expect(store.getApprovalRequest(approval.id)).toMatchObject({ status: "approved" });
    expect(runtimeOptions!.eventSink.beforeToolCall({ toolCallId: "external-call", toolName: "write", args: { path: "approved.txt", content: "approved" } })).toEqual({ blocked: false });
    expect(store.getApprovalRequest(approval.id)).toMatchObject({ status: "consumed" });
    expect(store.authorizeExternalAction(runId, 3)).toMatchObject({ allowed: false });
    await service.closeRuntimes();
    store.close();
  });

  it("keeps external-action approval mandatory when completion Gate is off", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let launched = false;
    const service = new AgentService(agentPersistence(store), "/tmp", () => { launched = true; return new DeferredRuntime(); });
    const admitted = await service.enqueueSessionInput(session.id, "请部署到生产环境。", "external-gate-off", undefined, "off");
    const run = store.getRun(admitted.run!.id)!;
    expect(run).toMatchObject({ status: "blocked", gateRequired: false, contract: { executionPolicy: { mode: "external_action", gateProfile: "off" } } });
    expect(launched).toBe(false);
    expect(store.listApprovalRequests(run.id)[0]).toMatchObject({ actionType: "execute_external_action", status: "pending" });
    await service.closeRuntimes(); store.close();
  });

  it("normalizes a persisted external-risk policy before runtime admission", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const inconsistentPolicy = { mode: "semantic_delivery", sideEffectRisk: "external_high", evidencePolicy: "semantic", reviewPolicy: "semantic_lite", policyVersion: "inconsistent-test", confidence: 1, reason: "risk mismatch" } as const;
    const analysis = { summary: "external task", objectives: [{ id: "o1", summary: "external task", timing: "current" as const, kind: "other" as const }], intent: "new_task" as const, targetRunId: null, priority: 500, urgency: "normal" as const, relation: "independent" as const, acceptanceCriteria: ["complete"], scope: "external", nonGoals: [], confidence: 1, reason: "test", routerVersion: "test", executionPolicy: inconsistentPolicy };
    store.enqueueSessionInbox(session.id, "external action", analysis, "external-risk");
    let launched = false;
    const service = new AgentService(agentPersistence(store), "/tmp", () => { launched = true; return new DeferredRuntime(); });
    expect(service.recoverSessionInbox()).toHaveLength(1);
    const run = store.listRuns(session.id)[0]!;
    expect(run).toMatchObject({ status: "blocked" });
    expect(store.listApprovalRequests(run.id)[0]).toMatchObject({ actionType: "execute_external_action", status: "pending" });
    expect(launched).toBe(false);
    await service.closeRuntimes();
    store.close();
  });

  it("requires a fresh external-action approval instead of starting an unauthorized continuation", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let runtimeCalls = 0;
    const service = new AgentService(agentPersistence(store), "/tmp", () => {
      runtimeCalls += 1;
      return new FakeRuntime([assistantMessage("External action needs more work.")]);
    });
    const admitted = await service.enqueueSessionInput(session.id, "请部署到生产环境。", "external-reapproval");
    const runId = admitted.run!.id;
    await service.approveRunApproval(store.listApprovalRequests(runId)[0]!.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtimeCalls).toBe(1);
    expect(store.getRun(runId)).toMatchObject({ status: "blocked", attempt: 2, continuations: [] });
    expect(store.listApprovalRequests(runId)).toEqual([
      expect.objectContaining({ actionType: "execute_external_action", status: "approved", metadata: expect.objectContaining({ approvedAttempt: 2 }) }),
      expect.objectContaining({ actionType: "execute_external_action", status: "pending", metadata: expect.objectContaining({ approvedAttempt: 3 }) }),
    ]);
    await service.closeRuntimes();
    store.close();
  });

  it("throttles partial checkpoints and persists tool boundaries immediately", async () => {
    const store = new Store(":memory:");
    const writes = vi.spyOn(store, "upsertCheckpoint");
    const session = store.createSession();
    let runtime!: CheckpointRuntime;
    const service = new AgentService(agentPersistence(store), "/tmp", (options) => runtime = new CheckpointRuntime(options));
    const run = await service.start(session.id, "checkpoint stream");
    expect(writes).toHaveBeenCalledTimes(1);
    runtime.emit("runtime.queue", { pendingMessageCount: 0 });
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(writes).toHaveBeenCalledTimes(1);
    runtime.emit("message.delta", { delta: "A", ordinal: 1 });
    runtime.emit("message.delta", { delta: "B", ordinal: 1 });
    expect(store.getCheckpoint(run.id)).toMatchObject({ active: true, assistantPartial: "", lastEventSeq: 2 });
    expect(writes).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(store.getCheckpoint(run.id)).toMatchObject({ assistantPartial: "AB", lastEventSeq: 5 });
    expect(writes).toHaveBeenCalledTimes(2);
    runtime.emit("tool.started", { toolCallId: "call-1", toolName: "read", args: { path: "/private/workspace/credential.json", content: "Bearer secret-token" } });
    expect(store.getCheckpoint(run.id)?.currentTool).toMatchObject({ toolCallId: "call-1", toolName: "read", startedAt: expect.any(Number), lastActivityAt: expect.any(Number) });
    expect(JSON.stringify(store.getCheckpoint(run.id)?.currentTool)).not.toContain("secret-token");
    expect(writes).toHaveBeenCalledTimes(3);
    const startedActivityAt = store.getCheckpoint(run.id)?.currentTool?.lastActivityAt;
    runtime.emit("tool.progress", { toolCallId: "call-1", toolName: "read", summary: "API key: secret-output" });
    expect(store.getCheckpoint(run.id)?.currentTool).toMatchObject({ lastActivityAt: startedActivityAt });
    expect(JSON.stringify(store.getCheckpoint(run.id)?.currentTool)).not.toContain("secret-output");
    expect(writes).toHaveBeenCalledTimes(3);
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(store.getCheckpoint(run.id)?.currentTool).toMatchObject({ lastActivityAt: expect.any(Number) });
    expect(writes).toHaveBeenCalledTimes(4);
    runtime.emit("tool.completed", { toolCallId: "call-1", toolName: "read", isError: false });
    expect(store.getCheckpoint(run.id)?.currentTool).toBeNull();
    expect(writes).toHaveBeenCalledTimes(5);
    await service.closeRuntimes();
    expect(store.getCheckpoint(run.id)?.active).toBe(false);
    store.close();
  });

  it("uses the durable completed message as the final candidate when runtime history ends with an empty assistant shell", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const complete = "Root cause found and fixed. The durable completed response is preserved and the regression test passed.";
    const runtimeFactory: RuntimeFactory = (options) => ({
      async prompt() {
        const active = store.getActiveRun(session.id)!;
        store.upsertPlanItem(active.id, { key: "done", title: "Done", status: "done", required: true, position: 1 });
        upsertTrustedCheck(store, active.id, { key: "verify", title: "Verify", command: "npm test", output: "regression test passed" });
        options.eventSink.publish("message.started", { ordinal: 1 });
        options.eventSink.publish("message.delta", { ordinal: 1, delta: complete });
        options.eventSink.publish("message.completed", { ordinal: 1, content: complete });
      },
      async steer() { return "accepted" as const; },
      abort() {},
      async dispose() { await this.abort(); },
      getMessages() { return [assistantMessage(complete), assistantMessage("")]; },
      getError() { return undefined; },
    });
    const service = new AgentService(agentPersistence(store), "/tmp", runtimeFactory);
    const run = await service.start(session.id, "find and fix the missing final response");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(store.getRun(run.id)?.status).toBe("completed");
    expect(store.listMessages(session.id).at(-1)).toMatchObject({ role: "assistant", content: complete });
    await service.closeRuntimes(); store.close();
  });

  it("resets the durable partial when a new assistant message starts", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let runtime!: CheckpointRuntime;
    const service = new AgentService(agentPersistence(store), "/tmp", (options) => runtime = new CheckpointRuntime(options));
    const run = await service.start(session.id, "multi-message stream");
    runtime.emit("message.started", { ordinal: 1 });
    runtime.emit("message.delta", { delta: "first answer", ordinal: 1 });
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(store.getCheckpoint(run.id)?.assistantPartial).toBe("first answer");
    runtime.emit("message.started", { ordinal: 2 });
    runtime.emit("message.delta", { delta: "replacement", ordinal: 2 });
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(store.getCheckpoint(run.id)?.assistantPartial).toBe("replacement");
    await service.closeRuntimes();
    store.close();
  });

  it("clears an inactive partial across restart and starts resume with a fresh checkpoint", async () => {
    const directory = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(`${process.env.TMPDIR ?? "/tmp"}/tagent-checkpoint-restart-`));
    const filename = `${directory}/tagent.db`;
    const firstStore = new Store(filename);
    const session = firstStore.createSession();
    const run = firstStore.createRun(session.id, "restart checkpoint");
    firstStore.upsertCheckpoint({ runId: run.id, attempt: 1, active: true, assistantPartial: "partial answer", currentTool: { toolCallId: "call-1", toolName: "bash" }, lastEventSeq: 7, lastTranscriptSeq: 2 });
    firstStore.close();

    const secondStore = new Store(filename);
    const service = new AgentService(agentPersistence(secondStore), "/tmp", () => new DeferredRuntime());
    expect(secondStore.getRun(run.id)).toMatchObject({ status: "interrupted", checkpoint: { active: false, assistantPartial: "", currentTool: null, attempt: 1 } });
    const resumed = await service.resume(run.id);
    expect(resumed).toMatchObject({ status: "running", attempt: 2, checkpoint: { active: true, assistantPartial: "", currentTool: null, attempt: 2 } });
    await service.closeRuntimes();
    secondStore.close();
  });

  it("constructs agents through the injected runtime factory", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const runtime = new FakeRuntime([assistantMessage("done")]);
    const factory: RuntimeFactory = vi.fn(() => runtime);
    const service = new AgentService(agentPersistence(store), "/tmp", factory, { maxContinuations: 0, supervisorReviewer: reviewer(continuationAudit()) });
    const run = await service.start(session.id, "test factory");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(factory).toHaveBeenCalledOnce();
    expect(runtime.prompts).toHaveLength(1);
    expect(runtime.prompts[0]).toContain("test factory");
    expect(store.getRun(run.id)?.status).toBe("blocked");
    store.close();
  });

  it("keeps the system prompt stable across Attempts and supplies current Run state through the dynamic tail", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const systemPrompts: string[] = [];
    const dynamicContexts: string[] = [];
    const service = new AgentService(agentPersistence(store), "/tmp", (options) => {
      systemPrompts.push(options.systemPrompt);
      dynamicContexts.push(options.dynamicContext?.() ?? "");
      return new CallbackRuntime(assistantMessage("candidate"), () => {
        store.upsertPlanItem(options.token.runId, { key: "work", title: "Work", status: "done", required: true, position: 1 });
      });
    }, { maxContinuations: 0, supervisorReviewer: reviewer(continuationAudit(), passingTestAudit()) });

    const run = await service.start(session.id, "stable-prefix-regression-marker");
    await vi.waitFor(() => expect(store.getRun(run.id)?.status).toBe("blocked"));
    await service.resume(run.id);
    await vi.waitFor(() => expect(systemPrompts).toHaveLength(2));

    expect(systemPrompts).toHaveLength(2);
    expect(systemPrompts[1]).toBe(systemPrompts[0]);
    expect(systemPrompts[0]).not.toContain("Active TaskRun");
    expect(systemPrompts[0]).not.toContain("stable-prefix-regression-marker");
    expect(dynamicContexts[0]).toContain('"attempt":1');
    expect(dynamicContexts[1]).toContain('"attempt":2');
    expect(dynamicContexts[1]).toContain("TAGENT_CORE_RUNTIME_CONTEXT");
    await service.closeRuntimes();
    store.close();
  });

  it("persists provider cooldown recovery instead of immediately starting another Attempt", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let runtimeCalls = 0;
    const service = new AgentService(agentPersistence(store), "/tmp", () => {
      runtimeCalls += 1;
      return new CooldownRuntime([]);
    }, { maxContinuations: 2 });

    const run = await service.start(session.id, "provider cooldown recovery");
    await vi.waitFor(() => expect(store.listContinuations(run.id)).toHaveLength(1));
    const continuation = store.listContinuations(run.id)[0];
    expect(store.getRun(run.id)?.status).toBe("blocked");
    expect(continuation).toMatchObject({ status: "queued", notBefore: expect.any(Number) });
    expect(continuation.notBefore).toBeGreaterThan(Date.now() + 50_000);
    expect(continuation.reason).toContain("[provider-retry:model_cooldown:");
    expect(runtimeCalls).toBe(1);
    await service.closeRuntimes();
    store.close();
  });

  it("lets manual Resume supersede a queued provider cooldown continuation", async () => {
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "manual cooldown override");
    store.blockRun(run.id, "model_cooldown");
    const delayed = store.queueContinuation(run.id, "delayed provider retry", Date.now() + 60_000);
    const service = new AgentService(agentPersistence(store), "/tmp", () => new DeferredRuntime());

    await service.resume(run.id);
    expect(store.getRun(run.id)).toMatchObject({ status: "running", attempt: 2 });
    expect(store.listContinuations(run.id)).toEqual([expect.objectContaining({ id: delayed.id, status: "cancelled", error: "Superseded by manual resume" })]);
    await service.closeRuntimes();
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
    const service = new AgentService(agentPersistence(store), "/tmp", () => {
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
    const service = new AgentService(agentPersistence(store), "/tmp", () => new DeferredRuntime());
    service.recoverContinuations();
    const run = store.createRun(session.id, "active supervisor decision");
    const decision = new TaskRunSupervisor(store, reviewer(passingTestAudit()), { repeatedFailureThreshold: 1, maxSteersPerAttempt: 1, minEventsBetweenInterventions: 1 }).reviewCheckpoint(run.id, { runId: run.id, seq: 1, type: "tool.completed", data: { toolName: "bash", isError: true }, createdAt: Date.now() });
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
    const service = new AgentService(agentPersistence(store), "/tmp", () => new CallbackRuntime(assistantMessage("recovered"), () => {
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
    const service = new AgentService(agentPersistence(store), "/tmp", () => runtime);
    await service.start(session.id, "graceful close");
    const closing = service.closeRuntimes();
    expect(runtime.settled).toBe(false);
    await closing;
    expect(runtime.settled).toBe(true);
    expect(store.getRun((store.listRuns(session.id)[0]).id)?.status).toBe("interrupted");
    store.close();
  });

  it("does not report service shutdown before runtime disposal reaches quiescence", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const runtime = new LatchingDisposeRuntime();
    const service = new AgentService(agentPersistence(store), "/tmp", () => runtime);
    await service.start(session.id, "quiescent close");

    let closed = false;
    const closing = service.closeRuntimes().then(() => { closed = true; });
    await vi.waitFor(() => expect(runtime.disposeStarted).toBe(true));
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(store.db.open).toBe(true);

    runtime.reachQuiescence();
    await closing;
    expect(closed).toBe(true);
    store.close();
  });

  it("releases a continuation lease instead of failing it during graceful close", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "close continuation");
    store.blockRun(run.id, "gate");
    store.queueContinuation(run.id, "gate");
    const runtime = new SlowAbortRuntime();
    const service = new AgentService(agentPersistence(store), "/tmp", () => runtime);
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
    const service = new AgentService(agentPersistence(store), "/tmp", () => runtime);
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
    const service = new AgentService(agentPersistence(store), "/tmp", (value) => { options = value; return new FakeRuntime([assistantMessage("done")]); }, { maxContinuations: 0, maxContextTurns: 2 });
    await service.start(session.id, "latest?");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(options?.initialMessages?.at(-1)).toMatchObject({ role: "user", content: "message-10001" });
    expect(JSON.stringify(options?.initialMessages)).not.toContain("message-0\"");
    store.close();
  });

  it("loads session history after reopening the persistent store", async () => {
    const directory = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(`${process.env.TMPDIR ?? "/tmp"}/tagent-session-history-`));
    const filename = `${directory}/tagent.db`;
    const firstStore = new Store(filename);
    const session = firstStore.createSession();
    firstStore.appendMessage(session.id, "user", "Persistent fact: release channel is stable");
    firstStore.appendMessage(session.id, "assistant", "The release channel is stable.");
    firstStore.close();

    const secondStore = new Store(filename);
    let options: Parameters<RuntimeFactory>[0] | undefined;
    const service = new AgentService(agentPersistence(secondStore), "/tmp", (value) => { options = value; return new FakeRuntime([assistantMessage("stable")]); }, { maxContinuations: 0 });
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
    const service = new AgentService(agentPersistence(store), "/tmp", (value) => { options = value; return runtime; }, { maxContinuations: 0 });

    const run = await service.start(session.id, "What is the project codename?");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(options?.initialMessages?.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(options?.initialMessages?.[0]).toMatchObject({ role: "user", content: "Remember project codename Atlas" });
    expect(options?.initialMessages?.[1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "The project codename is Atlas." }] });
    expect(runtime.prompts).toHaveLength(1);
    expect(runtime.prompts[0]).toContain("What is the project codename?");
    expect(JSON.stringify(options?.initialMessages)).not.toContain("What is the project codename?");
    expect(store.listEvents(run.id).some((event) => event.type === "context.loaded"
      && event.data.source === "session"
      && event.data.keptMessages === 2
      && typeof event.data.systemTokens === "number"
      && typeof event.data.promptTokens === "number"
      && typeof event.data.estimatedMessageTokens === "number")).toBe(true);
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
    const service = new AgentService(agentPersistence(store), "/tmp", (value) => { options = value; return new FakeRuntime([assistantMessage("done")]); }, { maxContinuations: 0, contextWindow: 2_000, maxContextTurns: 1, model: { contextWindow: 2_000, maxTokens: 200 } as never });

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
    const service = new AgentService(agentPersistence(store), "/tmp", factory, { maxContinuations: 0, supervisorReviewer: reviewer(continuationAudit(), continuationAudit()) });
    const started = await service.start(session.id, "resume goal", "stable-request");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getRun(started.id)?.status).toBe("blocked");

    const resumed = await service.resume(started.id);
    expect(resumed.id).toBe(started.id);
    expect(resumed.requestId).toMatch(/^inbox:/);
    expect(store.getSessionSubmission(session.id, "stable-request")?.runId).toBe(started.id);
    expect(resumed.attempt).toBe(2);
    expect(resumed.resumedAt).toBeTypeOf("number");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(factory).toHaveBeenCalledTimes(2);
    expect(options[1].initialMessages).toEqual([]);
    expect(second.prompts[0]).toContain("Resume this interrupted or blocked TaskRun");
    expect(second.prompts[0]).toContain("no-side-effect semantic delivery");
    expect(second.prompts[0]).not.toContain("Completion-gate requirements override conflicting instructions");
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
    const service = new AgentService(agentPersistence(store), "/tmp", (value) => { options = value; return runtime; });
    await service.resume(run.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(options?.initialMessages).toEqual([user, assistant]);
    expect(runtime.prompts[0]).toContain("persisted pi transcript messages");
    expect(store.listEvents(run.id).find((event) => event.type === "run.resumed")?.data).toMatchObject({ mode: "transcript-continuation", transcriptCount: 2 });
    store.close();
  });

  it("reconciles a persisted Supervisor continuation decision after a crash gap", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "supervisor crash gap");
    store.upsertPlanItem(run.id, { key: "work", title: "Work", status: "pending", required: true, position: 1 });
    const supervisor = new TaskRunSupervisor(store, reviewer(continuationAudit()));
    const review = await supervisor.reviewSettled(store.getRun(run.id)!, 3, "not done");
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
    const service = new AgentService(agentPersistence(store), "/tmp", () => new CallbackRuntime(assistantMessage("recovered"), () => {
      store.upsertPlanItem(run.id, { key: "recover", title: "Recover", status: "done", required: true, position: 1 });
    }), { maxContinuations: 2 });
    expect(service.recoverContinuations()).toEqual([run.id]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(store.getRun(run.id)).toMatchObject({ status: "completed", attempt: 3 });
    expect(store.listContinuations(run.id)[0]).toMatchObject({ status: "completed", error: "" });
    expect(store.listEvents(run.id).some((event) => event.type === "continuation.recovered")).toBe(true);
    store.close();
  });

  it("safely requeues a claimed continuation when project-context preparation fails", async () => {
    const fs = await import("node:fs/promises");
    const workspace = await fs.mkdtemp(`${process.env.TMPDIR ?? "/tmp"}/tagent-continuation-prep-`);
    await fs.writeFile(`${workspace}/AGENTS.md`, "rules");
    const store = new Store(":memory:");
    const session = store.createSession();
    let calls = 0;
    const service = new AgentService(agentPersistence(store), workspace, () => {
      calls += 1;
      return new CallbackRuntime(assistantMessage("first candidate"), () => {
        if (calls === 1) {
          unlinkSync(`${workspace}/AGENTS.md`);
          symlinkSync("missing-rules.md", `${workspace}/AGENTS.md`);
        }
      });
    }, { maxContinuations: 2, supervisorReviewer: reviewer(continuationAudit()) });
    const run = await service.start(session.id, "prepare continuation safely");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(1);
    expect(store.getRun(run.id)).toMatchObject({ status: "blocked" });
    expect(store.getRun(run.id)!.attempt).toBeGreaterThanOrEqual(2);
    expect(store.listContinuations(run.id)[0]).toMatchObject({ status: "queued", leaseOwner: "" });
    expect(store.listEvents(run.id).some((event) => event.type === "continuation.preparation.failed")).toBe(true);
    await service.closeRuntimes();
    store.close();
  });

  it("uses semantic continuation instructions without artificial Bash requirements", async () => {
    const store = new Store(":memory:"); const session = store.createSession();
    const policy = { mode: "semantic_delivery", sideEffectRisk: "none", evidencePolicy: "semantic", reviewPolicy: "semantic_lite", policyVersion: "test", confidence: 1, reason: "translation" } as const;
    const contract = { sourceInput: "translate", summary: "translate", objectives: [{ id: "o1", summary: "translate", timing: "current" as const, kind: "other" as const }], acceptanceCriteria: ["Preserve meaning"], scope: "text", nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "new_task" as const, decisionReason: "test", routerVersion: "test", executionPolicy: policy };
    const run = store.createRun(session.id, "translate", undefined, contract);
    store.blockRun(run.id, "semantic correction required");
    store.queueContinuation(run.id, "semantic correction required");
    let prompt = "";
    const service = new AgentService(agentPersistence(store), "/tmp", () => new CallbackRuntime(assistantMessage("translated"), (value) => { prompt = value; }), { maxContinuations: 1 });
    service.recoverContinuations();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prompt).toContain("no-side-effect semantic delivery");
    expect(prompt).not.toMatch(/rerun.*Bash|verification command|rebind every required check/i);
    await service.closeRuntimes(); store.close();
  });

  it("tells prerequisite continuations that semantic criteria are unevaluated", async () => {
    const store = new Store(":memory:"); const session = store.createSession();
    const policy = { mode: "read_only_analysis", sideEffectRisk: "read_only", evidencePolicy: "operation_receipt", reviewPolicy: "full", policyVersion: "test", confidence: 1, reason: "research" } as const;
    const contract = { sourceInput: "research", summary: "research", objectives: [{ id: "o1", summary: "research", timing: "current" as const, kind: "investigate" as const }], acceptanceCriteria: ["Deliver the final research report"], scope: "public evidence", nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent" as const, intent: "new_task" as const, decisionReason: "test", routerVersion: "test", executionPolicy: policy };
    const run = store.createRun(session.id, "research", undefined, contract);
    store.upsertPlanItem(run.id, { key: "research", title: "Research evidence", status: "pending", required: true, position: 1 });
    let prompt = "";
    const service = new AgentService(agentPersistence(store), "/tmp", () => new CallbackRuntime(assistantMessage("done"), (value) => { prompt = value; }), { maxContinuations: 0 });
    const supervisor = new TaskRunSupervisor(store, new TestSupervisorReviewer());
    await supervisor.reviewSettled(store.getRun(run.id)!, 1, "partial candidate");
    store.blockRun(run.id, "research: Required plan item is pending");
    store.queueContinuation(run.id, "research: Required plan item is pending");
    service.recoverContinuations();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prompt).toContain("Semantic contract coverage has not been evaluated yet");
    expect(prompt).toContain("repair only the listed plan/check prerequisites");
    await service.closeRuntimes(); store.close();
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
    const service = new AgentService(agentPersistence(store), "/tmp", (value) => { options = value; return new FakeRuntime([assistantMessage("done")]); }, { maxContinuations: 0, contextWindow: 1_000, maxContextTurns: 1, model: { contextWindow: 1_000, maxTokens: 100 } as never });
    await service.resume(run.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(options?.initialMessages).toEqual([newUser, newAssistant]);
    expect(store.listEvents(run.id).some((event) => event.type === "context.pruned" && event.data.source === "transcript" && event.data.originalMessages === 4 && event.data.keptMessages === 2)).toBe(true);
    store.close();
  });

  it("automatically continues a gate-blocked run and completes it", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let runId = "";
    let calls = 0;
    const runtimes: CallbackRuntime[] = [];
    const service = new AgentService(agentPersistence(store), "/tmp", () => {
      calls += 1;
      const runtime = new CallbackRuntime(assistantMessage(calls === 1 ? "blocked" : "done"), () => {
        if (calls === 2) {
          store.upsertPlanItem(runId, { key: "work", title: "Finish work", status: "done", required: true, position: 1 });
          upsertTrustedCheck(store, runId, { key: "verify", title: "Verify work", command: "test", output: "1 test passed" });
        }
      });
      runtimes.push(runtime);
      return runtime;
    }, { maxContinuations: 2, supervisorReviewer: reviewer(continuationAudit(), passingTestAudit()) });
    const run = await service.start(session.id, "auto continue");
    runId = run.id;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(2);
    expect(store.getRun(run.id)).toMatchObject({ status: "completed", attempt: 2 });
    expect(store.listContinuations(run.id)[0]).toMatchObject({ ordinal: 1, status: "completed" });
    expect(store.listMessages(session.id).filter((message) => message.role === "assistant").map((message) => message.content)).toEqual(["done"]);
    expect(runtimes[1].prompts[0]).toContain("Automatic continuation 1");
    expect(runtimes[1].prompts[0]).toContain("no-side-effect semantic delivery");
    expect(runtimes[1].prompts[0]).not.toContain("Maintain a concise required plan");
    store.close();
  });

  it("keeps a parallel approval pending when the approved launch cannot be claimed", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const service = new AgentService(agentPersistence(store), "/tmp", () => new DeferredRuntime());
    const parent = await service.start(session.id, "parent task");
    const queued = await service.enqueueSessionInput(session.id, "parallel task", "parallel-launch-failure");
    store.db.prepare("UPDATE session_supervisor_inbox SET relation='parallel', target_run_id=? WHERE id=?").run(parent.id, queued.item.id);
    const approval = service.requestParallelSessionInputApproval(session.id, queued.item.id);
    store.deleteSessionInboxItem(queued.item.id, session.id);
    await expect(service.approveRunApproval(approval.id)).rejects.toThrow("could not start: not_queued");
    expect(store.getApprovalRequest(approval.id)).toMatchObject({ status: "pending", resolvedAt: null });
    expect(store.listEvents(parent.id).some((event) => event.type === "supervisor.approval.approved" && event.data.approvalId === approval.id)).toBe(false);
    service.cancel(parent.id);
    await service.closeRuntimes();
    store.close();
  });

  it("fails and releases an automatic continuation when its runtime factory throws", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let calls = 0;
    const service = new AgentService(agentPersistence(store), "/tmp", (options) => {
      calls += 1;
      if (calls === 2) throw new Error("continuation factory unavailable");
      return new CallbackRuntime(assistantMessage("blocked"), () => {
        store.upsertPlanItem(options.token.runId, { key: "work", title: "Finish work", status: "pending", required: true, position: 1 });
      });
    }, { maxContinuations: 1, supervisorReviewer: reviewer(continuationAudit()) });
    const run = await service.start(session.id, "continuation factory failure");
    for (let index = 0; index < 100 && store.listContinuations(run.id)[0]?.status !== "failed"; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(calls).toBe(2);
    expect(store.getRun(run.id)).toMatchObject({ status: "failed", attempt: 2, blockedReason: "continuation factory unavailable" });
    expect(store.db.prepare("SELECT status, active FROM attempts WHERE run_id = ? AND ordinal = 2").get(run.id)).toMatchObject({ status: "failed", active: 0 });
    expect(store.getCheckpoint(run.id)).toMatchObject({ active: false });
    expect(store.listContinuations(run.id)[0]).toMatchObject({ status: "failed", error: "continuation factory unavailable", leaseOwner: "", leaseUntil: null });
    await service.closeRuntimes();
    store.close();
  });

  it("loads only the previous attempt delta for automatic continuation", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let calls = 0;
    const captured: Array<Parameters<RuntimeFactory>[0]> = [];
    const service = new AgentService(agentPersistence(store), "/tmp", (options) => {
      captured.push(options);
      calls += 1;
      return new CallbackRuntime(assistantMessage(calls === 1 ? "needs one repair" : "repaired and verified"), () => {
        if (calls === 1) {
          store.appendTranscript(options.token.runId, 1, { role: "user", content: "old attempt detail", timestamp: 1 });
          store.appendTranscript(options.token.runId, 1, assistantMessage("latest failed candidate"));
        } else {
          store.upsertPlanItem(options.token.runId, { key: "work", title: "Work", status: "done", required: true, position: 1 });
          upsertTrustedCheck(store, options.token.runId, { key: "verify", title: "Verify", command: "test", output: "passed" });
        }
      });
    }, { maxContinuations: 1, supervisorReviewer: reviewer(continuationAudit(), passingTestAudit()) });
    const run = await service.start(session.id, "continuation delta");
    // Historical attempt zero data must not be replayed into attempt two.
    store.appendTranscript(run.id, 0, { role: "user", content: "ancient unrelated transcript", timestamp: 0 });
    for (let index = 0; index < 50 && captured.length < 2; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(captured).toHaveLength(2);
    expect(JSON.stringify(captured[1].initialMessages)).toContain("old attempt detail");
    expect(JSON.stringify(captured[1].initialMessages)).not.toContain("ancient unrelated transcript");
    expect(store.listEvents(run.id).some((event) => event.type === "context.loaded" && event.data.source === "transcript" && event.data.originalMessages === 2)).toBe(true);
    store.close();
  });

  it("stops repeated continuations when the same gate diagnosis makes no progress", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let calls = 0;
    const service = new AgentService(agentPersistence(store), "/tmp", () => { calls += 1; return new CallbackRuntime(assistantMessage("continue")); }, { maxContinuations: 64, runTimeoutMs: 60_000, supervisorReviewer: reviewer(continuationAudit(), continuationAudit(), continuationAudit()) });
    const run = await service.start(session.id, "stalled durable run");
    for (let index = 0; index < 100 && !store.listEvents(run.id).some((event) => event.type === "continuation.stalled"); index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(3);
    expect(store.getRun(run.id)?.status).toBe("blocked");
    expect(store.listContinuations(run.id)).toHaveLength(2);
    expect(store.listEvents(run.id).some((event) => event.type === "continuation.stalled" && event.data.reason === "repeated_gate_state")).toBe(true);
    store.close();
  });

  it("allows continuation when the durable gate/evidence state changes even if wording stays similar", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let calls = 0;
    let runId = "";
    const service = new AgentService(agentPersistence(store), "/tmp", () => {
      calls += 1;
      return new CallbackRuntime(assistantMessage("continue"), () => {
        if (calls === 2) store.upsertPlanItem(runId, { key: "progress", title: "Progress", status: "done", required: false, position: 2 });
      });
    }, { maxContinuations: 3, supervisorReviewer: reviewer(continuationAudit(), continuationAudit(), continuationAudit(), continuationAudit()) });
    const run = await service.start(session.id, "changing durable state");
    runId = run.id;
    for (let index = 0; index < 120 && calls < 4; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toBe(4);
    expect(store.listContinuations(run.id)).toHaveLength(3);
    expect(store.listEvents(run.id).some((event) => event.type === "continuation.stalled" && event.data.reason === "repeated_gate_state")).toBe(true);
    store.close();
  });

  it("stops automatic continuation after the configured limit", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let calls = 0;
    const service = new AgentService(agentPersistence(store), "/tmp", () => { calls += 1; return new CallbackRuntime(assistantMessage("blocked")); }, { maxContinuations: 1, supervisorReviewer: reviewer(continuationAudit(), continuationAudit()) });
    const run = await service.start(session.id, "stay blocked");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(2);
    expect(store.getRun(run.id)?.status).toBe("blocked");
    expect(store.listContinuations(run.id)).toHaveLength(1);
    expect(store.listEvents(run.id).some((event) => event.type === "continuation.exhausted" && event.data.reason === "max_continuations")).toBe(true);
    store.close();
  });

  it("keeps token use observational and does not install Core token controls", async () => {
    const store = new Store(":memory:"); const session = store.createSession(); let captured: Parameters<RuntimeFactory>[0] | undefined;
    const config = loadConfig({ TAGENT_MAX_RUN_TOKENS: "1", TAGENT_DYNAMIC_BUDGET: "true", TAGENT_MAX_MODEL_CALLS: "1", TAGENT_MAX_TOOL_CALLS: "1" });
    const service = new AgentService(agentPersistence(store), "/tmp", (options) => { captured = options; return new CallbackRuntime(assistantMessage("observed usage only")); }, {
      model: { id: config.model.modelId, provider: config.model.provider, api: config.model.api, baseUrl: config.model.baseUrl, contextWindow: config.model.contextWindow, maxTokens: config.model.maxTokens },
    });
    await service.start(session.id, "observe token usage"); await new Promise((resolve) => setTimeout(resolve, 20));
    expect(captured).not.toHaveProperty("maxRunTokens"); expect(captured).not.toHaveProperty("softRunTokens");
    expect(captured).not.toHaveProperty("dynamicBudget"); expect(captured).not.toHaveProperty("maxModelCalls"); expect(captured).not.toHaveProperty("maxToolCalls");
    expect(captured?.model?.maxTokens).toBe(32_768);
    expect(store.listEvents(store.getLatestRun(session.id)!.id).some((event) => /token_budget|budget_exhausted|call_budget/.test(event.type))).toBe(false); store.close();
  });

  it("launches each TaskRun with its persisted Workspace model and reasoning effort", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    store.updateSession(session.id, { modelId: "fallback-model", reasoningEffort: "xhigh" });
    let captured: Parameters<RuntimeFactory>[0] | undefined;
    const primary = { id: "primary-model", provider: "test", api: "openai-responses", baseUrl: "https://example.test/v1", reasoning: true, contextWindow: 10_000, maxTokens: 1_000 };
    const fallback = { ...primary, id: "fallback-model" };
    const service = new AgentService(agentPersistence(store), "/tmp", (options) => { captured = options; return new CallbackRuntime(assistantMessage("profile applied")); }, { model: primary, fallbackModels: [fallback] });
    await service.start(session.id, "use workspace profile");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(captured).toMatchObject({ model: { id: "fallback-model" }, fallbackModels: [{ id: "primary-model" }], reasoningEffort: "xhigh" });
    store.close();
  });

  it("reports the configured 120-second default when the Run idle watchdog expires", async () => {
    vi.useFakeTimers();
    try {
      const store = new Store(":memory:");
      const session = store.createSession();
      const runtime = new DeferredRuntime();
      const service = new AgentService(agentPersistence(store), "/tmp", () => runtime, { runTimeoutMs: loadConfig({}).runTimeoutMs, runHardTimeoutMs: 86_400_000 });
      const run = await service.start(session.id, "default timeout");

      await vi.advanceTimersByTimeAsync(119_999);
      expect(store.getRun(run.id)?.status).toBe("running");
      await vi.advanceTimersByTimeAsync(1);

      expect(runtime.aborted).toBe(true);
      expect(store.getRun(run.id)).toMatchObject({ status: "failed", blockedReason: "Run idle for 120000ms without progress" });
      expect(store.listEvents(run.id).at(-1)?.data).toMatchObject({ reason: "idle_timeout", limitMs: 120_000 });
      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a run only after its idle watchdog sees no progress", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const runtime = new DeferredRuntime();
    const service = new AgentService(agentPersistence(store), "/tmp", () => runtime, { runTimeoutMs: 10, runHardTimeoutMs: 1_000 });
    const run = await service.start(session.id, "timeout");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runtime.aborted).toBe(true);
    expect(store.getRun(run.id)).toMatchObject({ status: "failed", blockedReason: "Run idle for 10ms without progress" });
    expect(store.listEvents(run.id).at(-1)?.data).toMatchObject({ reason: "idle_timeout", limitMs: 10 });
    store.close();
  });

  it("allows an idle-timeout failure to resume after stale runtime cleanup settles", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const first = new SlowAbortRuntime();
    const second = new DeferredRuntime();
    let calls = 0;
    const service = new AgentService(agentPersistence(store), "/tmp", () => ++calls === 1 ? first : second, { runTimeoutMs: 10, runHardTimeoutMs: 1_000 });
    const run = await service.start(session.id, "timeout then resume");
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(store.getRun(run.id)).toMatchObject({ status: "failed", resumable: true });

    const resumed = await service.resume(run.id);

    expect(first.settled).toBe(true);
    expect(resumed).toMatchObject({ id: run.id, status: "running", attempt: 2, resumable: false });
    expect(store.listEvents(run.id).some((event) => event.type === "run.resumed" && event.data.attempt === 2)).toBe(true);
    service.cancel(run.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    store.close();
  });

  it("does not apply the Run idle watchdog while bounded Supervisor review is in progress", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const slowReviewer: SupervisorReviewer = {
      evaluator: "llm",
      model: "slow-reviewer",
      async reviewSettled() {
        await new Promise((resolve) => setTimeout(resolve, 40));
        return passingTestAudit();
      },
      async reviewAttemptFailure() { return { action: "block_taskrun", reasonCode: "failed", rationale: "failed", confidence: 1 }; },
    };
    const service = new AgentService(agentPersistence(store), "/tmp", () => new CallbackRuntime(assistantMessage("complete candidate")), { runTimeoutMs: 10, runHardTimeoutMs: 1_000, supervisorReviewer: slowReviewer });
    const run = await service.start(session.id, "slow bounded review");
    await new Promise((resolve) => setTimeout(resolve, 70));
    expect(store.getRun(run.id)).toMatchObject({ status: "completed", blockedReason: "" });
    expect(store.listEvents(run.id).some((event) => event.type === "run.failed" && event.data.reason === "idle_timeout")).toBe(false);
    store.close();
  });

  it("refreshes the idle watchdog while the runtime keeps making progress", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let runtime!: ActiveDeferredRuntime;
    let activityCount = 0;
    const service = new AgentService(agentPersistence(store), "/tmp", (options) => {
      runtime = new ActiveDeferredRuntime(() => { activityCount += 1; options.eventSink.activity(); }, 5);
      return runtime;
    }, { runTimeoutMs: 40, runHardTimeoutMs: 1_000 });
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
    const service = new AgentService(agentPersistence(store), "/tmp", (options) => {
      runtime = new ActiveDeferredRuntime(() => options.eventSink.activity(), 5);
      return runtime;
    }, { runTimeoutMs: 40, runHardTimeoutMs: 70 });
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
    const service = new AgentService(agentPersistence(store), "/tmp", () => runtime);
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
    const service = new AgentService(agentPersistence(store), "/tmp", () => runtime);
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
      override async prompt() {}
      override getMessages() { return [assistantMessage("waiting")]; }
    }
    const service = new AgentService(agentPersistence(store), "/tmp", () => new ApprovalRuntime());
    // Exercise the same durable state produced by settled supervision without relying on provider timing.
    const approvalAudit = { ...continuationAudit("Production approval is required."), action: "pause_for_approval" as const, reasonCode: "approval_required" };
    const decision = (await new TaskRunSupervisor(store, reviewer(approvalAudit)).reviewSettled(store.getRun(run.id)!, 1, "waiting")).decision;
    store.blockRun(run.id, decision.rationale);
    const approval = store.ensureApprovalRequest(run.id, decision.id, decision.rationale);
    await expect(service.resume(run.id)).rejects.toThrow(/approval decision/);
    store.resolveApprovalRequest(approval.id, "rejected", "user", "not now");
    expect(store.getRun(run.id)?.supervision.approvalRequests).toEqual([expect.objectContaining({ status: "rejected" })]);
    await service.closeRuntimes();
    store.close();
  });

  it("does not create an Agent continuation when the Supervisor audit itself fails validation", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let runtimeCalls = 0;
    const failedReviewer: SupervisorReviewer = {
      evaluator: "llm",
      model: "broken-supervisor",
      async reviewSettled() { throw new SupervisorReviewError("invalid structured audit"); },
      async reviewAttemptFailure() { throw new Error("Supervisor review failures must not be reclassified as Agent runtime failures"); },
    };
    const service = new AgentService(agentPersistence(store), "/tmp", () => { runtimeCalls += 1; return new FakeRuntime([assistantMessage("candidate result")]); }, { maxContinuations: 8, supervisorReviewer: failedReviewer });
    const run = await service.start(session.id, "Explain audit failure isolation.");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(runtimeCalls).toBe(1);
    expect(store.getRun(run.id)).toMatchObject({ status: "blocked", attempt: 1 });
    expect(store.getRun(run.id)?.continuations).toHaveLength(0);
    expect(store.listSupervisorDecisions(run.id)).toEqual([expect.objectContaining({ reasonCode: "supervisor_review_failed", action: "block_taskrun", evaluator: "llm" })]);
    expect(store.listMessages(session.id)).toEqual([
      expect.objectContaining({ role: "user", content: "Explain audit failure isolation." }),
    ]);
    await service.closeRuntimes();
    store.close();
  });

  it("terminalizes the Run when semantic runtime-failure classification itself throws", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    let runtime!: ControlledRuntime;
    let classificationCalls = 0;
    const failedReviewer: SupervisorReviewer = {
      evaluator: "llm",
      model: "broken-failure-supervisor",
      async reviewSettled() { return passingTestAudit(); },
      async reviewAttemptFailure() { classificationCalls += 1; throw new Error("failure classifier unavailable"); },
    };
    const service = new AgentService(agentPersistence(store), "/tmp", () => runtime = new ControlledRuntime([]), { maxContinuations: 8, supervisorReviewer: failedReviewer });
    const run = await service.start(session.id, "opaque runtime failure");
    runtime.reject(new Error("opaque provider explosion"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(classificationCalls).toBe(1);
    expect(store.getRun(run.id)).toMatchObject({ status: "blocked", attempt: 1 });
    expect(store.getRun(run.id)?.continuations).toHaveLength(0);
    expect(store.listSupervisorDecisions(run.id).at(-1)).toMatchObject({ action: "block_taskrun", reasonCode: "runtime_failure_review_unavailable", evaluator: "system" });
    await service.closeRuntimes();
    store.close();
  });

});
