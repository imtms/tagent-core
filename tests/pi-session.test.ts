import { describe, expect, it } from "vitest";
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
});
