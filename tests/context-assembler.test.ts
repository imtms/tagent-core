import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ContextAssembler, estimateTextTokens } from "@tagent/execution/composition";

function assistant(text: string, content?: Extract<AgentMessage, { role: "assistant" }>["content"]): AgentMessage {
  return {
    role: "assistant",
    content: content ?? [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

describe("ContextAssembler", () => {
  it("estimates CJK text more conservatively than ASCII text", () => {
    expect(estimateTextTokens("中文中文中文中文")).toBeGreaterThan(estimateTextTokens("abcdefgh"));
  });

  it("reports context usage without enforcing a Core token budget", () => {
    const result = new ContextAssembler({ contextWindow: 20_000, maxOutputTokens: 4_000, maxTurns: 10 }).assemble("session", [], "S".repeat(400), "Q".repeat(200));
    expect(result.stats).toMatchObject({ contextWindow: 20_000, originalMessages: 0, keptMessages: 0 });
    expect(result.stats).not.toHaveProperty("messageBudgetTokens");
  });

  it("preserves stable durable source IDs through selection and omission", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "old", timestamp: 1 }, assistant("old answer"),
      { role: "user", content: "new", timestamp: 2 }, assistant("new answer"),
    ];
    const result = new ContextAssembler({ contextWindow: 50_000, maxOutputTokens: 1_000, maxTurns: 1 })
      .assemble("session", messages, "system", "prompt", ["message:10", "message:11", "message:12", "message:13"]);
    expect(result.contextItems.filter((item) => item.selected).map((item) => item.sourceId)).toEqual(["message:12", "message:13"]);
    expect(result.contextItems.filter((item) => !item.selected).map((item) => item.sourceId)).toEqual(["message:10", "message:11"]);
  });

  it("keeps original source IDs when a tool-heavy turn is compressed", () => {
    const result = new ContextAssembler({ contextWindow: 2_500, maxOutputTokens: 500, maxTurns: 20 })
      .assemble("transcript", [{ role: "user", content: "question", timestamp: 1 }, assistant("final", [
        { type: "thinking", thinking: "R".repeat(2_000) },
        { type: "toolCall", id: "call-1", name: "write", arguments: { content: "X".repeat(8_000) } },
        { type: "text", text: "final" },
      ])], "system", "prompt", ["transcript:run-1:7", "transcript:run-1:8"]);
    expect(result.contextItems.map((item) => item.sourceId)).toEqual(["transcript:run-1:7", "transcript:run-1:8"]);
  });

  it("enforces the maximum complete-turn limit", () => {
    const messages: AgentMessage[] = [];
    for (let index = 0; index < 5; index += 1) messages.push({ role: "user", content: `u${index}`, timestamp: index }, assistant(`a${index}`));
    const result = new ContextAssembler({ contextWindow: 50_000, maxOutputTokens: 1_000, maxTurns: 3 })
      .assemble("session", messages, "system", "prompt");
    expect(result.messages).toHaveLength(6);
    expect(result.messages[0]).toMatchObject({ role: "user", content: "u2" });
    expect(result.stats).toMatchObject({ originalTurns: 5, keptTurns: 3, droppedTurns: 2 });
    expect(result.contextItems.filter((item) => item.selected)).toHaveLength(6);
    expect(result.contextItems.filter((item) => !item.selected)).toHaveLength(4);
    expect(result.contextItems.find((item) => !item.selected)?.reason).toContain("turn limit");
  });

  it("preserves the selected recent turn while observing its token use", () => {
    const messages = [
      { role: "user", content: "do work", timestamp: 1 },
      assistant("final answer", [{ type: "thinking", thinking: "R".repeat(2_000) }, { type: "toolCall", id: "call-1", name: "write", arguments: { content: "X".repeat(5_000) } }, { type: "text", text: "final answer" }]),
    ] as AgentMessage[];
    const result = new ContextAssembler({ contextWindow: 1_000, maxOutputTokens: 100, maxTurns: 1 }).assemble("transcript", messages, "system", "prompt");
    expect(result.messages).toHaveLength(2);
    expect(result.stats.keptTurns).toBe(1);
    expect(result.stats.estimatedMessageTokens).toBeGreaterThan(1_000);
  });
});

describe("historical tool-result projection", () => {
  const toolResult = (text: string, toolCallId = "call-1", timestamp = 2): AgentMessage => ({
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    details: {},
    isError: false,
    timestamp,
  });

  it("truncates old tool results while preserving the latest turn", () => {
    const large = "X".repeat(20_000);
    const messages: AgentMessage[] = [
      { role: "user", content: "old", timestamp: 1 }, assistant("calling", [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }]), toolResult(large),
      { role: "user", content: "latest", timestamp: 3 }, assistant("calling latest", [{ type: "toolCall", id: "call-2", name: "read", arguments: {} }]), toolResult(large, "call-2", 4),
    ];
    const result = new ContextAssembler({ contextWindow: 100_000, maxOutputTokens: 1_000, maxTurns: 10, historicalToolResultChars: 1_000 }).assemble("transcript", messages, "system", "prompt");
    const oldResult = result.messages[2] as Extract<AgentMessage, { role: "toolResult" }>;
    const latestResult = result.messages[5] as Extract<AgentMessage, { role: "toolResult" }>;
    expect(oldResult.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Historical tool result truncated") });
    expect((latestResult.content[0] as { type: "text"; text: string }).text).toHaveLength(20_000);
  });
  it("drops older turns that exceed the effective context window", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "old ".repeat(500), timestamp: 1 }, assistant("old answer ".repeat(500)),
      { role: "user", content: "latest", timestamp: 2 }, assistant("latest answer"),
    ];
    const result = new ContextAssembler({ contextWindow: 500, maxOutputTokens: 100, maxTurns: 10 }).assemble("transcript", messages, "system", "continue");
    expect(result.messages[0]).toMatchObject({ role: "user", content: "latest" });
    expect(result.stats.droppedTurns).toBe(1);
  });

});
