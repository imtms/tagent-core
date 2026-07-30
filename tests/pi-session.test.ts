import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiRuntime } from "../src/runtime/pi-runtime.js";
import { Store } from "../src/store/store.js";

describe("Pi 0.83 AgentSession integration", () => {
  async function setup(responses: ReturnType<typeof fauxAssistantMessage>[], tokensPerSecond = 10_000) {
    const faux = fauxProvider({ models: [{ id: "faux-session", contextWindow: 32_000, maxTokens: 2_000 }], tokensPerSecond });
    faux.setResponses(responses);
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "sdk session");
    const runtime = new PiRuntime({ store, runId: run.id, workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), modelRuntime, initialMessages: [], providerMaxRetries: 1 });
    return { faux, store, run, runtime };
  }

  it("runs offline with controlled resources and persists the SDK transcript", async () => {
    const { store, run, runtime } = await setup([fauxAssistantMessage("session ready")]);
    await runtime.prompt("hello");
    expect(runtime.getActiveToolNames().sort()).toEqual(["bash", "edit", "ls", "read", "task_run", "write"]);
    expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "session ready" }] });
    expect(store.listTranscript(run.id).some((message) => message.role === "assistant")).toBe(true);
    expect(store.listEvents(run.id).some((event) => event.type === "message.completed")).toBe(true);
    runtime.dispose();
    store.close();
  });

  it("settles an active tool attempt before disposing an aborted session", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-abort", contextWindow: 32_000, maxTokens: 2_000 }] });
    faux.setResponses([fauxAssistantMessage([{ type: "toolCall", id: "slow-bash", name: "bash", arguments: { command: "sleep 30" } }], { stopReason: "toolUse" })]);
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "abort active tool");
    const runtime = new PiRuntime({ store, runId: run.id, workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), modelRuntime, initialMessages: [] });
    const prompt = runtime.prompt("start");
    for (let index = 0; index < 100 && !store.listEvents(run.id).some((event) => event.type === "tool.started"); index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    await runtime.abort();
    await prompt;
    runtime.dispose();
    expect(store.db.prepare("SELECT status FROM tool_attempts WHERE run_id = ? AND tool_call_id = 'slow-bash'").get(run.id)).toMatchObject({ status: "failed" });
    expect(store.listOperations(run.id)[0]).toMatchObject({ status: "failed", stage: "execution_failed" });
    store.close();
  });

  it("honors abort requested while the session is still initializing", async () => {
    const faux = fauxProvider({ models: [{ id: "faux-init", contextWindow: 32_000, maxTokens: 2_000 }] });
    faux.setResponses([fauxAssistantMessage("must not run")]);
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const originalRefresh = modelRuntime.refresh.bind(modelRuntime);
    modelRuntime.refresh = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return originalRefresh(...args);
    };
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "abort initialization");
    const runtime = new PiRuntime({ store, runId: run.id, workspace: process.cwd(), systemPrompt: "Controlled prompt", model: faux.getModel(), modelRuntime, initialMessages: [] });
    const prompt = runtime.prompt("hello");
    await runtime.abort();
    await expect(prompt).rejects.toThrow("Runtime aborted");
    expect(faux.state.callCount).toBe(0);
    runtime.dispose();
    store.close();
  });

  it("surfaces SDK auto-retry lifecycle events and succeeds on the next attempt", async () => {
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
    const modelRuntime = await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "custom provider");
    const model = {
      id: "custom-model", name: "custom-model", api: "openai-completions" as const, provider: "openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`, reasoning: false, input: ["text"] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_000, maxTokens: 2_000,
    };
    const runtime = new PiRuntime({ store, runId: run.id, workspace: process.cwd(), systemPrompt: "Controlled prompt", model, modelRuntime, apiKey: "test-runtime-key", initialMessages: [], providerMaxRetries: 0 });
    try {
      await runtime.prompt("hello");
      expect(modelRuntime.getProvider(model.provider)).toBeDefined();
      expect((await modelRuntime.getAuth(model))?.auth.apiKey).toBe("test-runtime-key");
      expect(authorization).toBe("Bearer test-runtime-key");
      expect(runtime.getMessages().at(-1)).toMatchObject({ role: "assistant", content: [{ type: "text", text: "custom ready" }] });
    } finally {
      runtime.dispose();
      store.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
