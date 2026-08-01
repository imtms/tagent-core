import { runtimeRunContext, utf8Bytes } from "../src/core/llm-payload.js";
import type { TaskRun } from "../src/core/types.js";

const run = {
  id: "measure", sessionId: "session", requestId: "request", status: "running", phase: "implement", goal: "fix payload", contract: { sourceInput: "S".repeat(50_000), summary: "fix payload", objectives: [], acceptanceCriteria: ["verified"], scope: "code", nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent", intent: "new_task", decisionReason: "D".repeat(30_000), routerVersion: "test" }, gateRequired: true, blockedReason: "", lastEventSeq: 0, createdAt: 0, updatedAt: 0, completedAt: null, attempt: 1, resumedAt: null, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, transcriptCount: 0, checkpoint: { runId: "measure", attempt: 1, active: true, assistantPartial: "P".repeat(40_000), currentTool: null, lastEventSeq: 0, lastTranscriptSeq: 0, updatedAt: 0 }, continuations: [], plan: [], checks: [], artifacts: [{ id: "artifact", runId: "measure", kind: "report", title: "report", content: "A".repeat(30_000), uri: "", createdAt: 0 }], completionGate: { passed: false, failures: [] }, supervision: { latestDecision: null, latestGates: [], progress: null, spawnProposals: [], approvalRequests: [], latestContextManifest: null }, launchRetryable: false,
} as TaskRun;
const before = utf8Bytes(JSON.stringify(run));
const after = utf8Bytes(JSON.stringify(runtimeRunContext(run)));
console.log(JSON.stringify({ beforeBytes: before, afterBytes: after, reductionBytes: before - after, reductionPercent: Number((((before - after) / before) * 100).toFixed(1)) }, null, 2));
