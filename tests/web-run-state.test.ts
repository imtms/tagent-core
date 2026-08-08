import { describe, expect, it } from "vitest";
import type { TaskRun } from "../apps/web-console/src/api.js";
import { canResumeRun, findActiveRun, isActiveRunStatus } from "../apps/web-console/src/run-state.js";

function taskRun(overrides: Partial<TaskRun> = {}): TaskRun {
  return {
    id: "run-1",
    sessionId: "session-1",
    requestId: "request-1",
    status: "interrupted",
    phase: "implement",
    goal: "Resume interrupted work",
    modelId: "gpt-5.6-sol",
    reasoningEffort: "high",
    contract: null,
    blockedReason: "Core restarted",
    lastEventSeq: 12,
    attempt: 1,
    resumedAt: null,
    createdAt: 1,
    updatedAt: 2,
    completedAt: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    transcriptCount: 0,
    checkpoint: null,
    continuations: [],
    plan: [],
    checks: [],
    userInputRequests: [],
    pendingUserInput: null,
    artifacts: [],
    completionGate: { passed: false, failures: [] },
    launchRetryable: false,
    resumable: true,
    supervision: { latestDecision: null, latestGates: [], progress: null, approvalRequests: [], latestContextManifest: null },
    ...overrides,
  };
}

describe("Web Run state projection", () => {
  it("treats interrupted Runs as inactive and exposes Resume when the backend marks them resumable", () => {
    const interrupted = taskRun();

    expect(isActiveRunStatus(interrupted.status)).toBe(false);
    expect(findActiveRun([interrupted])).toBeNull();
    expect(canResumeRun(interrupted, null)).toBe(true);
  });

  it("does not expose Resume while another Run is active or an approval is pending", () => {
    const interrupted = taskRun();
    const running = taskRun({ id: "run-2", status: "running", resumable: false });
    const awaitingApproval = taskRun({
      supervision: {
        ...interrupted.supervision,
        approvalRequests: [{ id: "approval-1", decisionId: "decision-1", actionType: "resume_taskrun", targetType: "taskrun", targetId: interrupted.id, reason: "Review required", metadata: {}, status: "pending", requestedAt: 1, resolvedAt: null, resolvedBy: "", resolution: "" }],
      },
    });

    expect(findActiveRun([interrupted, running])).toBe(running);
    expect(canResumeRun(interrupted, running)).toBe(false);
    expect(canResumeRun(awaitingApproval, null)).toBe(false);
  });
});
