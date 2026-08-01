import { createHash, randomUUID } from "node:crypto";
import type { Store } from "../store/store.js";
import type { GateEvaluation, RunEvent, SupervisorDecision, SupervisorAction, TaskRun } from "./types.js";
import type { SupervisorReviewer } from "./supervisor-reviewer.js";

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
  private readonly reviewer: SupervisorReviewer;
  private readonly policy: SupervisorPolicy;
  constructor(private readonly store: Store, reviewer: SupervisorReviewer, policy: SupervisorPolicy = { maxSteersPerAttempt: 2, minEventsBetweenInterventions: 3, repeatedFailureThreshold: 3 }) {
    this.reviewer = reviewer;
    this.policy = policy;
  }

  reviewCheckpoint(runId: string, event: RunEvent) {
    const run = this.store.getRun(runId);
    if (!run || run.status !== "running") return undefined;
    const snapshot = this.store.updateProgressSnapshot(run, event);
    if (!event.type.startsWith("tool.") && event.type !== "tool.guard.blocked") return undefined;
    const repeatedFailure = snapshot.consecutiveFailures >= this.policy.repeatedFailureThreshold;
    const repeatedOperation = snapshot.repeatedOperations >= this.policy.repeatedFailureThreshold;
    if (!repeatedFailure && !repeatedOperation) return undefined;
    const recent = this.store.listSupervisorDecisions(runId, run.attempt);
    const steers = recent.filter((item) => item.action === "steer" && (item.status === "proposed" || item.status === "executed"));
    if (steers.length >= this.policy.maxSteersPerAttempt) return undefined;
    const last = steers.at(-1);
    if (last && event.seq - last.checkpointSeq < this.policy.minEventsBetweenInterventions) return undefined;
    const reasonCode = repeatedFailure ? "repeated_tool_failures" : "repeated_tool_operation";
    const rationale = repeatedFailure
      ? `Stop repeating the failing operation. Inspect the root cause and use a materially different approach. ${snapshot.consecutiveFailures} consecutive tool failures were observed.`
      : `Stop repeating the same successful operation. ${snapshot.repeatedOperations} identical calls were observed without new TaskRun evidence; use the existing result or change approach.`;
    return this.createDecision(run, event.seq, "checkpoint", "steer", reasonCode, rationale, 1);
  }

  async reviewSettled(run: TaskRun, checkpointSeq: number, response: string): Promise<SettledReview> {
    const pendingControl = this.store.listControlInbox(run.id).filter((item) => item.attempt === run.attempt && ["queued", "delivering"].includes(item.status));
    if (pendingControl.length) {
      return { gates: [], decision: this.createDecision(run, checkpointSeq, "settled", "wait_for_runtime", "pending_control_delivery", `${pendingControl.length} durable control message(s) are still pending delivery.`, 1, response) };
    }
    const operations = this.store.listOperations(run.id);
    const progress = this.store.getProgressSnapshot(run.id);
    const audit = await this.reviewer.reviewSettled({ run, response, operations, progress });
    const createdAt = Date.now();
    const manifest = { attempt: run.attempt, checkpointSeq, contract: run.contract, plan: run.plan, checks: run.checks, artifacts: run.artifacts.map(({ id, kind, uri }) => ({ id, kind, uri })), operations: operations.map(({ id, operationType, status, stage }) => ({ id, operationType, status, stage })), response, progress };
    const inputManifestHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    const gates = (["progress", "evidence", "contract", "completion", "continuation"] as const).map((gateType): GateEvaluation => {
      const reviewed = audit.gates[gateType];
      return { id: randomUUID(), runId: run.id, attempt: run.attempt, checkpointSeq, gateType, evaluator: this.reviewer.evaluator, evaluatorModel: this.reviewer.model, summary: reviewed.summary, passed: reviewed.passed, failures: reviewed.failures, criterionCoverage: reviewed.criterionCoverage, inputManifestHash, createdAt };
    });
    for (const gate of gates) this.store.recordGateEvaluation(gate);
    return { gates, decision: this.createDecision(run, checkpointSeq, "settled", audit.action, audit.reasonCode, audit.rationale, audit.confidence, response) };
  }

  async reviewAttemptFailure(run: TaskRun, checkpointSeq: number, error: string) {
    const audit = await this.reviewer.reviewAttemptFailure({ run, error });
    return this.createDecision(run, checkpointSeq, "attempt_terminal", audit.action, audit.reasonCode, audit.rationale, audit.confidence);
  }

  reviewSpawn(run: TaskRun, checkpointSeq: number) {
    const proposals = this.store.listSpawnProposals(run.id, "proposed");
    return proposals.map((proposal) => this.createDecision(run, checkpointSeq, "taskrun_terminal", "spawn_taskrun", "pending_explicit_proposal", `Spawn proposal ${proposal.id}: ${proposal.goal}`, 1));
  }

  markExecuted(id: string, status: "executed" | "superseded" | "failed", error = "") {
    return this.store.updateSupervisorDecision(id, status, error);
  }

  private createDecision(run: TaskRun, checkpointSeq: number, trigger: SupervisorDecision["trigger"], action: SupervisorAction, reasonCode: string, rationale: string, confidence: number, candidateResponse = "") {
    const decision: SupervisorDecision = { id: randomUUID(), runId: run.id, evaluator: trigger === "attempt_terminal" || (trigger === "settled" && !["wait_for_runtime"].includes(action)) ? this.reviewer.evaluator : "system", evaluatorModel: trigger === "attempt_terminal" || (trigger === "settled" && !["wait_for_runtime"].includes(action)) ? this.reviewer.model : "", attempt: run.attempt, checkpointSeq, trigger, action, reasonCode, rationale, confidence, instruction: action === "steer" || action === "follow_up" ? rationale : "", candidateResponseHash: createHash("sha256").update(candidateResponse).digest("hex"), status: "proposed", error: "", createdAt: Date.now(), executedAt: null };
    return this.store.recordSupervisorDecision(decision);
  }
}
