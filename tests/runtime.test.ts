import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { AgentService } from "../src/core/agent-service.js";
import { Store } from "../src/store/store.js";
import type { AgentRuntime, RuntimeFactory } from "../src/runtime/types.js";

function assistantMessage(text: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
}

class FakeRuntime implements AgentRuntime {
  aborted = false;
  steered: string[] = [];
  prompts: string[] = [];
  constructor(private readonly messages: AgentMessage[]) {}
  async prompt(query: string) { this.prompts.push(query); }
  steer(instruction: string) { this.steered.push(instruction); }
  abort() { this.aborted = true; }
  getMessages() { return this.messages; }
  getError() { return undefined; }
}

class CallbackRuntime implements AgentRuntime {
  prompts: string[] = [];
  constructor(private readonly message: AgentMessage, private readonly onPrompt: (query: string) => void = () => {}) {}
  async prompt(query: string) { this.prompts.push(query); this.onPrompt(query); }
  steer() {}
  abort() {}
  getMessages() { return [this.message]; }
  getError() { return undefined; }
}

class DeferredRuntime implements AgentRuntime {
  aborted = false;
  private rejectPrompt?: (error: Error) => void;
  prompt() { return new Promise<void>((_resolve, reject) => { this.rejectPrompt = reject; }); }
  steer() {}
  abort() { this.aborted = true; this.rejectPrompt?.(new Error("aborted")); }
  getMessages() { return []; }
  getError() { return undefined; }
}

describe("AgentService runtime boundary", () => {
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
    const service = new AgentService(store, "/tmp", (value) => { options = value; return new FakeRuntime([assistantMessage("done")]); }, { maxContinuations: 0, contextWindow: 1_000 });
    service.resume(run.id);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(options?.initialMessages).toEqual([newUser, newAssistant]);
    expect(store.listEvents(run.id).some((event) => event.type === "context.pruned" && event.data.originalMessages === 4 && event.data.keptMessages === 2)).toBe(true);
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

  it("fails a run that exceeds its wall-clock timeout", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const runtime = new DeferredRuntime();
    const service = new AgentService(store, "/tmp", () => runtime, { runTimeoutMs: 5 });
    const run = await service.start(session.id, "timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runtime.aborted).toBe(true);
    expect(store.getRun(run.id)).toMatchObject({ status: "failed", blockedReason: "Run exceeded 5ms timeout" });
    expect(store.listEvents(run.id).at(-1)?.data).toMatchObject({ reason: "timeout" });
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
});
