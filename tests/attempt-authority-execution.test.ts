import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeMessage as AgentMessage } from "@tagent/execution/ports";
import { AgentService, type AgentServicePersistencePort } from "@tagent/core-service/application";
import { passingTestAudit, TestSupervisorReviewer, type SupervisorReviewer } from "@tagent/core-service/composition";
import { ATTEMPT_AUTHORITY_SCENARIOS } from "@tagent/execution/domain";
import type { AttemptRuntimePort as AgentRuntime } from "@tagent/execution/ports";
import { Store } from "@tagent/persistence-sqlite/store";
import { agentPersistence } from "./support/test-persistence.js";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => { if (store.db.open) store.close(); }));

function assistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "test",
    model: "test",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

class ControlledRuntime implements AgentRuntime {
  private settlePrompt?: () => void;
  constructor(private readonly response: string) {}
  prompt() { return new Promise<void>((resolve) => { this.settlePrompt = resolve; }); }
  async steer() { return "accepted" as const; }
  abort() { this.settlePrompt?.(); }
  async dispose() { await this.abort(); }
  resolve() { this.settlePrompt?.(); }
  getMessages() { return [assistantMessage(this.response)]; }
  getError() { return undefined; }
}

function approveAttempt(store: Store, attemptId: string) {
  const persistence = agentPersistence(store);
  persistence.attemptAuthority.recordShadowComparisons(Array.from({ length: 1_000 }, (_, index) => ({
    attemptId,
    scenario: ATTEMPT_AUTHORITY_SCENARIOS[index % ATTEMPT_AUTHORITY_SCENARIOS.length],
    legacy: { status: "running" },
    projected: { status: "running" },
    mismatch: false,
  })));
  const receipt = persistence.attemptAuthority.recordAuthorityReceipt({
    id: `approve:${attemptId}`,
    requestedAttemptId: attemptId,
    decision: "approved",
    actor: "release-governor",
    reason: "shadow evidence accepted",
  });
  return persistence.attemptAuthority.requestAuthority({
    requestedAttemptId: attemptId,
    receiptId: receipt.id,
  });
}

async function waitFor(check: () => boolean) {
  for (let index = 0; index < 100; index += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for execution settlement");
}

function serviceFixture(response = "verified result") {
  const store = new Store(":memory:");
  stores.push(store);
  const session = store.createSession();
  const runtime = new ControlledRuntime(response);
  const service = new AgentService(agentPersistence(store), "/tmp", () => runtime, {
    supervisorReviewer: new TestSupervisorReviewer(passingTestAudit()),
  });
  return { store, session, runtime, service };
}

describe("Attempt settlement authority", () => {
  it("keeps shadow mode on the legacy terminal path without recording a CandidateResult", async () => {
    const { store, session, runtime, service } = serviceFixture();
    const run = await service.start(session.id, "shadow settlement");
    runtime.resolve();
    await waitFor(() => store.getRun(run.id)?.status === "completed");

    expect(store.db.prepare("SELECT COUNT(*) AS count FROM candidate_results").get()).toEqual({ count: 0 });
    expect(store.listEvents(run.id).filter((event) => event.type === "run.completed")).toHaveLength(1);
    await service.closeRuntimes();
  });

  it("keeps an unapproved Attempt on the legacy path while another canary slot is active", async () => {
    const { store, session, runtime, service } = serviceFixture();
    const run = await service.start(session.id, "unapproved authoritative settlement");
    const canarySession = store.createSession();
    const canaryRun = store.createRun(canarySession.id, "separately approved canary");
    const canaryAttempt = agentPersistence(store).attempts.getActiveAttempt(canaryRun.id)!;
    approveAttempt(store, canaryAttempt.id);
    expect(agentPersistence(store).attemptAuthority.getAuthorityState()).toMatchObject({
      mode: "canary",
      status: "approved",
      approvedAttemptId: canaryAttempt.id,
    });

    runtime.resolve();
    await waitFor(() => !store.db.prepare("SELECT 1 FROM execution_leases WHERE released_at IS NULL").get());

    expect(store.getRun(run.id)).toMatchObject({ status: "completed", attempt: 1 });
    expect(agentPersistence(store).attempts.getAttemptForRun(run.id, 1)).toMatchObject({ status: "completed", active: false });
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM candidate_results").get()).toEqual({ count: 0 });
    expect(store.listEvents(run.id).filter((event) => ["run.completed", "run.blocked"].includes(event.type)))
      .toEqual([expect.objectContaining({ type: "run.completed" })]);
    await service.closeRuntimes();
  });

  it("records and settles the CandidateResult when the current Attempt is approved", async () => {
    const { store, session, runtime, service } = serviceFixture();
    const run = await service.start(session.id, "approved authoritative settlement");
    const attempt = agentPersistence(store).attempts.getActiveAttempt(run.id)!;
    approveAttempt(store, attempt.id);

    runtime.resolve();
    await waitFor(() => store.getRun(run.id)?.status === "completed");

    expect(store.db.prepare("SELECT status,response FROM candidate_results WHERE attempt_id=?").get(attempt.id))
      .toEqual({ status: "accepted", response: "verified result" });
    expect(agentPersistence(store).attempts.getAttempt(attempt.id)).toMatchObject({ status: "completed", active: false });
    expect(store.listEvents(run.id).filter((event) => event.type === "run.completed")).toHaveLength(1);
    await service.closeRuntimes();
  });

  it("persists the canary CandidateResult before governance review completes", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const session = store.createSession();
    const runtime = new ControlledRuntime("reviewable candidate");
    let releaseReview!: () => void;
    let reviewStarted = false;
    const reviewGate = new Promise<void>((resolve) => { releaseReview = resolve; });
    const slowReviewer: SupervisorReviewer = {
      evaluator: "llm",
      model: "controlled-reviewer",
      async reviewSettled() {
        reviewStarted = true;
        await reviewGate;
        return passingTestAudit();
      },
      async reviewAttemptFailure() {
        return { action: "block_taskrun", reasonCode: "failed", rationale: "failed", confidence: 1 };
      },
    };
    const service = new AgentService(agentPersistence(store), "/tmp", () => runtime, {
      supervisorReviewer: slowReviewer,
    });
    const run = await service.start(session.id, "candidate before governance");
    const attempt = agentPersistence(store).attempts.getActiveAttempt(run.id)!;
    approveAttempt(store, attempt.id);

    runtime.resolve();
    await waitFor(() => reviewStarted);

    expect(store.getRun(run.id)).toMatchObject({ status: "running" });
    expect(agentPersistence(store).attempts.getAttempt(attempt.id)).toMatchObject({ status: "settling", version: 2 });
    expect(store.db.prepare("SELECT status,response FROM candidate_results WHERE attempt_id=?").get(attempt.id))
      .toEqual({ status: "proposed", response: "reviewable candidate" });

    releaseReview();
    await waitFor(() => store.getRun(run.id)?.status === "completed");
    expect(store.db.prepare("SELECT status FROM candidate_results WHERE attempt_id=?").get(attempt.id))
      .toEqual({ status: "accepted" });
    await service.closeRuntimes();
  });

  it("returns to the legacy shadow path after an authority rollback", async () => {
    const { store, session, runtime, service } = serviceFixture();
    const run = await service.start(session.id, "rolled back settlement");
    const persistence = agentPersistence(store);
    const attempt = persistence.attempts.getActiveAttempt(run.id)!;
    approveAttempt(store, attempt.id);
    const rollback = persistence.attemptAuthority.recordAuthorityReceipt({
      id: `rollback:${attempt.id}`,
      requestedAttemptId: attempt.id,
      decision: "rollback",
      actor: "release-governor",
      reason: "return to shadow mode",
    });
    persistence.attemptAuthority.rollbackAuthority({ receiptId: rollback.id });

    runtime.resolve();
    await waitFor(() => store.getRun(run.id)?.status === "completed");

    expect(store.db.prepare("SELECT COUNT(*) AS count FROM candidate_results").get()).toEqual({ count: 0 });
    expect(persistence.attemptAuthority.getAuthorityState()).toMatchObject({ mode: "shadow", status: "blocked" });
    expect(store.listEvents(run.id).filter((event) => event.type === "run.completed")).toHaveLength(1);
    await service.closeRuntimes();
  });

  it("interrupts an approved Candidate when authority rolls back during review and permits resume", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const session = store.createSession();
    const first = new ControlledRuntime("candidate before rollback");
    const second = new ControlledRuntime("resumed candidate");
    let runtimeIndex = 0;
    let releaseReview!: () => void;
    let reviewStarted = false;
    const reviewGate = new Promise<void>((resolve) => { releaseReview = resolve; });
    const reviewer: SupervisorReviewer = {
      evaluator: "llm",
      model: "rollback-reviewer",
      async reviewSettled() {
        reviewStarted = true;
        await reviewGate;
        return passingTestAudit();
      },
      async reviewAttemptFailure() {
        return { action: "block_taskrun", reasonCode: "failed", rationale: "failed", confidence: 1 };
      },
    };
    const service = new AgentService(agentPersistence(store), "/tmp", () => [first, second][runtimeIndex++]!, {
      supervisorReviewer: reviewer,
    });
    const run = await service.start(session.id, "rollback during review");
    const persistence = agentPersistence(store);
    const attempt = persistence.attempts.getActiveAttempt(run.id)!;
    approveAttempt(store, attempt.id);

    first.resolve();
    await waitFor(() => reviewStarted);
    expect(persistence.attempts.getAttempt(attempt.id)).toMatchObject({ status: "settling", active: true });
    const rollback = persistence.attemptAuthority.recordAuthorityReceipt({
      id: `rollback-review:${attempt.id}`,
      requestedAttemptId: attempt.id,
      decision: "rollback",
      actor: "release-governor",
      reason: "canary mismatch",
    });
    persistence.attemptAuthority.rollbackAuthority({ receiptId: rollback.id });
    releaseReview();

    await waitFor(() => store.getRun(run.id)?.status === "interrupted");
    expect(persistence.attempts.getAttempt(attempt.id)).toMatchObject({ status: "interrupted", active: false });
    expect(store.db.prepare("SELECT status FROM candidate_results WHERE attempt_id=?").get(attempt.id))
      .toEqual({ status: "rejected" });
    expect(store.listSupervisorDecisions(run.id, 1)).toEqual([
      expect.objectContaining({ status: "superseded", error: expect.stringContaining("not approved") }),
    ]);
    expect(store.db.prepare("SELECT released_at IS NOT NULL AS released FROM execution_leases WHERE attempt_id=?").get(attempt.id))
      .toEqual({ released: 1 });
    expect(store.listMessages(session.id).filter((message) => message.role === "assistant")).toHaveLength(0);

    const resumed = await service.resume(run.id);
    expect(resumed).toMatchObject({ status: "running", attempt: 2 });
    expect(persistence.attempts.getActiveAttempt(run.id)).toMatchObject({ ordinal: 2, status: "running" });
    service.cancel(run.id);
    await service.closeRuntimes();
  });

  it("atomically rejects a proposed Candidate when the user cancels during review", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const session = store.createSession();
    const runtime = new ControlledRuntime("candidate before cancellation");
    let releaseReview!: () => void;
    let reviewStarted = false;
    const reviewGate = new Promise<void>((resolve) => { releaseReview = resolve; });
    const reviewer: SupervisorReviewer = {
      evaluator: "llm",
      model: "cancel-reviewer",
      async reviewSettled() {
        reviewStarted = true;
        await reviewGate;
        return passingTestAudit();
      },
      async reviewAttemptFailure() {
        return { action: "block_taskrun", reasonCode: "failed", rationale: "failed", confidence: 1 };
      },
    };
    const service = new AgentService(agentPersistence(store), "/tmp", () => runtime, { supervisorReviewer: reviewer });
    const run = await service.start(session.id, "cancel during review");
    const persistence = agentPersistence(store);
    const attempt = persistence.attempts.getActiveAttempt(run.id)!;
    approveAttempt(store, attempt.id);
    runtime.resolve();
    await waitFor(() => reviewStarted);

    expect(service.cancel(run.id)).toBe(true);
    expect(store.getRun(run.id)).toMatchObject({ status: "cancelled" });
    expect(persistence.attempts.getAttempt(attempt.id)).toMatchObject({ status: "cancelled", active: false });
    expect(store.db.prepare("SELECT status FROM candidate_results WHERE attempt_id=?").get(attempt.id))
      .toEqual({ status: "rejected" });
    releaseReview();
    await waitFor(() => store.listSupervisorDecisions(run.id, 1).length === 1);
    expect(store.listSupervisorDecisions(run.id, 1)).toEqual([
      expect.objectContaining({ status: "superseded" }),
    ]);
    expect(store.listEvents(run.id).filter((event) => event.type === "run.completed")).toHaveLength(0);
    expect(store.listMessages(session.id).filter((message) => message.role === "assistant")).toHaveLength(0);
    await service.closeRuntimes();
  });

  it("interrupts and releases an Attempt when its execution lease heartbeat fails", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const session = store.createSession();
    const first = new ControlledRuntime("must not settle");
    const second = new ControlledRuntime("resumed");
    let runtimeIndex = 0;
    const base = agentPersistence(store);
    const persistence: AgentServicePersistencePort = {
      ...base,
      attempts: {
        ...base.attempts,
        renewExecutionLease() { throw new Error("simulated heartbeat loss"); },
      },
    };
    const service = new AgentService(persistence, "/tmp", () => [first, second][runtimeIndex++]!, {
      executionLeaseHeartbeatMs: 5,
      supervisorReviewer: new TestSupervisorReviewer(passingTestAudit()),
    });
    const run = await service.start(session.id, "heartbeat recovery");
    const attempt = persistence.attempts.getActiveAttempt(run.id)!;

    await waitFor(() => store.getRun(run.id)?.status === "interrupted");
    expect(persistence.attempts.getAttempt(attempt.id)).toMatchObject({ status: "interrupted", active: false });
    expect(store.listEvents(run.id).at(-1)).toMatchObject({
      type: "run.interrupted",
      data: expect.objectContaining({ reason: expect.stringContaining("heartbeat") }),
    });
    expect(store.db.prepare("SELECT released_at IS NOT NULL AS released FROM execution_leases WHERE attempt_id=?").get(attempt.id))
      .toEqual({ released: 1 });

    const resumed = await service.resume(run.id);
    expect(resumed).toMatchObject({ status: "running", attempt: 2 });
    service.cancel(run.id);
    await service.closeRuntimes();
  });

  it("routes an approved canary hard timeout through recoverable interruption", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const session = store.createSession();
    const runtime = new ControlledRuntime("must not be delivered");
    const service = new AgentService(agentPersistence(store), "/tmp", () => runtime, {
      runTimeoutMs: 1_000,
      runHardTimeoutMs: 100,
      supervisorReviewer: new TestSupervisorReviewer(passingTestAudit()),
    });
    const run = await service.start(session.id, "canary hard timeout");
    const persistence = agentPersistence(store);
    const attempt = persistence.attempts.getActiveAttempt(run.id)!;
    approveAttempt(store, attempt.id);

    await waitFor(() => store.getRun(run.id)?.status === "interrupted");
    expect(store.getRun(run.id)).toMatchObject({ status: "interrupted", resumable: true });
    expect(persistence.attempts.getAttempt(attempt.id)).toMatchObject({ status: "interrupted", active: false });
    expect(store.listEvents(run.id).at(-1)).toMatchObject({
      type: "run.interrupted",
      data: expect.objectContaining({ reason: "Run exceeded 100ms absolute hard timeout" }),
    });
    expect(store.listMessages(session.id).filter((message) => message.role === "assistant")).toHaveLength(0);
    await service.closeRuntimes();
  });
});
