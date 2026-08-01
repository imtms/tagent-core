import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ContextAssembler, estimateTextTokens } from "../src/core/context-assembler.js";

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

  it("subtracts system, prompt, model output, and safety reserves", () => {
    const result = new ContextAssembler({ contextWindow: 20_000, maxOutputTokens: 4_000, maxTurns: 20, reserveTokens: 2_000 })
      .assemble("session", [], "S".repeat(400), "Q".repeat(200));
    expect(result.stats).toMatchObject({ contextWindow: 20_000, outputReserveTokens: 4_000, safetyReserveTokens: 2_000 });
    expect(result.stats.messageBudgetTokens).toBe(20_000 - result.stats.systemTokens - result.stats.promptTokens - 4_000 - 2_000);
  });

  it("enforces the maximum complete-turn limit", () => {
    const messages: AgentMessage[] = [];
    for (let index = 0; index < 5; index += 1) messages.push({ role: "user", content: `u${index}`, timestamp: index }, assistant(`a${index}`));
    const result = new ContextAssembler({ contextWindow: 50_000, maxOutputTokens: 1_000, maxTurns: 3, reserveTokens: 1_000 })
      .assemble("session", messages, "system", "prompt");
    expect(result.messages).toHaveLength(6);
    expect(result.messages[0]).toMatchObject({ role: "user", content: "u2" });
    expect(result.stats).toMatchObject({ originalTurns: 5, keptTurns: 3, droppedTurns: 2 });
    expect(result.contextItems.filter((item) => item.selected)).toHaveLength(6);
    expect(result.contextItems.filter((item) => !item.selected)).toHaveLength(4);
    expect(result.contextItems.find((item) => !item.selected)?.reason).toContain("budget");
  });

  it("compresses a tool-heavy turn to user and final assistant text before dropping it", () => {
    const toolHeavy = assistant("", [
      { type: "thinking", thinking: "R".repeat(2_000) },
      { type: "toolCall", id: "call-1", name: "write", arguments: { content: "X".repeat(8_000) } },
      { type: "text", text: "final answer" },
    ]);
    const messages: AgentMessage[] = [{ role: "user", content: "keep this question", timestamp: 1 }, toolHeavy];
    const result = new ContextAssembler({ contextWindow: 2_500, maxOutputTokens: 500, maxTurns: 20, reserveTokens: 500 })
      .assemble("transcript", messages, "system", "prompt");
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toMatchObject({ role: "assistant", content: [{ type: "text", text: "final answer" }] });
    expect(result.stats.compressedTurns).toBe(1);
    expect(JSON.stringify(result.messages)).not.toContain("toolCall");
  });
});
