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

  it("deduplicates a proposed steer before delivery completes", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "dedupe steer");
    const supervisor = new TaskRunSupervisor(store, { repeatedFailureThreshold: 1, maxSteersPerAttempt: 1, minEventsBetweenInterventions: 1 });
    expect(supervisor.reviewCheckpoint(run.id, failingEvent(run.id, 1))).toMatchObject({ action: "steer", status: "proposed" });
    expect(supervisor.reviewCheckpoint(run.id, failingEvent(run.id, 2))).toBeUndefined();
    expect(store.listSupervisorDecisions(run.id)).toHaveLength(1);
    store.close();
  });

  it("does not let message completion erase tool failures before settled review", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "failed then answered");
    for (let seq = 1; seq <= 6; seq += 1) store.updateProgressSnapshot(run, failingEvent(run.id, seq));
    const snapshot = store.updateProgressSnapshot(run, { runId: run.id, seq: 7, type: "message.completed", data: { content: "I am done" }, createdAt: Date.now() });
    expect(snapshot).toMatchObject({ meaningfulChanges: 0, consecutiveFailures: 6 });
    const review = new TaskRunSupervisor(store).reviewSettled(store.getRun(run.id)!, 7, "I am done");
    expect(review.decision).toMatchObject({ action: "block_taskrun", reasonCode: "continuation_not_viable" });
    expect(review.gates.find((gate) => gate.gateType === "progress")?.passed).toBe(false);
    store.close();
  });

  it("does not treat a successful read as meaningful progress or reset failures", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "progress semantics");
    store.updateProgressSnapshot(run, failingEvent(run.id, 1));
    const snapshot = store.updateProgressSnapshot(run, { runId: run.id, seq: 2, type: "tool.completed", data: { toolName: "read", isError: false }, createdAt: Date.now() });
    expect(snapshot).toMatchObject({ meaningfulChanges: 0, consecutiveFailures: 1 });
    const changed = store.updateProgressSnapshot(run, { runId: run.id, seq: 3, type: "tool.completed", data: { toolName: "edit", isError: false }, createdAt: Date.now() });
    expect(changed).toMatchObject({ meaningfulChanges: 1, consecutiveFailures: 0 });
    store.close();
  });

  it("reconciles a terminally committed proposed decision as executed after restart", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "terminal reconcile");
    store.upsertPlanItem(run.id, { key: "done", title: "Done", status: "done", required: true, position: 1 });
    const supervisor = new TaskRunSupervisor(store);
    const review = supervisor.reviewSettled(store.getRun(run.id)!, 4, "done");
    store.transitionRun(run.id, ["running"], "completed", "run.completed", { supervisionDecisionId: review.decision.id }, "", 1);
    expect(store.listSupervisorDecisions(run.id)[0].status).toBe("proposed");
    expect(store.reconcileSupervisorDecisionStatuses()).toEqual({ executed: 1, superseded: 0 });
    expect(store.listSupervisorDecisions(run.id)[0].status).toBe("executed");
    store.close();
  });

  it("supersedes an uncommitted proposed decision after restart", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "orphan decision");
    const decision = new TaskRunSupervisor(store, { repeatedFailureThreshold: 1, maxSteersPerAttempt: 1, minEventsBetweenInterventions: 1 }).reviewCheckpoint(run.id, failingEvent(run.id, 1));
    expect(decision?.status).toBe("proposed");
    expect(store.reconcileSupervisorDecisionStatuses()).toEqual({ executed: 0, superseded: 1 });
    expect(store.listSupervisorDecisions(run.id)[0].status).toBe("superseded");
    store.close();
  });

  it("does not carry a failed progress snapshot into a new attempt", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "new attempt progress");
    for (let seq = 1; seq <= 6; seq += 1) store.updateProgressSnapshot(run, failingEvent(run.id, seq));
    store.blockRun(run.id, "retry");
    const resumed = store.resumeRun(run.id);
    store.upsertPlanItem(run.id, { key: "done", title: "Done", status: "done", required: true, position: 1 });
    const review = new TaskRunSupervisor(store).reviewSettled(store.getRun(run.id)!, 7, "completed without tools");
    expect(resumed.attempt).toBe(2);
    expect(review.gates.find((gate) => gate.gateType === "progress")?.passed).toBe(true);
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
    expect(review.decision.action).toBe("request_evidence");
    expect(review.gates.find((gate) => gate.gateType === "evidence")?.failures).toEqual([expect.objectContaining({ key: "test", disposition: "auto_fixable" })]);
    expect(store.getRun(run.id)?.supervision.latestDecision?.id).toBe(review.decision.id);
    store.close();
  });

  it("rejects a short generic candidate that does not address the TaskRun contract", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "审计 Supervisor 为什么没有控制 TaskRun");
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify({ sourceInput: run.goal, summary: run.goal, acceptanceCriteria: ["定位根因", "给出修复和验证证据"], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent", intent: "new_task", decisionReason: "test", routerVersion: "test" }), run.id);
    store.upsertPlanItem(run.id, { key: "done", title: "Done", status: "done", required: true, position: 1 });
    const review = new TaskRunSupervisor(store).reviewSettled(store.getRun(run.id)!, 5, "收到，已经处理完成，无需继续。");
    expect(review.decision).toMatchObject({ action: "start_continuation", reasonCode: "auto_fixable_gate_failures" });
    expect(review.gates.find((gate) => gate.gateType === "completion")?.failures).toEqual([expect.objectContaining({ key: "contract_coverage" })]);
    store.close();
  });

  it("accepts a substantive candidate that addresses the contract", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "审计 Supervisor 为什么没有控制 TaskRun");
    store.db.prepare("UPDATE runs SET contract_json = ? WHERE id = ?").run(JSON.stringify({ sourceInput: run.goal, summary: run.goal, acceptanceCriteria: ["定位根因", "给出修复和验证证据"], scope: run.goal, nonGoals: [], sourceInboxIds: [], parentRunId: null, relation: "independent", intent: "new_task", decisionReason: "test", routerVersion: "test" }), run.id);
    store.upsertPlanItem(run.id, { key: "done", title: "Done", status: "done", required: true, position: 1 });
    const response = "Supervisor 没有控制 TaskRun 的根因是完成门禁只检查自报 plan/check 状态，没有检查候选回复是否覆盖合同。已增加 contract coverage 门禁，并用回归测试验证低质量短回复会触发 continuation。";
    expect(new TaskRunSupervisor(store).reviewSettled(store.getRun(run.id)!, 5, response).decision.action).toBe("complete_taskrun");
    store.close();
  });

  it("pauses for approval when a required approval item is blocked", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "production deploy");
    store.upsertPlanItem(run.id, { key: "approval", title: "Production deployment approval", status: "blocked", required: true, position: 1 });
    const review = new TaskRunSupervisor(store).reviewSettled(store.getRun(run.id)!, 5, "waiting");
    expect(review.decision).toMatchObject({ action: "pause_for_approval", reasonCode: "approval_required" });
    store.close();
  });

  it("classifies transient attempt failures for continuation", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "provider retry");
    const decision = new TaskRunSupervisor(store).reviewAttemptFailure(run, 9, "Provider timeout 503");
    expect(decision).toMatchObject({ trigger: "attempt_terminal", action: "start_continuation", reasonCode: "transient_runtime_failure" });
    store.close();
  });

  it("does not loop on a skipped required contract item", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "skipped contract");
    store.upsertPlanItem(run.id, { key: "required", title: "Required", status: "skipped", required: true, position: 1 });
    const review = new TaskRunSupervisor(store).reviewSettled(store.getRun(run.id)!, 5, "cannot do it");
    expect(review.decision).toMatchObject({ action: "block_taskrun", reasonCode: "continuation_not_viable" });
    expect(review.gates.find((gate) => gate.gateType === "continuation")?.passed).toBe(false);
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
    expect(store.spawnFromProposal(proposal.id)).toBeUndefined();
    expect(store.updateSpawnProposalStatus(proposal.id, "approved")).toBe(true);
    const child = store.spawnFromProposal(proposal.id)!;
    expect(child.goal).toBe("deploy feature");
    expect(store.listSpawnProposals(parent.id)[0]).toMatchObject({ status: "spawned", spawnedRunId: child.id });
    expect(store.listTaskRunEdges(parent.id)).toEqual([expect.objectContaining({ fromRunId: parent.id, toRunId: child.id, relation: "follow_up" })]);
    store.close();
  });
});

describe("Supervisor approval and runtime waiting", () => {
  it("waits when durable control messages are still pending at settle", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "wait for steer delivery");
    store.upsertPlanItem(run.id, { key: "done", title: "Done", status: "done", required: true, position: 1 });
    store.enqueueControl(run.id, "control-1", "steer", "use the corrected path", 32);
    const review = new TaskRunSupervisor(store).reviewSettled(store.getRun(run.id)!, 3, "done");
    expect(review.decision).toMatchObject({ action: "wait_for_runtime", reasonCode: "pending_control_delivery" });
    store.close();
  });

  it("persists and resolves a single durable approval request", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "production approval");
    const decision = new TaskRunSupervisor(store).reviewAttemptFailure(run, 2, "Production deployment permission required");
    const first = store.ensureApprovalRequest(run.id, decision.id, decision.rationale);
    const duplicate = store.ensureApprovalRequest(run.id, decision.id, decision.rationale);
    expect(duplicate.id).toBe(first.id);
    expect(store.hasPendingApproval(run.id)).toBe(true);
    expect(store.resolveApprovalRequest(first.id, "approved", "user", "ship it")).toMatchObject({ status: "approved", resolution: "ship it" });
    expect(store.hasPendingApproval(run.id)).toBe(false);
    store.close();
  });

  it("steers repeated identical successful operations", () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "avoid redundant reads");
    const supervisor = new TaskRunSupervisor(store, { repeatedFailureThreshold: 3, maxSteersPerAttempt: 1, minEventsBetweenInterventions: 1 });
    let decision;
    for (let seq = 1; seq <= 3; seq += 1) {
      const toolCallId = `call-${seq}`;
      store.recordToolAttempt(run.id, run.attempt, toolCallId, "read", { path: "same-file" });
      store.completeToolAttempt(run.id, run.attempt, toolCallId, true);
      decision = supervisor.reviewCheckpoint(run.id, { runId: run.id, seq, type: "tool.completed", data: { toolCallId, toolName: "read", isError: false }, createdAt: Date.now() });
    }
    expect(decision).toMatchObject({ action: "steer", reasonCode: "repeated_tool_operation" });
    expect(store.getProgressSnapshot(run.id)?.repeatedOperations).toBe(3);
    store.close();
  });
});
