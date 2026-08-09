import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { createModels, type Model } from "@earendil-works/pi-ai";
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

  async function setup(responses: ReturnType<typeof fauxAssistantMessage>[], tokensPerSecond = 10_000) {
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
    const { faux, store, run, runtime } = await setup([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "503 Service unavailable" }),
      fauxAssistantMessage("recovered"),
    ]);
    await runtime.prompt("retry");
    expect(faux.state.callCount).toBe(2);
    expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "recovered" }] });
    expect(store.listEvents(run.id).some((event) => event.type === "provider.retry")).toBe(true);
    expect(store.listEvents(run.id).some((event) => event.type === "provider.retry.completed" && event.data.success === true)).toBe(true);
    expect(store.listEvents(run.id).filter((event) => event.type === "message.completed")).toHaveLength(1);
    expect(store.listEvents(run.id).some((event) => event.type === "message.retrying" && event.data.willRetry === true)).toBe(true);
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
    expect(store.listEvents(run.id).filter((event) => event.type === "message.completed")).toHaveLength(1);
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
    runtime.dispose();
    store.close();
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
    const server = createServer((request, response) => {
      authorization = request.headers.authorization ?? "";
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end([
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"custom-model","choices":[{"index":0,"delta":{"role":"assistant","content":"custom ready"},"finish_reason":null}]}',
        'data: {"id":"chatcmpl-test","object":"chat.completion.chunk","created":1,"model":"custom-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}',
        "data: [DONE]",
        "",
      ].join("\n\n"));
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
      expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "custom ready" }] });
    } finally {
      runtime.dispose();
      store.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
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
    runtime.dispose(); store.close();
  });

});
