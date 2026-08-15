import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeMessage as AgentMessage } from "@tagent/execution/ports";
import type { AttemptRuntimePort } from "@tagent/execution/ports";
import { settleRuntimeInitializationFailure } from "../packages/execution/src/application/runtime-initialization-failure.js";
import { AgentService } from "@tagent/core-service/application";
import {
  TestSupervisorReviewer,
  type SupervisorAudit,
} from "@tagent/core-service/composition";
import { Store } from "@tagent/persistence-sqlite/store";
import { agentPersistence } from "./support/test-persistence.js";

const stores: Store[] = [];

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
});

function assistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function blockedAudit(): SupervisorAudit {
  const reason = "Required evidence is missing.";
  const failure = {
    kind: "evidence",
    key: "verification",
    reason,
    disposition: "auto_fixable" as const,
  };
  const failed = { passed: false, failures: [failure], summary: reason };
  const passed = { passed: true, failures: [], summary: "Passed." };
  return {
    action: "start_continuation",
    reasonCode: "missing_evidence",
    rationale: reason,
    confidence: 1,
    gates: {
      progress: passed,
      evidence: failed,
      contract: failed,
      completion: failed,
      continuation: passed,
    },
  };
}

class ControlledRuntime implements AttemptRuntimePort {
  private resolvePrompt?: () => void;

  prompt() {
    return new Promise<void>((resolve) => { this.resolvePrompt = resolve; });
  }

  async steer() { return "accepted" as const; }
  abort() { this.resolvePrompt?.(); }
  async dispose() { await this.abort(); }
  resolve() { this.resolvePrompt?.(); }
  getMessages() { return [assistantMessage("Candidate response")]; }
  getError() { return undefined; }
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for TaskRun settlement");
}

describe("TaskRun transition caller publishing", () => {
  it("publishes the atomic message rejection before the blocked terminal event", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const runtime = new ControlledRuntime();
    const service = new AgentService(agentPersistence(store), "/tmp", () => runtime, {
      maxContinuations: 0,
      supervisorReviewer: new TestSupervisorReviewer([blockedAudit()]),
    });
    const run = await service.start(store.createSession().id, "publish blocked transition in order");
    const published: string[] = [];
    const unsubscribe = service.subscribe(run.id, (event) => published.push(event.type));

    runtime.resolve();
    await waitFor(() => store.getRun(run.id)?.status === "blocked");

    expect(published.filter((type) => type === "message.rejected" || type === "run.blocked"))
      .toEqual(["message.rejected", "run.blocked"]);
    expect(store.listEvents(run.id)
      .filter((event) => event.type === "message.rejected" || event.type === "run.blocked")
      .map((event) => event.type))
      .toEqual(["message.rejected", "run.blocked"]);

    unsubscribe();
    await service.closeRuntimes();
  });

  it("does not record an inbox launch error when the authoritative runtime transition fails", () => {
    const store = new Store(":memory:");
    stores.push(store);
    const persistence = agentPersistence(store);
    const session = persistence.sessions.createSession();
    const item = persistence.submissions.enqueueSessionInbox(session.id, "initialize", {
      summary: "initialize",
      objectives: [],
      intent: "new_task",
      targetRunId: null,
      priority: 500,
      urgency: "normal",
      relation: "independent",
      acceptanceCriteria: [],
      scope: "initialize",
      nonGoals: [],
      confidence: 1,
      reason: "test",
      routerVersion: "test",
    });
    const claimed = persistence.submissions.claimSessionInboxNow(item.id, session.id);
    if (claimed.status !== "started") throw new Error("Inbox fixture did not start");
    const attempt = persistence.attempts.getActiveAttempt(claimed.run.id)!;
    const lease = persistence.attempts.acquireExecutionLease({
      attemptId: attempt.id,
      expectedVersion: attempt.version,
      ownerId: "runtime-initialization-test",
      leaseMs: 30_000,
    });
    const attemptLaunchFailed = vi.fn((input: { inboxItemId: string; runId: string; message: string }) => {
      persistence.submissions.recordSessionInboxLaunchFailure(input.inboxItemId, input.runId, input.message);
    });
    const published: string[] = [];

    expect(() => settleRuntimeInitializationFailure({
      closing: false,
      run: claimed.run,
      token: {
        runId: claimed.run.id,
        attemptId: attempt.id,
        ordinal: attempt.ordinal,
        expectedVersion: attempt.version,
        ownerId: "runtime-initialization-test",
        leaseToken: lease.token,
        executionFence: lease.fence,
      },
      launchOptions: { inboxItemId: item.id },
      error: new Error("runtime initialization failed"),
      persistence: {
        taskRuns: persistence.taskRuns,
        taskRunTransitions: {
          transitionRuntime() { throw new Error("authoritative transition unavailable"); },
          transitionSystem: persistence.taskRunTransitions.transitionSystem,
        },
      },
      settlement: {
        execute: async () => false,
        projectWorkflowExperience() {},
        recoverInterruptedAttempt: () => false,
      },
      postAttempt: { attemptLaunchFailed, attemptFinalized() {} },
      eventHub: {
        publish: (event) => { published.push(event.type); },
        updateCheckpoint() {},
        flushCheckpoint() {},
      },
    })).toThrow("authoritative transition unavailable");
    expect(attemptLaunchFailed).not.toHaveBeenCalled();
    expect(persistence.submissions.getSessionInboxItem(item.id)).toMatchObject({ error: "" });
    expect(persistence.taskRuns.getRun(claimed.run.id)).toMatchObject({ status: "running" });
    expect(published).toEqual([]);
  });
});
