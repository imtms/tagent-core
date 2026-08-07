/* global console */
import { ContextAssembler, estimateMessageTokens } from "../packages/execution/dist/composition.js";

function assistant(content, timestamp) {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "benchmark",
    model: "benchmark",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "toolUse",
    timestamp,
  };
}

function toolResult(toolCallId, toolName, text, details, timestamp) {
  return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], details, isError: false, timestamp };
}

const messages = [];
for (let index = 0; index < 10; index += 1) {
  const taskCall = `task-${index}`;
  const bashCall = `bash-${index}`;
  messages.push({ role: "user", content: `turn ${index}`, timestamp: index * 10 });
  messages.push(assistant([
    { type: "toolCall", id: taskCall, name: "task_run", arguments: { action: "check", key: `check-${index}`, title: `Check ${index}`, evidence: "E".repeat(5_000) } },
    { type: "toolCall", id: bashCall, name: "bash", arguments: { command: `npm test -- --case=${index} ${"x".repeat(5_000)}` } },
  ], index * 10 + 1));
  messages.push(toolResult(taskCall, "task_run", JSON.stringify({ ok: true, action: "check", status: "running", phase: "verify", counts: { plan: 8, checks: 16, artifacts: 4 }, completionGate: { passed: false, failures: [{ key: `check-${index}`, reason: "pending" }] }, padding: "R".repeat(8_000) }), {}, index * 10 + 2));
  messages.push(toolResult(bashCall, "bash", `HEAD-${index}\n${"L".repeat(15_000)}\nTAIL-${index}`, { artifactUri: `artifact://bash-${index}` }, index * 10 + 3));
}

function measure(historicalToolResultChars, historicalTaskRunReceiptChars) {
  const result = new ContextAssembler({ contextWindow: 1_000_000, maxOutputTokens: 4_000, maxTurns: 20, historicalToolResultChars, historicalTaskRunReceiptChars }).assemble("transcript", messages, "system", "continue");
  return {
    messages: result.messages.length,
    chars: JSON.stringify(result.messages).length,
    estimatedTokens: result.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0),
    compressedTurns: result.stats.compressedTurns,
  };
}

const before = measure(8_000, 8_000);
const after = measure(4_000, 600);
const reduction = (key) => Number((((before[key] - after[key]) / before[key]) * 100).toFixed(1));
const taskRunMutations = 12;
const batchRoundTrips = 2;
console.log(JSON.stringify({
  scenario: { turns: 10, taskRunReceipts: 10, bashResults: 10 },
  context: { before, after, charReductionPercent: reduction("chars"), estimatedTokenReductionPercent: reduction("estimatedTokens") },
  taskRunRoundTrips: { before: taskRunMutations, after: batchRoundTrips, reductionPercent: Number((((taskRunMutations - batchRoundTrips) / taskRunMutations) * 100).toFixed(1)) },
}, null, 2));
