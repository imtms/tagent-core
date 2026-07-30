import { describe, expect, it } from "vitest";
import { Store } from "../src/store/store.js";
import { TaskRunSupervisor } from "../src/core/supervisor.js";

function failingEvent(runId: string, seq: number) {
  return { runId, seq, type: "tool.completed", data: { toolName: "bash", isError: true }, createdAt: Date.now() };
}

describe("TaskRunSupervisor", () => {
  it("issues a bounded steer after repeated checkpoint failures", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "recover from repeated failure");
    const supervisor = new TaskRunSupervisor(store, { repeatedFailureThreshold: 3, maxSteersPerAttempt: 1, minEventsBetweenInterventions: 1 });
    expect(supervisor.reviewCheckpoint(run.id, failingEvent(run.id, 1))).toBeUndefined();
    expect(supervisor.reviewCheckpoint(run.id, failingEvent(run.id, 2))).toBeUndefined();
    const decision = supervisor.reviewCheckpoint(run.id, failingEvent(run.id, 3));
    expect(decision).toMatchObject({ action: "steer", reasonCode: "repeated_tool_failures", attempt: 1, checkpointSeq: 3 });
    supervisor.markExecuted(decision!.id, "executed");
    expect(supervisor.reviewCheckpoint(run.id, failingEvent(run.id, 4))).toBeUndefined();
    store.close();
  });

  it("requires evidence for passed checks and chooses continuation", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "verified work");
    store.upsertPlanItem(run.id, { key: "work", title: "Work", status: "done", required: true, position: 1 });
    store.upsertCheck(run.id, { key: "test", title: "Test", status: "passed", required: true, command: "npm test", evidence: "", stale: false });
    const supervisor = new TaskRunSupervisor(store);
    const review = supervisor.reviewSettled(store.getRun(run.id)!, 10, "done");
    expect(review.decision.action).toBe("start_continuation");
    expect(review.gates.find((gate) => gate.gateType === "evidence")?.failures).toEqual([expect.objectContaining({ key: "test", disposition: "auto_fixable" })]);
    expect(store.getRun(run.id)?.supervision.latestDecision?.id).toBe(review.decision.id);
    store.close();
  });

  it("blocks rather than continuing when a required item needs user input", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "needs input");
    store.upsertPlanItem(run.id, { key: "credential", title: "Provide credential", status: "blocked", required: true, position: 1 });
    const review = new TaskRunSupervisor(store).reviewSettled(store.getRun(run.id)!, 5, "waiting");
    expect(review.decision).toMatchObject({ action: "block_taskrun", reasonCode: "human_or_external_dependency" });
    store.close();
  });

  it("does not spawn a non-parallel follow-up before the parent completes", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const parent = store.createRun(session.id, "active parent");
    const proposal = store.createSpawnProposal(parent.id, "follow-up", [], "follow_up");
    expect(store.spawnFromProposal(proposal.id)).toBeUndefined();
    expect(store.listSpawnProposals(parent.id)[0].status).toBe("proposed");
    store.close();
  });

  it("persists spawn proposals and creates an explicit TaskRun edge", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const parent = store.createRun(session.id, "implement feature");
    store.finalizeRun(parent.id, "completed");
    const proposal = store.createSpawnProposal(parent.id, "deploy feature", ["health check passes"], "follow_up");
    const child = store.spawnFromProposal(proposal.id)!;
    expect(child.goal).toBe("deploy feature");
    expect(store.listSpawnProposals(parent.id)[0]).toMatchObject({ status: "spawned", spawnedRunId: child.id });
    expect(store.listTaskRunEdges(parent.id)).toEqual([expect.objectContaining({ fromRunId: parent.id, toRunId: child.id, relation: "follow_up" })]);
    store.close();
  });
});
