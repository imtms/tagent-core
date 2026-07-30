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

describe("AgentService runtime boundary", () => {
  it("constructs agents through the injected runtime factory", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const runtime = new FakeRuntime([assistantMessage("done")]);
    const factory: RuntimeFactory = vi.fn(() => runtime);
    const service = new AgentService(store, "/tmp", factory);
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
    const factory = vi.fn<RuntimeFactory>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const service = new AgentService(store, "/tmp", factory);
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
    expect(second.prompts[0]).toContain("Resume this interrupted or blocked TaskRun");
    expect(second.prompts[0]).toContain("resume goal");
    expect(store.listMessages(session.id).filter((message) => message.role === "user")).toHaveLength(1);
    expect(store.listEvents(started.id).some((event) => event.type === "run.resumed" && event.data.attempt === 2)).toBe(true);
    store.close();
  });
});
