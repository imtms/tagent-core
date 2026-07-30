import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { AgentService } from "../src/core/agent-service.js";
import { Store } from "../src/store/store.js";
import type { AgentRuntime, RuntimeFactory } from "../src/runtime/types.js";

class FakeRuntime implements AgentRuntime {
  aborted = false;
  steered: string[] = [];
  constructor(private readonly messages: AgentMessage[]) {}
  async prompt() {}
  steer(instruction: string) { this.steered.push(instruction); }
  abort() { this.aborted = true; }
  getMessages() { return this.messages; }
  getError() { return undefined; }
}

describe("AgentService runtime boundary", () => {
  it("constructs agents through the injected runtime factory", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const runtime = new FakeRuntime([{ role: "assistant", content: [{ type: "text", text: "done" }], api: "openai-completions", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() }]);
    const factory: RuntimeFactory = vi.fn(() => runtime);
    const service = new AgentService(store, "/tmp", factory);
    const run = await service.start(session.id, "test factory");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(factory).toHaveBeenCalledOnce();
    expect(store.getRun(run.id)?.status).toBe("blocked");
    store.close();
  });
});
