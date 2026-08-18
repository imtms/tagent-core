import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createModels, type Context, type Model } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxThinking } from "@earendil-works/pi-ai/providers/faux";
import { PiRuntime, providerRetryDelayMs, type PiRuntimeOptions } from "@tagent/runtime-pi";
import { deliverDeferredControls } from "../adapters/runtime-pi/src/pi-runtime.js";
import { Store } from "@tagent/persistence-sqlite/store";
import { createRuntimeHost } from "@tagent/core-service/composition";
import { attemptIdFor, canonicalRequestJson, requestHash, type AttemptRequestEnvelope } from "@tagent/execution/domain";
import { credentialReference, type AttemptRequestEnvelopeRepository } from "@tagent/execution/ports";
import { corePersistence } from "./support/test-persistence.js";
import { RunEventProbe } from "./support/event-probe.js";
import { seededWireFaultScript, WireFaultServer, type WireFaultStep } from "./support/wire-fault-server.js";

describe("Pi AgentHarness integration", () => {
  const testCredential = (value: string) => ({
    reference: credentialReference("TEST_API_KEY"),
    resolver: { resolve: () => value, configured: () => Boolean(value) },
  });

  it("bounds provider retry backoff by watchdog budgets and Node timer limits", () => {
    expect(providerRetryDelayMs(1, 1_200_000, 86_400_000)).toBe(1_000);
    expect(providerRetryDelayMs(12, 1_200_000, 86_400_000)).toBe(1_199_999);
    expect(providerRetryDelayMs(23)).toBe(2_147_483_647);
    expect(providerRetryDelayMs(1_000, 1_200_000, 86_400_000)).toBe(1_199_999);
    expect(providerRetryDelayMs(1, 10_000, 10_000, 5_000)).toBe(5_000);
    expect(providerRetryDelayMs(1, 1_200, 10_000, 5_000)).toBe(1_199);
  });
  it("preserves deferred steer and follow-up delivery modes in queue order", async () => {
    const delivered: Array<{ mode: "steer" | "followUp"; instruction: string }> = [];
    const controls = [
      { mode: "steer" as const, instruction: "correct the current answer" },
      { mode: "followUp" as const, instruction: "then do the next task" },
    ];
    await deliverDeferredControls(controls, {
      steer: async (instruction: string) => { delivered.push({ mode: "steer", instruction }); },
      followUp: async (instruction: string) => { delivered.push({ mode: "followUp", instruction }); },
    } as never);
    expect(delivered).toEqual([
      { mode: "steer", instruction: "correct the current answer" },
      { mode: "followUp", instruction: "then do the next task" },
    ]);
    expect(controls).toEqual([]);
  });
  function fauxModels(faux: ReturnType<typeof fauxProvider>) {
    const models = createModels();
    models.setProvider(faux.provider);
    return models;
  }
  function runtimeSpec(
    store: Store,
    run: ReturnType<Store["createRun"]>,
    options: Omit<PiRuntimeOptions, "token" | "capabilities" | "eventSink">,
    onEvent: (event: import("@tagent/execution/domain").RunEvent) => void = () => undefined,
  ): PiRuntimeOptions {
    const attempt = corePersistence(store).attempts.getAttemptForRun(run.id, run.attempt)!;
    const ownerId = `pi-test:${run.id}`;
    const lease = corePersistence(store).attempts.acquireExecutionLease({ attemptId: attempt.id, expectedVersion: attempt.version, ownerId, leaseMs: 30_000 });
    const token = {
      runId: run.id, attemptId: attemptIdFor(run.id, run.attempt), ordinal: run.attempt,
      expectedVersion: attempt.version, ownerId, leaseToken: lease.token, executionFence: lease.fence,
    };
    const host = createRuntimeHost({
      persistence: corePersistence(store), token, workspace: options.workspace,
      onActivity: () => undefined, onEvent,
      memoryScopeId: "test", memorySubjectId: `session:${run.sessionId}`,
    });
    const eventSink = {
      ...host.eventSink,
      afterToolCall(input: Parameters<typeof host.eventSink.afterToolCall>[0]) {
        host.eventSink.afterToolCall(input);
        if (input.toolName === "bash") void host.dispose();
      },
    };
    return { ...options, token, capabilities: host.capabilities, eventSink, requestEnvelopes: corePersistence(store).requestEnvelopes };
  }

  async function setup(responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0], tokensPerSecond = 10_000, runtimeOverrides: Partial<PiRuntimeOptions> = {}) {
    const faux = fauxProvider({ models: [{ id: "faux-session", contextWindow: 32_000, maxTokens: 2_000 }], tokensPerSecond });
    faux.setResponses(responses);
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "sdk session");
    const eventProbe = new RunEventProbe();
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), models: fauxModels(faux), initialMessages: [], providerMaxRetries: 1, ...runtimeOverrides }, eventProbe.observe));
    return { faux, store, run, runtime, eventProbe };
  }

  it("runs offline with controlled resources and persists the SDK transcript", async () => {
    const { store, run, runtime } = await setup([fauxAssistantMessage("session ready")]);
    await runtime.prompt("hello");
    expect(runtime.getActiveToolNames().sort()).toEqual(["bash", "edit", "history_search", "ls", "patch", "read", "task_run", "write"]);
    expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "session ready" }] });
    expect(store.listTranscript(run.id).some((message) => message.role === "assistant")).toBe(true);
    expect(store.listEvents(run.id).some((event) => event.type === "message.completed")).toBe(true);
    await runtime.dispose();
    store.close();
  });

  it("refreshes Core dynamic context as the final provider message without persisting it", async () => {
    const observed: Context[] = [];
    let dynamicContext = "<TAGENT_CORE_RUNTIME_CONTEXT>phase=discover</TAGENT_CORE_RUNTIME_CONTEXT>";
    const faux = fauxProvider({ models: [{ id: "faux-dynamic", contextWindow: 32_000, maxTokens: 2_000 }] });
    faux.setResponses([
      (context) => {
        observed.push(context);
        dynamicContext = "<TAGENT_CORE_RUNTIME_CONTEXT>phase=implement</TAGENT_CORE_RUNTIME_CONTEXT>";
        return fauxAssistantMessage([{ type: "toolCall", id: "dynamic-history", name: "history_search", arguments: { query: "no-match" } }], { stopReason: "toolUse" });
      },
      (context) => { observed.push(context); return fauxAssistantMessage("dynamic context refreshed"); },
    ]);
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "dynamic tail");
    const runtime = new PiRuntime(runtimeSpec(store, run, {
      workspace: process.cwd(), systemPrompt: "Stable system prefix", model: faux.getModel(), models: fauxModels(faux),
      initialMessages: [], providerMaxRetries: 0, dynamicContext: () => dynamicContext,
    }));

    await runtime.prompt("inspect dynamic tail");
    const tailText = (context: Context) => {
      const tail = context.messages.at(-1);
      return tail?.role === "user"
        ? typeof tail.content === "string" ? tail.content : tail.content.filter((part) => part.type === "text").map((part) => part.text).join("")
        : "";
    };
    expect(observed).toHaveLength(2);
    expect(tailText(observed[0])).toContain("phase=discover");
    expect(tailText(observed[1])).toContain("phase=implement");
    expect(JSON.stringify(observed[1].messages.at(-1))).toContain("TAGENT_CORE_RUNTIME_CONTEXT");
    expect(JSON.stringify(store.listTranscript(run.id))).not.toContain("TAGENT_CORE_RUNTIME_CONTEXT");
    await runtime.dispose();
    store.close();
  });

  it("recalls bounded same-Run durable history through the real Pi tool path", async () => {
    const marker = "receipt:op_%_pi_literal";
    const { store, run, runtime } = await setup([
      fauxAssistantMessage([{ type: "toolCall", id: "history-pi", name: "history_search", arguments: { query: marker } }], { stopReason: "toolUse" }),
      fauxAssistantMessage("history recalled"),
    ]);
    store.appendTranscript(run.id, run.attempt, { role: "user", content: `Durable earlier fact ${marker}`, timestamp: 1 });
    await runtime.prompt("Find the exact earlier receipt.");
    const result = store.listTranscript(run.id).find((message) => message.role === "toolResult" && message.toolCallId === "history-pi");
    expect(result).toMatchObject({ role: "toolResult", isError: false });
    const text = result?.role === "toolResult"
      ? result.content.filter((part) => part.type === "text").map((part) => part.text).join("")
      : "";
    expect(JSON.parse(text)).toMatchObject({
      query: marker,
      semantics: "case-sensitive literal",
      matches: [expect.objectContaining({ seq: 1, role: "user", snippet: expect.stringContaining(marker) })],
      truncated: false,
    });
    expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "history recalled" }] });
    await runtime.dispose();
    store.close();
  });

  it("registers and explicitly invokes a Core-selected Skill through AgentHarness.skill", async () => {
    let observedUserPrompt = "";
    const faux = fauxProvider({ models: [{ id: "faux-skill", contextWindow: 32_000, maxTokens: 2_000 }] });
    faux.setResponses([(context) => {
      const user = [...context.messages].reverse().find((message) => message.role === "user");
      observedUserPrompt = user?.role === "user"
        ? typeof user.content === "string" ? user.content : user.content.filter((part) => part.type === "text").map((part) => part.text).join("")
        : "";
      return fauxAssistantMessage("skill complete");
    }]);
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "invoke selected skill");
    const runtime = new PiRuntime(runtimeSpec(store, run, {
      workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), models: fauxModels(faux),
      initialMessages: [], providerMaxRetries: 0,
      skills: [{ name: "release-check", description: "Verify a release", content: "Follow the release checklist exactly.", filePath: ".tagent/skills/release-check/abc/SKILL.md", sha256: "a".repeat(64) }],
      selectedSkillName: "release-check",
    }));
    await runtime.invokeSkill("release-check", "Check version 1.2.3");
    expect(observedUserPrompt).toContain('<skill name="release-check" location=".tagent/skills/release-check/abc/SKILL.md">');
    expect(observedUserPrompt).toContain("Follow the release checklist exactly.");
    expect(observedUserPrompt).toContain("Check version 1.2.3");
    expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "skill.invoked", data: expect.objectContaining({ name: "release-check", sha256: "a".repeat(64) }) }),
    ]));
    await runtime.dispose();
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
    await runtime.dispose();
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
    await runtime.dispose();
    store.close();
  });

  it("does not emit completion or provider failure events after a Run is cancelled", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-cancel", contextWindow: 32_000, maxTokens: 2_000 }], tokensPerSecond: 10 });
    faux.setResponses([fauxAssistantMessage("late response")]);
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "cancel events");
    const eventProbe = new RunEventProbe();
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), models: fauxModels(faux), initialMessages: [] }, eventProbe.observe));
    const prompt = runtime.prompt("start");
    await eventProbe.waitFor("message.started");
    store.transitionRun(run.id, ["running"], "cancelled", "run.cancelled", {}, "Cancelled by user");
    await runtime.abort();
    await prompt;
    const eventTypes = store.listEvents(run.id).map((event) => event.type);
    expect(eventTypes).not.toContain("message.completed");
    expect(eventTypes).not.toContain("message.retrying");
    expect(eventTypes).not.toContain("provider.failure");
    expect(store.listTranscript(run.id).some((message) => message.role === "assistant" && message.stopReason === "aborted")).toBe(false);
    await runtime.dispose();
    store.close();
  });

  it("uses abort semantics when disposed during an active response", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-dispose", contextWindow: 32_000, maxTokens: 2_000 }], tokensPerSecond: 10 });
    faux.setResponses([fauxAssistantMessage("late response")]);
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "dispose active response");
    const eventProbe = new RunEventProbe();
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), models: fauxModels(faux), initialMessages: [] }, eventProbe.observe));
    const prompt = runtime.prompt("start");
    await eventProbe.waitFor("message.started");
    await runtime.dispose();
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
    faux.setResponses([fauxAssistantMessage([{ type: "toolCall", id: "slow-bash", name: "bash", arguments: { command: "printf ready; sleep 30" } }], { stopReason: "toolUse" })]);
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "abort active tool");
    const eventProbe = new RunEventProbe();
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), models: fauxModels(faux), initialMessages: [] }, eventProbe.observe));
    const prompt = runtime.prompt("start");
    await eventProbe.waitFor("tool.progress", (event) => event.data.toolCallId === "slow-bash");
    await runtime.abort();
    await prompt;
    await runtime.dispose();
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
    const eventProbe = new RunEventProbe();
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), models: fauxModels(faux), initialMessages: [] }, eventProbe.observe));
    const prompt = runtime.prompt("hello");
    await eventProbe.waitFor("message.started");
    await runtime.abort();
    await prompt;
    expect(runtime.getError()).toMatch(/abort/i);
    await runtime.dispose();
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
    await runtime.dispose();
    store.close();
  });

  it("does not retry before a provider window that exceeds the Attempt watchdog budget", async () => {
    const { faux, store, run, runtime } = await setup([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "429 rate limit exceeded; Retry-After: 5" }),
      fauxAssistantMessage("must not run inside this Attempt"),
    ], 10_000, { runTimeoutMs: 1_200, runHardTimeoutMs: 10_000 });
    await runtime.prompt("defer an oversized provider window");
    expect(faux.state.callCount).toBe(1);
    expect(runtime.getProviderFailure()).toEqual({ kind: "rate_limit", retryable: true, retryAfterMs: 5_000 });
    expect(store.listEvents(run.id).some((event) => event.type === "provider.retry")).toBe(false);
    await runtime.dispose();
    store.close();
  });


  it("keeps provider retry backoff abortable", async () => {
    const { faux, store, run, runtime, eventProbe } = await setup([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service unavailable" }),
      fauxAssistantMessage("must not retry after abort"),
    ]);
    const prompt = runtime.prompt("retry then cancel");
    await eventProbe.waitFor("provider.retry");
    const startedAt = Date.now();
    await runtime.abort();
    await prompt;
    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(faux.state.callCount).toBe(1);
    expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "provider.retry.completed", data: expect.objectContaining({ success: false, finalError: "Retry cancelled" }) }),
    ]));
    await runtime.dispose();
    store.close();
  });

  it("delivers steering accepted during provider retry backoff", async () => {
    let retryContext: Context | undefined;
    const { faux, store, run, runtime, eventProbe } = await setup([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service unavailable" }),
      (context) => { retryContext = context; return fauxAssistantMessage("steered retry recovered"); },
    ]);
    const prompt = runtime.prompt("retry then steer");
    await eventProbe.waitFor("provider.retry");
    await expect(runtime.steer("new direction during backoff")).resolves.toBe("accepted");
    await prompt;
    expect(faux.state.callCount).toBe(2);
    expect(JSON.stringify(retryContext?.messages)).toContain("new direction during backoff");
    expect(store.listTranscript(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "user", content: [{ type: "text", text: "new direction during backoff" }] }),
    ]));
    await runtime.dispose();
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
    await runtime.dispose();
    store.close();
  });

  it("uses the SDK steering queue while a response is streaming", async () => {
    const { store, run, runtime, eventProbe } = await setup([fauxAssistantMessage("a long streaming answer"), fauxAssistantMessage("steered result")], 10);
    const prompt = runtime.prompt("start");
    await eventProbe.waitFor("message.started");
    await runtime.steer("change direction");
    await prompt;
    expect(store.listEvents(run.id).some((event) => event.type === "runtime.queue" && JSON.stringify(event.data.steering).includes("change direction"))).toBe(true);
    expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "steered result" }] });
    await runtime.dispose();
    store.close();
  });

  it("uses Pi clearQueue when aborting and audits discarded pending input", async () => {
    const { store, run, runtime, eventProbe } = await setup([fauxAssistantMessage("a long streaming answer"), fauxAssistantMessage("must not run")], 10);
    const prompt = runtime.prompt("start");
    await eventProbe.waitFor("message.started");
    await expect(runtime.followUp("pending input")).resolves.toBe("accepted");
    await runtime.abort();
    await prompt;
    expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "runtime.queue.cleared", data: expect.objectContaining({ followUp: ["pending input"] }) }),
    ]));
    await runtime.dispose();
    store.close();
  });

  it("rejects steer and follow-up after Pi has settled instead of orphaning queue messages", async () => {
    const { store, run, runtime } = await setup([fauxAssistantMessage("settled")]);
    await runtime.prompt("start");
    await expect(runtime.steer("too late")).resolves.toBe("settled");
    await expect(runtime.followUp("also too late")).resolves.toBe("settled");
    expect(store.listEvents(run.id).filter((event) => event.type === "runtime.queue")).toHaveLength(0);
    await runtime.dispose();
    store.close();
  });

  it("uses the SDK follow-up queue after the active response settles", async () => {
    const { store, run, runtime, eventProbe } = await setup([fauxAssistantMessage("active response"), fauxAssistantMessage("follow-up result")], 10);
    const prompt = runtime.prompt("start");
    await eventProbe.waitFor("message.started");
    await runtime.followUp("check one more thing");
    await prompt;
    expect(store.listEvents(run.id).some((event) => event.type === "runtime.queue" && JSON.stringify(event.data.followUp).includes("check one more thing"))).toBe(true);
    expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "follow-up result" }] });
    await runtime.dispose();
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
      await runtime.dispose();
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
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "invalid-read",
        isError: true,
        error: { name: "ToolExecutionError", code: "PATH_REJECTED", message: expect.any(String) },
      }),
    ]));
    expect(store.listTranscriptView(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool", toolCallId: "invalid-read", error: expect.objectContaining({ code: "PATH_REJECTED" }) }),
    ]));
    expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool.completed", data: expect.objectContaining({ error: expect.objectContaining({ code: "PATH_REJECTED" }) }) }),
    ]));
    expect(store.listOperations(run.id)).toHaveLength(0);
    await runtime.dispose();
    store.close();
  });

  it("aborts the provider loop after a hard-approval guard makes the Run non-running", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-hard-approval", contextWindow: 32_000, maxTokens: 2_000 }] });
    faux.setResponses([
      fauxAssistantMessage([{ type: "toolCall", id: "approval-read", name: "read", arguments: { path: "README.md" } }], { stopReason: "toolUse" }),
      fauxAssistantMessage("must not continue before approval"),
    ]);
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "hard approval pause");
    const eventProbe = new RunEventProbe();
    const spec = runtimeSpec(store, run, {
      workspace: process.cwd(),
      systemPrompt: "Controlled prompt",
      model: faux.getModel(),
      models: fauxModels(faux),
      initialMessages: [],
    }, eventProbe.observe);
    let running = true;
    const eventSink = {
      ...spec.eventSink,
      beforeToolCall() {
        running = false;
        return { blocked: true, reason: "Hard approval requested" };
      },
      isRunning: () => running,
    };
    const runtime = new PiRuntime({ ...spec, eventSink });

    await runtime.prompt("request approval");

    expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool.guard.blocked", data: expect.objectContaining({ reason: "Hard approval requested" }) }),
    ]));
    expect(runtime.getMessages()).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "must not continue before approval" }] }),
    ]));
    expect(store.listEvents(run.id)).not.toContainEqual(expect.objectContaining({ type: "provider.failure" }));
    expect(store.listEvents(run.id)).not.toContainEqual(expect.objectContaining({ type: "message.completed" }));
    expect(runtime.getMessages()).not.toContainEqual(expect.objectContaining({
      role: "assistant",
      stopReason: expect.stringMatching(/^(?:aborted|error)$/),
    }));
    expect(runtime.getProviderFailure()).toBeUndefined();
    await runtime.dispose();
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
    await runtime.dispose();
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
      await runtime.dispose();
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
    const eventProbe = new RunEventProbe();
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), models: fauxModels(faux), initialMessages: [], providerMaxRetries: 0 }, eventProbe.observe));
    const prompt = runtime.prompt("start long work");
    await eventProbe.waitFor("message.started");
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
    await runtime.dispose();
    store.close();
  });

  it("interrupts provider retry backoff for manual compaction and resumes", async () => {
    const { faux, store, run, runtime, eventProbe } = await setup([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service unavailable" }),
      fauxAssistantMessage("manual retry summary"),
      fauxAssistantMessage("continued after retry compaction"),
    ]);
    const prompt = runtime.prompt("retry then compact");
    await eventProbe.waitFor("provider.retry");
    await runtime.compact("Preserve the request while replacing retry backoff.");
    await prompt;
    expect(faux.state.callCount).toBe(3);
    expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "continued after retry compaction" }] });
    expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "provider.retry.completed", data: expect.objectContaining({ success: false, finalError: "Retry superseded by manual compaction" }) }),
      expect.objectContaining({ type: "context.compaction.completed", data: expect.objectContaining({ reason: "manual", aborted: false }) }),
    ]));
    await runtime.dispose();
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
    await runtime.dispose();
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
    const eventProbe = new RunEventProbe();
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), models: fauxModels(faux), initialMessages: [], providerMaxRetries: 0 }, eventProbe.observe));
    const prompt = runtime.prompt("compact and keep listening");
    try {
      await eventProbe.waitFor("context.compaction.started");
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
      await runtime.dispose();
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
    await runtime.dispose();
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
    await runtime.dispose();
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
    await runtime.dispose();
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
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model, credential: testCredential("test-runtime-key"), initialMessages: [], providerMaxRetries: 0, providerTimeoutMs: 1_000 }));
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
      await runtime.dispose();
      store.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("keeps typed final provider failure audit after SDK retries are exhausted", async () => {
    const { store, run, runtime } = await setup([fauxAssistantMessage([], { stopReason: "error", errorMessage: "401 Unauthorized" })]);
    await runtime.prompt("fail");
    expect(store.listEvents(run.id).filter((event) => event.type === "provider.failure")).toEqual(expect.arrayContaining([expect.objectContaining({ data: expect.objectContaining({ retryable: false }) })]));
    await runtime.dispose();
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
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model, credential: testCredential("test-runtime-key"), initialMessages: [], providerMaxRetries: 0 }));
    try {
      await runtime.prompt("hello");
      expect(authorization).toBe("Bearer test-runtime-key");
      expect(payload).not.toHaveProperty("store");
      expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "custom ready" }] });
    } finally {
      await runtime.dispose();
      store.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("persists and verifies the exact provider request before network dispatch", async () => {
    let requestCount = 0;
    let receivedBody: unknown;
    let durableBeforeHandler: AttemptRequestEnvelope | undefined;
    const server = createServer((request, response) => {
      requestCount += 1;
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        durableBeforeHandler = persistence.requestEnvelopes.listForAttempt(attemptIdFor(run.id, 1))[0];
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          'data: {"id":"chatcmpl-envelope","object":"chat.completion.chunk","created":1,"model":"envelope-model","choices":[{"index":0,"delta":{"role":"assistant","content":"enveloped"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-envelope","object":"chat.completion.chunk","created":1,"model":"envelope-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}',
          "data: [DONE]",
          "",
        ].join("\n\n"));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");
    const store = new Store(":memory:");
    const persistence = corePersistence(store);
    const run = store.createRun(store.createSession().id, "durable envelope");
    const model: Model<"openai-completions"> = {
      id: "envelope-model", name: "envelope-model", api: "openai-completions", provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000,
    };
    const runtime = new PiRuntime(runtimeSpec(store, run, {
      workspace: process.cwd(), systemPrompt: "Envelope system", model, credential: testCredential("test-runtime-key"),
      initialMessages: [], providerMaxRetries: 0, dynamicContext: () => "<TAGENT_CORE_RUNTIME_CONTEXT>envelope-tail</TAGENT_CORE_RUNTIME_CONTEXT>",
    }));
    try {
      await runtime.prompt("persist me");
      const durable = persistence.requestEnvelopes.listForAttempt(attemptIdFor(run.id, 1));
      expect(requestCount).toBe(1);
      expect(durableBeforeHandler).toBeDefined();
      expect(durable).toHaveLength(1);
      expect(canonicalRequestJson(durable[0].providerPayload)).toBe(canonicalRequestJson(receivedBody));
      expect(durable[0]).toMatchObject({
        providerPayloadHash: requestHash(receivedBody),
        providerPayload: expect.objectContaining({ messages: expect.arrayContaining([
            expect.objectContaining({ role: "system", content: "Envelope system" }),
            expect.objectContaining({ role: "user", content: [expect.objectContaining({ type: "text", text: "persist me" })] }),
          ]) }),
      });
      const providerMessages = (durable[0].providerPayload as { messages: Array<{ role: string; content: unknown }> }).messages;
      expect(providerMessages.at(-1)).toMatchObject({ role: "user", content: [expect.objectContaining({ type: "text", text: expect.stringContaining("envelope-tail") })] });
      expect(JSON.stringify(store.listTranscript(run.id))).not.toContain("envelope-tail");
      expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "request.envelope.persisted", data: expect.objectContaining({ envelopeId: durable[0].id }) }),
      ]));
    } finally {
      await runtime.dispose();
      store.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("aborts before network dispatch when durable request verification mismatches", async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => { requestCount += 1; response.end(); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "mismatched envelope");
    const persisted = corePersistence(store).requestEnvelopes;
    const tamperingRepository: AttemptRequestEnvelopeRepository = {
      record: (envelope) => persisted.record(envelope),
      get: (id) => {
        const value = persisted.get(id);
        return value ? { ...value, envelopeHash: "0".repeat(64) } : undefined;
      },
      listForAttempt: (attemptId) => persisted.listForAttempt(attemptId),
    };
    const model: Model<"openai-completions"> = {
      id: "mismatch-model", name: "mismatch-model", api: "openai-completions", provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000,
    };
    const runtime = new PiRuntime({
      ...runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Mismatch", model, credential: testCredential("test-runtime-key"), initialMessages: [], providerMaxRetries: 0 }),
      requestEnvelopes: tamperingRepository,
    });
    try {
      await runtime.prompt("must not send");
      expect(requestCount).toBe(0);
      expect(runtime.getError()).toContain("does not match durable envelope");
    } finally {
      await runtime.dispose();
      store.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("preserves pi-ai compatibility detection for DeepSeek-style providers", async () => {
    let payload: {
      messages?: Array<Record<string, unknown>>;
      thinking?: unknown;
    } = {};
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof payload;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          'data: {"id":"chatcmpl-deepseek","object":"chat.completion.chunk","created":1,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{"role":"assistant","content":"deepseek ready"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-deepseek","object":"chat.completion.chunk","created":1,"model":"deepseek-reasoner","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
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
    const run = store.createRun(session.id, "deepseek provider compatibility");
    const model: Model<"openai-completions"> = {
      id: "deepseek-reasoner", name: "deepseek-reasoner", api: "openai-completions", provider: "deepseek",
      // Keep the real provider hostname in the local route so pi-ai exercises
      // both its provider-id and base-URL dialect detection without network I/O.
      baseUrl: `http://127.0.0.1:${address.port}/deepseek.com/v1`, reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000,
    };
    const runtime = new PiRuntime(runtimeSpec(store, run, {
      workspace: process.cwd(), systemPrompt: "Controlled prompt", model, credential: testCredential("test-runtime-key"), providerMaxRetries: 0,
      initialMessages: [{ role: "user", content: "historical request", timestamp: 1 }, fauxAssistantMessage("historical answer")],
    }));
    try {
      await runtime.prompt("continue");
      expect(payload.messages?.[0]).toMatchObject({ role: "system", content: "Controlled prompt" });
      expect(payload.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "assistant", content: "historical answer", reasoning_content: "" }),
      ]));
      expect(payload.thinking).toEqual({ type: "enabled" });
      expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "deepseek ready" }] });
    } finally {
      await runtime.dispose();
      store.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
  it("disables provider idle timeout when configured to zero", async () => {
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          'data: {"id":"chatcmpl-no-timeout","object":"chat.completion.chunk","created":1,"model":"no-timeout-model","choices":[{"index":0,"delta":{"role":"assistant","content":"delayed ready"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-no-timeout","object":"chat.completion.chunk","created":1,"model":"no-timeout-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}',
          "data: [DONE]",
          "",
        ].join("\n\n"));
      }, 50);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "disabled provider timeout");
    const model: Model<"openai-completions"> = {
      id: "no-timeout-model", name: "no-timeout-model", api: "openai-completions", provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000,
    };
    const runtime = new PiRuntime(runtimeSpec(store, run, {
      workspace: process.cwd(), systemPrompt: "Controlled prompt", model, credential: testCredential("test-runtime-key"),
      initialMessages: [], providerMaxRetries: 0, providerTimeoutMs: 0,
    }));
    try {
      await runtime.prompt("wait without an idle timeout");
      expect(runtime.getError()).toBeUndefined();
      expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "delayed ready" }] });
    } finally {
      await runtime.dispose();
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
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model, credential: testCredential("test-runtime-key"), initialMessages: [], providerMaxRetries: 0, providerTimeoutMs: 30 }));
    const startedAt = Date.now();
    try {
      await runtime.prompt("wait for stalled body");
      expect(Date.now() - startedAt).toBeLessThan(200);
      expect(runtime.getError()).toMatch(/idle|timed out|timeout/i);
    } finally {
      await runtime.dispose();
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
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model, credential: testCredential("test-runtime-key"), initialMessages: [], providerMaxRetries: 0, providerTimeoutMs: 500 }));
    const startedAt = Date.now();
    try {
      await runtime.prompt("read the active stream");
      expect(Date.now() - startedAt).toBeGreaterThan(500);
      expect(runtime.getError()).toBeUndefined();
      expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "0123456" }] });
    } finally {
      if (streamTimer) clearInterval(streamTimer);
      await runtime.dispose();
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
    const runtime = new PiRuntime(runtimeSpec(store, run, { workspace: process.cwd(), systemPrompt: "Controlled prompt", model, credential: testCredential("test-runtime-key"), initialMessages: [], providerMaxRetries: 0, providerTimeoutMs: 30 }));
    const startedAt = Date.now();
    try {
      await runtime.prompt("wait for stalled headers");
      expect(Date.now() - startedAt).toBeLessThan(200);
      expect(runtime.getError()).toMatch(/idle|timed out|timeout/i);
      expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "provider.failure", data: expect.objectContaining({ kind: "timeout" }) }),
      ]));
    } finally {
      await runtime.dispose();
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
      workspace: process.cwd(), systemPrompt: "Controlled prompt", model, credential: testCredential("test-runtime-key"), providerTimeoutMs: 5_000, providerMaxRetries: 0,
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
      await runtime.dispose();
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
    await runtime.dispose(); store.close();
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
    await runtime.dispose(); store.close();
  });

  it("builds reproducible seeded wire-fault scripts", () => {
    const candidates: WireFaultStep[] = [
      { kind: "reset_before_headers" },
      { kind: "malformed_sse" },
      { kind: "empty_completion" },
    ];
    expect(seededWireFaultScript(42, candidates, 12)).toEqual(seededWireFaultScript(42, candidates, 12));
    expect(seededWireFaultScript(42, candidates, 12)).not.toEqual(seededWireFaultScript(43, candidates, 12));
  });

  it("honors Retry-After for an inline provider retry", async () => {
    const wire = new WireFaultServer([
      { kind: "rate_limit", retryAfterSeconds: 1.2 },
      { kind: "success", content: "rate limit recovered" },
    ]);
    const baseUrl = await wire.start();
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, "provider Retry-After");
    const model: Model<"openai-completions"> = {
      id: "wire-model", name: "wire-model", api: "openai-completions", provider: "openai-compatible",
      baseUrl, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000,
    };
    const runtime = new PiRuntime(runtimeSpec(store, run, {
      workspace: process.cwd(), systemPrompt: "Controlled prompt", model,
      credential: testCredential("wire-test-key"), initialMessages: [],
      providerMaxRetries: 1, providerTimeoutMs: 5_000, runTimeoutMs: 5_000, runHardTimeoutMs: 10_000,
    }));
    try {
      await runtime.prompt("respect the provider window");
      expect(wire.requests).toHaveLength(2);
      expect(wire.requests[1].receivedAt - wire.requests[0].receivedAt).toBeGreaterThanOrEqual(1_150);
      expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "provider.failure", data: expect.objectContaining({ kind: "rate_limit", retryAfterMs: 1_200 }) }),
        expect.objectContaining({ type: "provider.retry", data: expect.objectContaining({ delayMs: 1_200 }) }),
      ]));
      expect(runtime.getMessages().at(-1)).toMatchObject({
        role: "assistant", content: [{ type: "text", text: "rate limit recovered" }],
      });
    } finally {
      await runtime.dispose();
      store.close();
      await wire.close();
    }
  });

  it.each([
    ["socket reset before headers", { kind: "reset_before_headers" }],
    ["partial SSE reset", { kind: "partial_sse_reset", content: "poison-partial-output" }],
    ["clean EOF without DONE", { kind: "clean_eof_without_done", content: "poison-incomplete-output" }],
    ["malformed SSE", { kind: "malformed_sse" }],
    ["empty completion", { kind: "empty_completion" }],
  ] satisfies Array<[string, WireFaultStep]>)("retries and isolates %s with byte-identical provider payloads", async (_label, fault) => {
    const wire = new WireFaultServer([fault, { kind: "success", content: "wire retry recovered" }]);
    const baseUrl = await wire.start();
    const store = new Store(":memory:");
    const run = store.createRun(store.createSession().id, `wire fault: ${fault.kind}`);
    const model: Model<"openai-completions"> = {
      id: "wire-model", name: "wire-model", api: "openai-completions", provider: "openai-compatible",
      baseUrl, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000,
    };
    const runtime = new PiRuntime(runtimeSpec(store, run, {
      workspace: process.cwd(), systemPrompt: "Wire fixture prompt", model,
      credential: testCredential("wire-test-key"), initialMessages: [],
      providerMaxRetries: 1, providerTimeoutMs: 1_000, runTimeoutMs: 20, runHardTimeoutMs: 40,
    }));
    try {
      await runtime.prompt("retry this exact request");
      expect(wire.requests).toHaveLength(2);
      expect(canonicalRequestJson(wire.requests[0].json)).toBe(canonicalRequestJson(wire.requests[1].json));
      expect(requestHash(wire.requests[0].json)).toBe(requestHash(wire.requests[1].json));
      expect(runtime.getMessages().at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "wire retry recovered" }],
      });
      expect(store.listEvents(run.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: "provider.retry" }),
        expect.objectContaining({ type: "provider.retry.completed", data: expect.objectContaining({ success: true }) }),
      ]));
      const durable = JSON.stringify(store.listTranscript(run.id));
      const retryBody = wire.requests[1].body;
      expect(durable).not.toContain("poison-partial-output");
      expect(durable).not.toContain("poison-incomplete-output");
      expect(retryBody).not.toContain("poison-partial-output");
      expect(retryBody).not.toContain("poison-incomplete-output");
      expect(store.listTranscript(run.id).filter((message) => message.role === "assistant")).toHaveLength(1);
      const envelopes = corePersistence(store).requestEnvelopes.listForAttempt(attemptIdFor(run.id, 1));
      expect(envelopes).toHaveLength(2);
      expect(envelopes[0].providerPayloadHash).toBe(envelopes[1].providerPayloadHash);
    } finally {
      await runtime.dispose();
      store.close();
      await wire.close();
    }
  });

});
