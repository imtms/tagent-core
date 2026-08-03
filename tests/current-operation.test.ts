import { describe, expect, it } from "vitest";
import type { TaskRun } from "../web/src/api";
import { deriveCurrentOperation } from "../web/src/current-operation";

function run(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: "run-1", sessionId: "session-1", requestId: "request-1", status: "running", phase: "implement", goal: "test", modelId: "model",
    blockedReason: "", lastEventSeq: 2, attempt: 1, resumedAt: null, createdAt: 1_000, updatedAt: 2_000, completedAt: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, transcriptCount: 0,
    checkpoint: { runId: "run-1", attempt: 1, active: true, assistantPartial: "", currentTool: null, lastEventSeq: 2, lastTranscriptSeq: 0, updatedAt: 2_000 },
    continuations: [], plan: [], checks: [], artifacts: [], completionGate: { passed: false, failures: [] },
    supervision: { latestDecision: null, latestGates: [], progress: null, approvalRequests: [], latestContextManifest: null },
    ...overrides,
  };
}

describe("current operation state", () => {
  it("uses persisted tool timing without exposing tool arguments or output", () => {
    const current = deriveCurrentOperation(run({ checkpoint: {
      runId: "run-1", attempt: 1, active: true, assistantPartial: "", lastEventSeq: 4, lastTranscriptSeq: 0, updatedAt: 11_000,
      currentTool: { toolCallId: "call-1", toolName: "bash", startedAt: 10_000, lastActivityAt: 11_000 },
    } }), 20_000);
    expect(current).toEqual({ state: "running", toolName: "bash", startedAt: 10_000, lastActivityAt: 11_000 });
    expect(JSON.stringify(current)).not.toContain("secret");
  });

  it("marks a long inactive operation as waiting", () => {
    const current = deriveCurrentOperation(run({ checkpoint: {
      runId: "run-1", attempt: 1, active: true, assistantPartial: "", lastEventSeq: 4, lastTranscriptSeq: 0, updatedAt: 15_000,
      currentTool: { toolCallId: "call-1", toolName: "bash", startedAt: 1_000, lastActivityAt: 15_000 },
    } }), 31_000);
    expect(current.state).toBe("waiting");
  });

  it("only presents inactivity as possibly stalled and keeps backend status untouched", () => {
    const source = run({ checkpoint: {
      runId: "run-1", attempt: 1, active: true, assistantPartial: "", lastEventSeq: 4, lastTranscriptSeq: 0, updatedAt: 1_000,
      currentTool: { toolCallId: "call-1", toolName: "bash", startedAt: 1_000, lastActivityAt: 1_000 },
    } });
    expect(deriveCurrentOperation(source, 121_001).state).toBe("stalled");
    expect(source.status).toBe("running");
  });

  it.each([
    ["interrupted", "interrupted"], ["cancelled", "interrupted"], ["completed", "completed"], ["failed", "failed"], ["blocked", "blocked"],
  ])("maps terminal run status %s to %s", (status, expected) => {
    expect(deriveCurrentOperation(run({ status, completedAt: 3_000 }), 99_000).state).toBe(expected);
  });
});
