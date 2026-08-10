import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createModels, type Context, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxThinking } from "@earendil-works/pi-ai/providers/faux";
import { PiRuntime, type PiRuntimeOptions } from "@tagent/runtime-pi";
import { Store } from "@tagent/persistence-sqlite/store";
import { createRuntimeHost } from "@tagent/core-service/composition";
import { attemptIdFor } from "@tagent/execution/domain";
import { agentPersistence } from "./support/test-persistence.js";

describe("Pi 0.83 AgentHarness integration", () => {
  function fauxModels(faux: ReturnType<typeof fauxProvider>) {
    const models = createModels();
    models.setProvider(faux.provider);
    return models;
  }
  function runtimeSpec(store: Store, run: ReturnType<Store["createRun"]>, options: Omit<PiRuntimeOptions, "token" | "capabilities" | "eventSink">): PiRuntimeOptions {
    const attempt = agentPersistence(store).attempts.getAttemptForRun(run.id, run.attempt)!;
    const ownerId = `pi-test:${run.id}`;
    const lease = agentPersistence(store).attempts.acquireExecutionLease({ attemptId: attempt.id, expectedVersion: attempt.version, ownerId, leaseMs: 30_000 });
    const token = {
      runId: run.id, attemptId: attemptIdFor(run.id, run.attempt), ordinal: run.attempt,
      expectedVersion: attempt.version, ownerId, leaseToken: lease.token, executionFence: lease.fence,
    };
    const host = createRuntimeHost({
      persistence: agentPersistence(store), token, workspace: options.workspace,
      onActivity: () => undefined, onEvent: () => undefined,
      memoryScopeId: "test", memorySubjectId: `session:${run.sessionId}`,
    });
    return { ...options, token, ...host };
  }

  async function setup(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0], tokensPerSecond = 10_000) {
    const faux = fauxProvider({ models: [{ id: "faux-session", contextWindow: 32_000, maxTokens: 2_000 }], tokensPerSecond });
    faux.setResponses(responses);
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "sdk session");
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), models: fauxModels(faux), initialMessages: [], providerMaxRetries: 1 }));
    return { faux, store, run, runtime };
  }

  it("runs offline with controlled resources and persists the SDK transcript", async () => {
    const { store, run, runtime } = await setup([fauxAssistantMessage("session ready")]);
    await runtime.prompt("hello");
    expect(runtime.getActiveToolNames().sort()).toEqual(["bash", "edit", "ls", "patch", "read", "task_run", "write"]);
    expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "session ready" }] });
    expect(store.listTranscript(run.id).some((message) => message.role === "assistant")).toBe(true);
    expect(store.listEvents(run.id).some((event) => event.type === "message.completed")).toBe(true);
    runtime.dispose();
    store.close();
  });

  it("streams and persists model thinking separately from visible answer text", async () => {
    const { store, run, runtime } = await setup([fauxAssistantMessage([fauxThinking("inspect, compare, verify"), { type: "text", text: "done" }])]);
    await runtime.prompt("reason");
    const events = store.listEvents(run.id);
    expect(events.filter((event) => event.type === "message.thinking.delta").map((event) => String(event.data.delta ?? "")).join("")).toBe("inspect, compare, verify");
    expect(store.listTranscriptView(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "thinking", text: "inspect, compare, verify" }),
      expect.objectContaining({ kind: "assistant", text: "done" }),
    ]));
    runtime.dispose();
    store.close();
  });

  it("coalesces streaming text deltas while preserving exact content and completion order", async () => {
    const text = "x".repeat(2_000);
    const { store, run, runtime } = await setup([fauxAssistantMessage(text)], 100_000);
    await runtime.prompt("stream");
    const events = store.listEvents(run.id);
    const deltas = events.filter((event) => event.type === "message.delta");
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.length).toBeLessThan(100);
    expect(deltas.map((event) => String(event.data.delta ?? "")).join("")).toBe(text);
    expect(events.findIndex((event) => event.type === "message.completed")).toBeGreaterThan(events.findIndex((event) => event.type === "message.delta"));
    runtime.dispose();
    store.close();
  });

  it("does not emit completion or provider failure events after a Run is cancelled", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-cancel", contextWindow: 32_000, maxTokens: 2_000 }], tokensPerSecond: 10 });
    faux.setResponses([fauxAssistantMessage("late response")]);
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "cancel events");
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), models: fauxModels(faux), initialMessages: [] }));
    const prompt = runtime.prompt("start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    store.transitionRun(run.id, ["running"], "cancelled", "run.cancelled", {}, "Cancelled by user");
    await runtime.abort();
    await prompt;
    const eventTypes = store.listEvents(run.id).map((event) => event.type);
    expect(eventTypes).not.toContain("message.completed");
    expect(eventTypes).not.toContain("message.retrying");
    expect(eventTypes).not.toContain("provider.failure");
    expect(store.listTranscript(run.id).some((message) => message.role === "assistant" && message.stopReason === "aborted")).toBe(false);
    runtime.dispose();
    store.close();
  });

  it("uses abort semantics when disposed during an active response", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-dispose", contextWindow: 32_000, maxTokens: 2_000 }], tokensPerSecond: 10 });
    faux.setResponses([fauxAssistantMessage("late response")]);
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "dispose active response");
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), models: fauxModels(faux), initialMessages: [] }));
    const prompt = runtime.prompt("start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    runtime.dispose();
    await prompt;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const eventTypes = store.listEvents(run.id).map((event) => event.type);
    expect(eventTypes).not.toContain("message.completed");
    expect(eventTypes).not.toContain("message.retrying");
    expect(eventTypes).not.toContain("provider.failure");
    expect(store.listTranscript(run.id).some((message) => message.role === "assistant" && message.stopReason === "aborted")).toBe(false);
    store.close();
  });

  it("settles an active tool attempt before disposing an aborted session", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-abort", contextWindow: 32_000, maxTokens: 2_000 }] });
    faux.setResponses([fauxAssistantMessage([{ type: "toolCall", id: "slow-bash", name: "bash", arguments: { command: "sleep 30" } }], { stopReason: "toolUse" })]);
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "abort active tool");
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), models: fauxModels(faux), initialMessages: [] }));
    const prompt = runtime.prompt("start");
    for (let index = 0; index < 100 && !store.listEvents(run.id).some((event) => event.type === "tool.started"); index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await runtime.abort();
    await prompt;
    runtime.dispose();
    expect(store.db.prepare("SELECT status FROM tool_attempts WHERE run_id = ? AND tool_call_id = 'slow-bash'").get(run.id)).toMatchObject({ status: "failed" });
    expect(store.listOperations(run.id)[0]).toMatchObject({ status: "failed", stage: "execution_failed" });
    store.close();
  });

  it("honors abort requested before the first provider response", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-init", contextWindow: 32_000, maxTokens: 2_000 }], tokensPerSecond: 10 });
    faux.setResponses([fauxAssistantMessage("must not settle normally")]);
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "abort initialization");
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), models: fauxModels(faux), initialMessages: [] }));
    const prompt = runtime.prompt("hello");
    await new Promise((resolve) => setTimeout(resolve, 10));
    await runtime.abort();
    await prompt;
    expect(runtime.getError()).toMatch(/abort/i);
    runtime.dispose();
    store.close();
  });

  it("applies bounded full-turn retry with lifecycle events and succeeds on the next attempt", async () => {
    let retryContext: Context | undefined;
    const { faux, store, run, runtime } = await setup([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service unavailable" }),
      (context) => { retryContext = context; return fauxAssistantMessage("recovered"); },
    ]);
    await runtime.prompt("retry");
    expect(faux.state.callCount).toBe(2);
    expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "recovered" }] });
    expect(store.listEvents(run.id).some((event) => event.type === "provider.retry")).toBe(true);
    expect(store.listEvents(run.id).some((event) => event.type === "provider.retry.completed" && event.data.success === true)).toBe(true);
    expect(store.listEvents(run.id).filter((event) => event.type === "message.completed")).toHaveLength(1);
    expect(store.listEvents(run.id).some((event) => event.type === "message.retrying" && event.data.willRetry === true)).toBe(true);
    expect(store.listEvents(run.id).filter((event) => event.type === "runtime.settled")).toHaveLength(1);
    expect(store.listTranscript(run.id).filter((message) => message.role === "user")).toEqual([
      expect.objectContaining({ role: "user", content: [{ type: "text", text: "retry" }] }),
    ]);
    expect(retryContext?.messages.filter((message) => message.role === "assistant" && message.stopReason === "error")).toHaveLength(0);
    expect(JSON.stringify(retryContext?.messages)).not.toContain("TAgent internal continuation");
    runtime.dispose();
    store.close();
  });


  it("keeps provider retry backoff abortable", async () => {
    const { faux, store, run, runtime } = await setup([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service unavailable" }),
      fauxAssistantMessage("must not retry after abort"),
    ]);
    const prompt = runtime.prompt("retry then cancel");
    for (let index = 0; index < 100 && !store.listEvents(run.id).some((event) => event.type === "provider.retry"); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const startedAt = Date.now();
    await runtime.abort();
    await prompt;
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(faux.state.callCount).toBe(1);
    expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "provider.retry.completed", data: expect.objectContaining({ success: false, finalError: "Retry cancelled" }) }),
    ]));
    runtime.dispose();
    store.close();
  });

  it("delivers steering accepted during provider retry backoff", async () => {
    let retryContext: Context | undefined;
    const { faux, store, run, runtime } = await setup([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service unavailable" }),
      (context) => { retryContext = context; return fauxAssistantMessage("steered retry recovered"); },
    ]);
    const prompt = runtime.prompt("retry then steer");
    for (let index = 0; index < 100 && !store.listEvents(run.id).some((event) => event.type === "provider.retry"); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await expect(runtime.steer("new direction during backoff")).resolves.toBe("accepted");
    await prompt;
    expect(faux.state.callCount).toBe(2);
    expect(JSON.stringify(retryContext?.messages)).toContain("new direction during backoff");
    expect(store.listTranscript(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: [{ type: "text", text: "new direction during backoff" }] }),
    ]));
    runtime.dispose();
    store.close();
  });

  it("delivers steering queued before a terminal provider failure settles", async () => {
    let providerEntered!: () => void;
    let releaseFailure!: () => void;
    const entered = new Promise<void>((resolve) => { providerEntered = resolve; });
    const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
    let recoveryContext: Context | undefined;
    const { faux, store, runtime } = await setup([
      async () => {
        providerEntered();
        await failureGate;
        return fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 Unauthorized" });
      },
      (context) => { recoveryContext = context; return fauxAssistantMessage("control recovered terminal failure"); },
    ]);
    const prompt = runtime.prompt("start terminal request");
    await entered;
    await expect(runtime.steer("replace the failing direction")).resolves.toBe("accepted");
    releaseFailure();
    await prompt;
    expect(faux.state.callCount).toBe(2);
    expect(JSON.stringify(recoveryContext?.messages)).toContain("replace the failing direction");
    expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "control recovered terminal failure" }] });
    runtime.dispose();
    store.close();
  });

  it("uses the SDK steering queue while a response is streaming", async () => {
    const { store, run, runtime } = await setup([fauxAssistantMessage("a long streaming answer"), fauxAssistantMessage("steered result")], 10);
    const prompt = runtime.prompt("start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.steer("change direction");
    await prompt;
    expect(store.listEvents(run.id).some((event) => event.type === "runtime.queue" && JSON.stringify(event.data.steering).includes("change direction"))).toBe(true);
    expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "steered result" }] });
    runtime.dispose();
    store.close();
  });

  it("uses Pi clearQueue when aborting and audits discarded pending input", async () => {
    const { store, run, runtime } = await setup([fauxAssistantMessage("a long streaming answer"), fauxAssistantMessage("must not run")], 10);
    const prompt = runtime.prompt("start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(runtime.followUp("pending input")).resolves.toBe("accepted");
    await runtime.abort();
    await prompt;
    expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "runtime.queue.cleared", data: expect.objectContaining({ followUp: ["pending input"] }) }),
    ]));
    runtime.dispose();
    store.close();
  });

  it("rejects steer and follow-up after Pi has settled instead of orphaning queue messages", async () => {
    const { store, run, runtime } = await setup([fauxAssistantMessage("settled")]);
    await runtime.prompt("start");
    await expect(runtime.steer("too late")).resolves.toBe("settled");
    await expect(runtime.followUp("also too late")).resolves.toBe("settled");
    expect(store.listEvents(run.id).filter((event) => event.type === "runtime.queue")).toHaveLength(0);
    runtime.dispose();
    store.close();
  });

  it("uses the SDK follow-up queue after the active response settles", async () => {
    const { store, run, runtime } = await setup([fauxAssistantMessage("active response"), fauxAssistantMessage("follow-up result")], 10);
    const prompt = runtime.prompt("start");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await runtime.followUp("check one more thing");
    await prompt;
    expect(store.listEvents(run.id).some((event) => event.type === "runtime.queue" && JSON.stringify(event.data.followUp).includes("check one more thing"))).toBe(true);
    expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "follow-up result" }] });
    runtime.dispose();
    store.close();
  });

  it("preserves current-turn thinking and full tool output for the immediate continuation", async () => {
    const path = `.tagent/tmp/current-turn-${Date.now()}.txt`;
    const fullOutput = "current tool output ".repeat(600);
    let continuationContext: Context | undefined;
    await writeFile(path, fullOutput);
    const { store, run, runtime } = await setup([
      fauxAssistantMessage([
        fauxThinking("signed current-turn reasoning"),
        { type: "toolCall", id: "current-read", name: "read", arguments: { path } },
      ], { stopReason: "toolUse" }),
      (context) => { continuationContext = context; return fauxAssistantMessage("used full output"); },
    ]);
    try {
      await runtime.prompt("inspect the current file");
      const assistant = continuationContext?.messages.find((message) => message.role === "assistant");
      const toolResult = continuationContext?.messages.find((message) => message.role === "toolResult");
      expect(assistant?.content).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "thinking", thinking: "signed current-turn reasoning" }),
      ]));
      expect(toolResult && toolResult.role === "toolResult" ? toolResult.content[0] : undefined)
        .toMatchObject({ type: "text", text: fullOutput });
      expect(store.listTranscript(run.id).find((message) => message.role === "toolResult"))
        .toMatchObject({ content: [{ type: "text", text: fullOutput }] });
    } finally {
      runtime.dispose();
      store.close();
      await rm(path, { force: true });
    }
  });


  it("validates tool arguments before execution", async () => {
    const { store, run, runtime } = await setup([
      fauxAssistantMessage([{ type: "toolCall", id: "invalid-read", name: "read", arguments: { path: 42 } }], { stopReason: "toolUse" }),
      fauxAssistantMessage("invalid input handled"),
    ]);
    await runtime.prompt("validate");
    expect(store.listTranscript(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "toolResult", toolCallId: "invalid-read", isError: true }),
    ]));
    expect(store.listOperations(run.id)).toHaveLength(0);
    runtime.dispose();
    store.close();
  });

  it("does not execute tool calls from token-truncated assistant output", async () => {
    const path = `.tagent/tmp/truncated-${Date.now()}.txt`;
    const { store, run, runtime } = await setup([
      fauxAssistantMessage([{ type: "toolCall", id: "truncated-write", name: "write", arguments: { path, content: "unsafe" } }], { stopReason: "length" }),
      fauxAssistantMessage("reissued safely without the truncated write"),
    ]);
    await runtime.prompt("truncate");
    expect(existsSync(path)).toBe(false);
    expect(store.listTranscript(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "toolResult", toolCallId: "truncated-write", isError: true }),
    ]));
    expect(store.listOperations(run.id)).toHaveLength(0);
    runtime.dispose();
    store.close();
  });

  it("executes a batch sequentially when it contains a mutation tool and preserves result order", async () => {
    const path = `.tagent/tmp/sequential-${Date.now()}.txt`;
    const { store, run, runtime } = await setup([
      fauxAssistantMessage([
        { type: "toolCall", id: "ordered-write", name: "write", arguments: { path, content: "ordered" } },
        { type: "toolCall", id: "ordered-read", name: "read", arguments: { path } },
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("ordered batch complete"),
    ]);
    try {
      await runtime.prompt("ordered tools");
      expect(await readFile(path, "utf8")).toBe("ordered");
      const results = store.listTranscript(run.id).filter((message) => message.role === "toolResult");
      expect(results.map((message) => message.role === "toolResult" ? message.toolCallId : "")).toEqual(["ordered-write", "ordered-read"]);
      expect(results[1]).toMatchObject({ role: "toolResult", isError: false, content: [{ type: "text", text: "ordered" }] });
    } finally {
      runtime.dispose();
      store.close();
      await rm(path, { force: true });
    }
  });


  it("aborts an active turn, compacts, and resumes for manual compaction", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-manual-compact", contextWindow: 32_000, maxTokens: 2_000 }], tokensPerSecond: 10 });
    faux.setResponses([
      fauxAssistantMessage("active answer that will be interrupted"),
      fauxAssistantMessage("manual compaction summary"),
      fauxAssistantMessage("continued after manual compaction"),
    ]);
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "manual compaction");
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), models: fauxModels(faux), initialMessages: [], providerMaxRetries: 0 }));
    const prompt = runtime.prompt("start long work");
    for (let index = 0; index < 100 && !store.listEvents(run.id).some((event) => event.type === "message.started"); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await runtime.compact("Preserve unresolved work and completed side effects.");
    await prompt;
    expect(runtime.getError()).toBeUndefined();
    expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "continued after manual compaction" }] });
    expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "context.compaction.started", data: expect.objectContaining({ reason: "manual" }) }),
      expect.objectContaining({ type: "context.compaction.completed", data: expect.objectContaining({ reason: "manual", aborted: false }) }),
    ]));
    expect(runtime.getMessages().some((message) => message.role === "assistant" && message.stopReason === "aborted")).toBe(false);
    expect(JSON.stringify(store.listTranscript(run.id))).not.toContain("TAgent internal continuation");
    expect(store.listEvents(run.id).filter((event) => event.type === "message.completed")).toHaveLength(1);
    runtime.dispose();
    store.close();
  });

  it("interrupts provider retry backoff for manual compaction and resumes", async () => {
    const { faux, store, run, runtime } = await setup([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service unavailable" }),
      fauxAssistantMessage("manual retry summary"),
      fauxAssistantMessage("continued after retry compaction"),
    ]);
    const prompt = runtime.prompt("retry then compact");
    for (let index = 0; index < 100 && !store.listEvents(run.id).some((event) => event.type === "provider.retry"); index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await runtime.compact("Preserve the request while replacing retry backoff.");
    await prompt;
    expect(faux.state.callCount).toBe(3);
    expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "continued after retry compaction" }] });
    expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "provider.retry.completed", data: expect.objectContaining({ success: false, finalError: "Retry superseded by manual compaction" }) }),
      expect.objectContaining({ type: "context.compaction.completed", data: expect.objectContaining({ reason: "manual", aborted: false }) }),
    ]));
    runtime.dispose();
    store.close();
  });

  it("automatically compacts after a successful turn crosses the context threshold", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-compact", contextWindow: 17_000, maxTokens: 2_000 }] });
    const first = fauxAssistantMessage("large completed result");
    first.usage = { ...first.usage, input: 2_000, output: 15_000, totalTokens: 17_000 };
    faux.setResponses([first, fauxAssistantMessage("automatic summary")]);
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "automatic compaction");
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), models: fauxModels(faux), initialMessages: [], providerMaxRetries: 0 }));
    await runtime.prompt("compact after this turn");
    const events = store.listEvents(run.id);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "context.compaction.started", data: expect.objectContaining({ reason: "threshold" }) }),
      expect.objectContaining({ type: "context.compaction.completed", data: expect.objectContaining({ reason: "threshold", aborted: false }) }),
    ]));
    expect(faux.state.callCount).toBe(2);
    runtime.dispose();
    store.close();
  });

  it("delivers follow-up accepted while automatic compaction is running", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-compact-follow-up", contextWindow: 17_000, maxTokens: 2_000 }] });
    const first = fauxAssistantMessage("large completed result");
    first.usage = { ...first.usage, input: 2_000, output: 15_000, totalTokens: 17_000 };
    let releaseSummary!: () => void;
    const summaryGate = new Promise<void>((resolve) => { releaseSummary = resolve; });
    faux.setResponses([
      first,
      async () => { await summaryGate; return fauxAssistantMessage("automatic summary"); },
      fauxAssistantMessage("follow-up after compaction"),
      fauxAssistantMessage("post-follow-up summary"),
    ]);
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "automatic compaction follow-up");
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), models: fauxModels(faux), initialMessages: [], providerMaxRetries: 0 }));
    const prompt = runtime.prompt("compact and keep listening");
    try {
      for (let index = 0; index < 100 && !store.listEvents(run.id).some((event) => event.type === "context.compaction.started"); index += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(runtime.followUp("queued during compaction")).resolves.toBe("accepted");
      releaseSummary();
      await prompt;
      expect(faux.state.callCount).toBe(4);
      expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "follow-up after compaction" }] });
      expect(store.listTranscript(run.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "user", content: [{ type: "text", text: "queued during compaction" }] }),
      ]));
      expect(store.listEvents(run.id).filter((event) => event.type === "runtime.settled")).toHaveLength(1);
    } finally {
      releaseSummary();
      await prompt.catch(() => undefined);
      runtime.dispose();
      store.close();
    }
  });


  it("compacts before a new turn when restored history already crosses the threshold", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-precompact", contextWindow: 100_000, maxTokens: 2_000 }] });
    const historical = fauxAssistantMessage("large restored response".repeat(12_000));
    historical.usage = { ...historical.usage, input: 60_000, output: 30_000, totalTokens: 90_000 };
    faux.setResponses([fauxAssistantMessage("restored summary"), fauxAssistantMessage("answer after pre-compaction")]);
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "pre-turn compaction");
    const runtime = new PiRuntime(runtimeSpec(store, run, {
      workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), models: fauxModels(faux), providerMaxRetries: 0,
      initialMessages: [{ role: "user", content: "historical request", timestamp: 1 }, historical],
    }));
    await runtime.prompt("continue after restore");
    expect(faux.state.callCount).toBe(3);
    expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "answer after pre-compaction" }] });
    expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "context.compaction.started", data: expect.objectContaining({ reason: "threshold" }) }),
    ]));
    runtime.dispose();
    store.close();
  });

  it("continues the completed turn when automatic threshold compaction fails", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-compact-failure", contextWindow: 17_000, maxTokens: 2_000 }] });
    const first = fauxAssistantMessage("completed despite compaction failure");
    first.usage = { ...first.usage, input: 2_000, output: 15_000, totalTokens: 17_000 };
    faux.setResponses([first, fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 summary unavailable" })]);
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "compaction failure");
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), models: fauxModels(faux), initialMessages: [], providerMaxRetries: 0 }));
    await expect(runtime.prompt("finish first")).resolves.toBeUndefined();
    expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "completed despite compaction failure" }] });
    expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "context.compaction.completed", data: expect.objectContaining({ reason: "threshold", error: expect.any(String) }) }),
      expect.objectContaining({ type: "message.completed", data: expect.objectContaining({ content: "completed despite compaction failure" }) }),
    ]));
    runtime.dispose();
    store.close();
  });

  it("compacts and retries once after a provider context overflow", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-overflow", contextWindow: 100_000, maxTokens: 2_000 }] });
    const historical = fauxAssistantMessage("historical response".repeat(12_000));
    historical.usage = { ...historical.usage, input: 20_000, output: 10_000, totalTokens: 30_000 };
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "Your input exceeds the context window of this model" }),
      fauxAssistantMessage("overflow summary"),
      fauxAssistantMessage("recovered after compaction"),
    ]);
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "overflow recovery");
    const runtime = new PiRuntime(runtimeSpec(store, run, {
      workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), models: fauxModels(faux), providerMaxRetries: 0,
      initialMessages: [{ role: "user", content: "historical request", timestamp: 1 }, historical],
    }));
    await runtime.prompt("continue");
    expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "recovered after compaction" }] });
    expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "context.compaction.started", data: expect.objectContaining({ reason: "overflow" }) }),
      expect.objectContaining({ type: "context.compaction.completed", data: expect.objectContaining({ reason: "overflow", willRetry: true }) }),
    ]));
    expect(faux.state.callCount).toBe(3);
    expect(runtime.getMessages().some((message) => message.role === "assistant" && message.stopReason === "error")).toBe(false);
    expect(JSON.stringify(store.listTranscript(run.id))).not.toContain("TAgent internal continuation");
    runtime.dispose();
    store.close();
  });

  it("keeps a successful answer when reported input usage triggers overflow compaction", async () => {
    let callCount = 0;
    const server = createServer((_request, response) => {
      callCount += 1;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const content = callCount === 1 ? "successful oversized answer" : "overflow summary";
      const promptTokens = callCount === 1 ? 33_000 : 100;
      response.end([
        `data: {"id":"chatcmpl-overflow","object":"chat.completion.chunk","created":1,"model":"overflow-model","choices":[{"index":0,"delta":{"role":"assistant","content":${JSON.stringify(content)}},"finish_reason":null}]}`,
        `data: {"id":"chatcmpl-overflow","object":"chat.completion.chunk","created":1,"model":"overflow-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":${promptTokens},"completion_tokens":2,"total_tokens":${promptTokens + 2}}}`,
        "data: [DONE]",
        "",
      ].join("\n\n"));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "successful overflow compaction");
    const model: Model<"openai-completions"> = {
      id: "overflow-model", name: "overflow-model", api: "openai-completions", provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000,
    };
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model, apiKey: "test-runtime-key", initialMessages: [], providerMaxRetries: 0, providerTimeoutMs: 1_000 }));
    try {
      await runtime.prompt("oversized input ".repeat(10_000));
      expect(callCount).toBe(2);
      expect(runtime.getError()).toBeUndefined();
      expect(runtime.getMessages()).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "successful oversized answer" }] }),
      ]));
      expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "context.compaction.completed", data: expect.objectContaining({ reason: "overflow", willRetry: false }) }),
      ]));
    } finally {
      runtime.dispose();
      store.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("keeps typed final provider failure audit after SDK retries are exhausted", async () => {
    const { store, run, runtime } = await setup([fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 Unauthorized" })]);
    await runtime.prompt("fail");
    expect(store.listEvents(run.id).filter((event) => event.type === "provider.failure")).toEqual(expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ retryable: false }) })]));
    runtime.dispose();
    store.close();
  });

  it("registers an unknown OpenAI-compatible provider before applying its runtime key", async () => {
    let authorization = "";
    let payload: Record<string, unknown> = {};
    const server = createServer((request, response) => {
      authorization = request.headers.authorization ?? "";
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"custom-model","choices":[{"index":0,"delta":{"role":"assistant","content":"custom ready"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"custom-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}',
          "data: [DONE]",
          "",
        ].join("\n\n"));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "custom provider");
    const model: Model<"openai-completions"> = {
      id: "custom-model", name: "custom-model", api: "openai-completions", provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000,
    };
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model, apiKey: "test-runtime-key", initialMessages: [], providerMaxRetries: 0 }));
    try {
      await runtime.prompt("hello");
      expect(authorization).toBe("Bearer test-runtime-key");
      expect(payload).not.toHaveProperty("store");
      expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "custom ready" }] });
    } finally {
      runtime.dispose();
      store.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("aborts an OpenAI-compatible response body after the configured idle interval", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"id":"chatcmpl-idle","object":"chat.completion.chunk","created":1,"model":"idle-model","choices":[{"index":0,"delta":{"role":"assistant","content":"partial"},"finish_reason":null}]}\n\n');
      setTimeout(() => response.end("data: [DONE]\n\n"), 250).unref();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "idle provider");
    const model: Model<"openai-completions"> = {
      id: "idle-model", name: "idle-model", api: "openai-completions", provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000,
    };
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model, apiKey: "test-runtime-key", initialMessages: [], providerMaxRetries: 0, providerTimeoutMs: 30 }));
    const startedAt = Date.now();
    try {
      await runtime.prompt("wait for stalled body");
      expect(Date.now() - startedAt).toBeLessThan(200);
      expect(runtime.getError()).toMatch(/idle|timed out|timeout/i);
    } finally {
      runtime.dispose();
      store.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("keeps a provider stream alive while body chunks continue arriving", async () => {
    let streamTimer: ReturnType<typeof setInterval> | undefined;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"id":"chatcmpl-active","object":"chat.completion.chunk","created":1,"model":"active-model","choices":[{"index":0,"delta":{"role":"assistant","content":"0"},"finish_reason":null}]}\n\n');
      let chunk = 0;
      streamTimer = setInterval(() => {
        chunk += 1;
        if (chunk <= 6) {
          response.write(`data: {"id":"chatcmpl-active","object":"chat.completion.chunk","created":1,"model":"active-model","choices":[{"index":0,"delta":{"content":"${chunk}"},"finish_reason":null}]}\n\n`);
          return;
        }
        clearInterval(streamTimer);
        streamTimer = undefined;
        response.end([
          'data: {"id":"chatcmpl-active","object":"chat.completion.chunk","created":1,"model":"active-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":7,"total_tokens":9}}',
          "data: [DONE]",
          "",
        ].join("\n\n"));
      }, 100);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "active provider stream");
    const model: Model<"openai-completions"> = {
      id: "active-model", name: "active-model", api: "openai-completions", provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000,
    };
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model, apiKey: "test-runtime-key", initialMessages: [], providerMaxRetries: 0, providerTimeoutMs: 500 }));
    const startedAt = Date.now();
    try {
      await runtime.prompt("read the active stream");
      expect(Date.now() - startedAt).toBeGreaterThan(500);
      expect(runtime.getError()).toBeUndefined();
      expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "0123456" }] });
    } finally {
      if (streamTimer) clearInterval(streamTimer);
      runtime.dispose();
      store.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("aborts an OpenAI-compatible request when response headers remain idle", async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end("data: [DONE]\n\n");
      }, 250).unref();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "idle provider headers");
    const model: Model<"openai-completions"> = {
      id: "idle-header-model", name: "idle-header-model", api: "openai-completions", provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000,
    };
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model, apiKey: "test-runtime-key", initialMessages: [], providerMaxRetries: 0, providerTimeoutMs: 30 }));
    const startedAt = Date.now();
    try {
      await runtime.prompt("wait for stalled headers");
      expect(Date.now() - startedAt).toBeLessThan(200);
      expect(runtime.getError()).toMatch(/idle|timed out|timeout/i);
      expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "provider.failure", data: expect.objectContaining({ kind: "timeout" }) }),
      ]));
    } finally {
      runtime.dispose();
      store.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("aborts an in-flight compaction provider request", async () => {
    let providerEntered!: () => void;
    const entered = new Promise<void>((resolve) => { providerEntered = resolve; });
    const server = createServer(() => { providerEntered(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "abort compaction provider");
    const model: Model<"openai-completions"> = {
      id: "compact-abort-model", name: "compact-abort-model", api: "openai-completions", provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 2_000,
    };
    const historical = fauxAssistantMessage("historical response".repeat(12_000));
    historical.usage = { ...historical.usage, input: 20_000, output: 10_000, totalTokens: 30_000 };
    const runtime = new PiRuntime(runtimeSpec(store, run, {
      workspace: process.cwd(), systemPrompt: "Controlled prompt", model, apiKey: "test-runtime-key", providerTimeoutMs: 5_000, providerMaxRetries: 0,
      initialMessages: [{ role: "user", content: "historical request", timestamp: 1 }, historical],
    }));
    const compaction = runtime.compact("Preserve unresolved work.");
    try {
      await entered;
      const startedAt = Date.now();
      await runtime.abort();
      expect(Date.now() - startedAt).toBeLessThan(200);
      await expect(compaction).rejects.toThrow();
      expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "context.compaction.completed", data: expect.objectContaining({ aborted: true }) }),
      ]));
    } finally {
      await compaction.catch(() => undefined);
      runtime.dispose();
      store.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("retries the primary model before consuming a rate-limit fallback", async () => {
    const faux = fauxProvider({ models: [{ id: "primary", contextWindow: 32_000, maxTokens: 2_000 }, { id: "fallback", contextWindow: 32_000, maxTokens: 2_000 }] });
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 rate limit exceeded" }),
      fauxAssistantMessage("primary recovered"),
    ]);
    const store = new Store(":memory:"); const session = store.createSession(); const run = store.createRun(session.id, "primary retry before fallback");
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel("primary")!, fallbackModels: [faux.getModel("fallback")!], models: fauxModels(faux), providerMaxRetries: 1 }));
    await runtime.prompt("hello");
    expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", model: "primary", content: [{ type: "text", text: "primary recovered" }] });
    expect(store.listEvents(run.id).some((event) => event.type === "provider.fallback")).toBe(false);
    runtime.dispose(); store.close();
  });
  it("switches to the next configured model after a rate-limit failure", async () => {
    const faux = fauxProvider({ models: [{ id: "primary", contextWindow: 32_000, maxTokens: 2_000 }, { id: "fallback", contextWindow: 32_000, maxTokens: 2_000 }] });
    faux.setResponses([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 rate limit exceeded" }),
      fauxAssistantMessage("fallback recovered"),
    ]);
    const store = new Store(":memory:"); const session = store.createSession(); const run = store.createRun(session.id, "fallback");
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel("primary")!, fallbackModels: [faux.getModel("fallback")!], models: fauxModels(faux), providerMaxRetries: 0 }));
    await runtime.prompt("hello");
    expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", model: "fallback", content: [{ type: "text", text: "fallback recovered" }] });
    expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([expect.objectContaining({ type: "provider.fallback", data: expect.objectContaining({ previousModel: "primary", model: "fallback" }) })]));
    expect(runtime.getMessages().some((message) => message.role === "assistant" && message.stopReason === "error")).toBe(false);
    expect(JSON.stringify(store.listTranscript(run.id))).not.toContain("TAgent internal continuation");
    runtime.dispose(); store.close();
  });

});
