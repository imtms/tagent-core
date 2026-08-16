/* global console */
import { Buffer } from "node:buffer";
import { performance } from "node:perf_hooks";
import { ContextAssembler, estimateMessageTokens } from "../packages/execution/dist/composition.js";
import { Store } from "../adapters/persistence-sqlite/dist/store.js";

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

function measureMilliseconds(operation, iterations) {
  operation();
  const startedAt = performance.now();
  for (let index = 0; index < iterations; index += 1) operation();
  return Number(((performance.now() - startedAt) / iterations).toFixed(3));
}

const store = new Store(":memory:");
const session = store.createSession("Performance benchmark");
let representativeRun;
for (let runIndex = 0; runIndex < 50; runIndex += 1) {
  const run = store.createRun(session.id, `benchmark run ${runIndex}`);
  representativeRun ??= run;
  for (let itemIndex = 0; itemIndex < 10; itemIndex += 1) {
    store.upsertPlanItem(run.id, { key: `plan-${itemIndex}`, title: `Plan ${itemIndex}`, status: "done", required: true, position: itemIndex });
    store.upsertCheck(run.id, { key: `check-${itemIndex}`, title: `Check ${itemIndex}`, status: "pending", required: true, command: "npm test", evidence: "", stale: false });
    store.addArtifact(run.id, { id: `artifact-${runIndex}-${itemIndex}`, title: `Artifact ${itemIndex}`, kind: "benchmark", content: "A".repeat(10_000), uri: "" });
  }
}
const fullRuns = store.listRuns(session.id, 50);
const runSummaries = store.listRunSummaries(session.id, 50);
const fullRunBytes = Buffer.byteLength(JSON.stringify(fullRuns));
const summaryBytes = Buffer.byteLength(JSON.stringify(runSummaries));
const fullRunHistoryMs = measureMilliseconds(() => JSON.stringify(store.listRuns(session.id, 50)), 3);
const summaryHistoryMs = measureMilliseconds(() => JSON.stringify(store.listRunSummaries(session.id, 50)), 50);
const fullRunStateMs = measureMilliseconds(() => store.getRun(representativeRun.id), 100);
const readRunViewMs = measureMilliseconds(() => store.getRunReadView(representativeRun.id), 500);
const executionStateMs = measureMilliseconds(() => store.getRunExecutionState(representativeRun.id), 1_000);

const transcriptRun = store.createRun(session.id, "transcript benchmark");
for (let index = 0; index < 1_000; index += 1) {
  store.appendTranscript(transcriptRun.id, 1, assistant([{ type: "text", text: `entry-${index}:${"T".repeat(4_000)}` }], index));
}
const fullTranscript = store.listTranscriptView(transcriptRun.id);
const transcriptDelta = store.listTranscriptView(transcriptRun.id, { after: 999, limit: 200 });
const fullTranscriptMs = measureMilliseconds(() => JSON.stringify(store.listTranscriptView(transcriptRun.id)), 3);
const transcriptDeltaMs = measureMilliseconds(() => JSON.stringify(store.listTranscriptView(transcriptRun.id, { after: 999, limit: 200 })), 100);
const transcriptCountScan = store.db.prepare("SELECT COUNT(*) as value FROM run_transcript WHERE run_id=?");
const transcriptSequenceLookup = store.db.prepare("SELECT COALESCE(MAX(seq),0) as value FROM run_transcript WHERE run_id=?");
const transcriptCountScanMs = measureMilliseconds(() => transcriptCountScan.get(transcriptRun.id), 500);
const transcriptSequenceLookupMs = measureMilliseconds(() => transcriptSequenceLookup.get(transcriptRun.id), 2_000);

const acknowledgementRun = store.createRun(session.id, "event acknowledgement benchmark");
const acknowledgementEventCount = 10_000;
const insertAcknowledgementEvent = store.db.prepare(
  "INSERT INTO run_events(run_id,seq,attempt_id,type,data,created_at) VALUES(?,?,?,?,?,?)",
);
store.db.transaction(() => {
  for (let sequence = 1; sequence <= acknowledgementEventCount; sequence += 1) {
    insertAcknowledgementEvent.run(acknowledgementRun.id, sequence, null, "message.delta", "{}", sequence);
  }
})();
const terminalTypes = ["run.completed", "run.blocked", "run.failed", "run.cancelled"];
const fullAcknowledgementScan = store.db.prepare(`SELECT seq FROM run_events WHERE run_id=? AND seq<=?
  AND type IN (?,?,?,?) ORDER BY seq DESC LIMIT 1`);
const incrementalAcknowledgementScan = store.db.prepare(`SELECT seq FROM run_events WHERE run_id=? AND seq>? AND seq<=?
  AND type IN (?,?,?,?) ORDER BY seq DESC LIMIT 1`);
const fullAcknowledgementMs = measureMilliseconds(
  () => fullAcknowledgementScan.get(acknowledgementRun.id, acknowledgementEventCount, ...terminalTypes),
  50,
);
const incrementalAcknowledgementMs = measureMilliseconds(
  () => incrementalAcknowledgementScan.get(
    acknowledgementRun.id,
    acknowledgementEventCount - 10,
    acknowledgementEventCount,
    ...terminalTypes,
  ),
  500,
);
const ratio = (beforeValue, afterValue) => Number((beforeValue / Math.max(afterValue, 0.000_001)).toFixed(1));

console.log(JSON.stringify({
  scenario: { turns: 10, taskRunReceipts: 10, bashResults: 10 },
  context: { before, after, charReductionPercent: reduction("chars"), estimatedTokenReductionPercent: reduction("estimatedTokens") },
  taskRunRoundTrips: { before: taskRunMutations, after: batchRoundTrips, reductionPercent: Number((((taskRunMutations - batchRoundTrips) / taskRunMutations) * 100).toFixed(1)) },
  wallClock: {
    runHistory: {
      fullMilliseconds: fullRunHistoryMs, summaryMilliseconds: summaryHistoryMs,
      speedup: ratio(fullRunHistoryMs, summaryHistoryMs), fullBytes: fullRunBytes, summaryBytes,
      byteReductionPercent: Number((((fullRunBytes - summaryBytes) / fullRunBytes) * 100).toFixed(1)),
    },
    toolExecutionState: {
      fullMilliseconds: fullRunStateMs, lightweightMilliseconds: executionStateMs,
      speedup: ratio(fullRunStateMs, executionStateMs),
    },
    runReadView: {
      fullMilliseconds: fullRunStateMs,
      metadataMilliseconds: readRunViewMs,
      speedup: ratio(fullRunStateMs, readRunViewMs),
      fullBytes: Buffer.byteLength(JSON.stringify(store.getRun(representativeRun.id))),
      metadataBytes: Buffer.byteLength(JSON.stringify(store.getRunReadView(representativeRun.id))),
    },
    transcriptUpdate: {
      fullMilliseconds: fullTranscriptMs, incrementalMilliseconds: transcriptDeltaMs,
      speedup: ratio(fullTranscriptMs, transcriptDeltaMs),
      fullBytes: Buffer.byteLength(JSON.stringify(fullTranscript)), incrementalBytes: Buffer.byteLength(JSON.stringify(transcriptDelta)),
    },
    transcriptCount: {
      entries: 1_000,
      fullCountMilliseconds: transcriptCountScanMs,
      lastSequenceMilliseconds: transcriptSequenceLookupMs,
      speedup: ratio(transcriptCountScanMs, transcriptSequenceLookupMs),
    },
    eventAcknowledgement: {
      events: acknowledgementEventCount,
      newlyAcknowledgedEvents: 10,
      fullHistoryMilliseconds: fullAcknowledgementMs,
      incrementalMilliseconds: incrementalAcknowledgementMs,
      speedup: ratio(fullAcknowledgementMs, incrementalAcknowledgementMs),
    },
  },
}, null, 2));
store.close();
