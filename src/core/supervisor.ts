import { createHash, randomUUID } from "node:crypto";
import type { Store } from "../store/store.js";
import type { GateEvaluation, RunEvent, SupervisorDecision, SupervisorAction, TaskRun } from "./types.js";

export interface SupervisorPolicy {
  maxSteersPerAttempt: number;
  minEventsBetweenInterventions: number;
  repeatedFailureThreshold: number;
}

export interface SettledReview {
  decision: SupervisorDecision;
  gates: GateEvaluation[];
}

export class TaskRunSupervisor {
  constructor(private readonly store: Store, private readonly policy: SupervisorPolicy = { maxSteersPerAttempt: 2, minEventsBetweenInterventions: 3, repeatedFailureThreshold: 3 }) {}

  reviewCheckpoint(runId: string, event: RunEvent) {
    const run = this.store.getRun(runId);
    if (!run || run.status !== "running") return undefined;
    const snapshot = this.store.updateProgressSnapshot(run, event);
    if (!event.type.startsWith("tool.") && event.type !== "tool.guard.blocked") return undefined;
    if (snapshot.consecutiveFailures < this.policy.repeatedFailureThreshold) return undefined;
    const recent = this.store.listSupervisorDecisions(runId, run.attempt);
    const steers = recent.filter((item) => item.action === "steer" && item.status === "executed");
    if (steers.length >= this.policy.maxSteersPerAttempt) return undefined;
    const last = steers.at(-1);
    if (last && event.seq - last.checkpointSeq < this.policy.minEventsBetweenInterventions) return undefined;
    return this.createDecision(run, event.seq, "checkpoint", "steer", "repeated_tool_failures",
      `Stop repeating the failing operation. Inspect the root cause and use a materially different approach. ${snapshot.consecutiveFailures} consecutive tool failures were observed.`, 1);
  }

  reviewSettled(run: TaskRun, checkpointSeq: number, response: string): SettledReview {
    const gates = this.evaluateGates(run, checkpointSeq, response);
    for (const gate of gates) this.store.recordGateEvaluation(gate);
    const completion = gates.find((item) => item.gateType === "completion")!;
    let action: SupervisorAction;
    let reasonCode: string;
    let rationale: string;
    if (completion.passed) {
      action = "complete_taskrun";
      reasonCode = "all_gates_passed";
      rationale = "Required plan, verification, evidence, progress and delivery conditions passed.";
    } else {
      const failures = completion.failures;
      const needsInput = failures.some((failure) => failure.disposition === "needs_user_input" || failure.disposition === "needs_approval" || failure.disposition === "external_dependency");
      const exhausted = failures.some((failure) => failure.disposition === "budget_exhausted" || failure.disposition === "non_recoverable");
      if (needsInput || exhausted) {
        action = "block_taskrun";
        reasonCode = needsInput ? "human_or_external_dependency" : "continuation_not_viable";
        rationale = failures.map((item) => item.reason).join("; ");
      } else {
        action = "start_continuation";
        reasonCode = "auto_fixable_gate_failures";
        rationale = failures.map((item) => item.reason).join("; ");
      }
    }
    return { gates, decision: this.createDecision(run, checkpointSeq, "settled", action, reasonCode, rationale, 1, response) };
  }

  reviewSpawn(run: TaskRun, checkpointSeq: number) {
    const proposals = this.store.listSpawnProposals(run.id, "proposed");
    return proposals.map((proposal) => this.createDecision(run, checkpointSeq, "taskrun_terminal", "spawn_taskrun", "approved_explicit_proposal", `Spawn proposal ${proposal.id}: ${proposal.goal}`, 1));
  }

  markExecuted(id: string, status: "executed" | "superseded" | "failed", error = "") {
    return this.store.updateSupervisorDecision(id, status, error);
  }

  private evaluateGates(run: TaskRun, checkpointSeq: number, response: string): GateEvaluation[] {
    const createdAt = Date.now();
    const manifest = { attempt: run.attempt, checkpointSeq, plan: run.plan, checks: run.checks, artifacts: run.artifacts.map(({ id, kind, uri }) => ({ id, kind, uri })), responseLength: response.length, usage: run.usage };
    const inputManifestHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    const gate = (gateType: GateEvaluation["gateType"], failures: GateEvaluation["failures"]): GateEvaluation => ({ id: randomUUID(), runId: run.id, attempt: run.attempt, checkpointSeq, gateType, passed: failures.length === 0, failures, inputManifestHash, createdAt });
    const progressFailures: GateEvaluation["failures"] = [];
    const snapshot = this.store.getProgressSnapshot(run.id);
    if (snapshot && snapshot.consecutiveFailures >= 6) progressFailures.push({ kind: "progress", key: "consecutive_failures", reason: `${snapshot.consecutiveFailures} consecutive tool failures`, disposition: "non_recoverable" });
    const evidenceFailures: GateEvaluation["failures"] = [];
    for (const check of run.checks.filter((item) => item.required && item.status === "passed")) {
      if (!check.evidence.trim()) evidenceFailures.push({ kind: "evidence", key: check.key, reason: "Required passed check has no evidence", disposition: "auto_fixable" });
      if (check.stale) evidenceFailures.push({ kind: "evidence", key: check.key, reason: "Required evidence is stale", disposition: "auto_fixable" });
    }
    const completionFailures: GateEvaluation["failures"] = [...progressFailures, ...evidenceFailures];
    if (run.gateRequired) {
      const requiredPlan = run.plan.filter((item) => item.required);
      if (!requiredPlan.length) completionFailures.push({ kind: "plan", key: "plan", reason: "No required plan items", disposition: "auto_fixable" });
      for (const item of requiredPlan) if (item.status !== "done") completionFailures.push({ kind: "plan_item", key: item.key, reason: `Required plan item is ${item.status}`, disposition: item.status === "blocked" ? "needs_user_input" : "auto_fixable" });
      for (const check of run.checks.filter((item) => item.required)) if (check.status !== "passed") completionFailures.push({ kind: "check", key: check.key, reason: `Required check is ${check.status}`, disposition: check.status === "blocked" ? "external_dependency" : "auto_fixable" });
    }
    if (!response.trim()) completionFailures.push({ kind: "delivery", key: "response", reason: "Candidate response is empty", disposition: "auto_fixable" });
    return [gate("progress", progressFailures), gate("evidence", evidenceFailures), gate("completion", completionFailures), gate("continuation", completionFailures.filter((item) => item.disposition !== "auto_fixable"))];
  }

  private createDecision(run: TaskRun, checkpointSeq: number, trigger: SupervisorDecision["trigger"], action: SupervisorAction, reasonCode: string, rationale: string, confidence: number, candidateResponse = "") {
    const decision: SupervisorDecision = { id: randomUUID(), runId: run.id, attempt: run.attempt, checkpointSeq, trigger, action, reasonCode, rationale, confidence, instruction: action === "steer" || action === "follow_up" ? rationale : "", candidateResponseHash: createHash("sha256").update(candidateResponse).digest("hex"), status: "proposed", error: "", createdAt: Date.now(), executedAt: null };
    return this.store.recordSupervisorDecision(decision);
  }
}
