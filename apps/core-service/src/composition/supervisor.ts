import { createHash, randomUUID } from "node:crypto";
import type {
  CriterionCoverage,
  GateEvaluation,
  GateFailure,
  SupervisorAction,
  SupervisorDecision,
} from "@tagent/governance/domain";
import type {
  GovernanceRunEventView,
  GovernanceTaskRunView,
  OperationRecord,
  SupervisorPersistencePort,
} from "@tagent/governance/ports";
import type { SupervisorAudit, SupervisorReviewer } from "./supervisor-reviewer.js";

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
  constructor(private readonly store: SupervisorPersistencePort, reviewer: SupervisorReviewer, policy: SupervisorPolicy = { maxSteersPerAttempt: 2, minEventsBetweenInterventions: 3, repeatedFailureThreshold: 3 }) {
    this.reviewer = reviewer;
    this.policy = policy;
  }

  reviewCheckpoint(runId: string, event: GovernanceRunEventView) {
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

  async reviewSettled(run: GovernanceTaskRunView, checkpointSeq: number, response: string, options: { modelOutputTruncated?: boolean } = {}): Promise<SettledReview> {
    const pendingControl = this.store.listControlInbox(run.id).filter((item) => item.attempt === run.attempt && ["queued", "delivering"].includes(item.status));
    if (pendingControl.length) {
      return { gates: [], decision: this.createDecision(run, checkpointSeq, "settled", "wait_for_runtime", "pending_control_delivery", `${pendingControl.length} durable control message(s) are still pending delivery.`, 1, response) };
    }
    const operations = this.store.listOperations(run.id);
    const progress = this.store.getProgressSnapshot(run.id);
    const contextManifest = this.store.getLatestContextManifest(run.id);
    // Do not spend a model round-trip proving facts already authoritatively known by the local gate.
    // Semantic review still runs whenever deterministic prerequisites pass.
    const prerequisiteAudit = this.reviewDeterministicPrerequisites(run);
    const lightweightAudit = prerequisiteAudit ? undefined : this.reviewLightweightCompletion(run, response, operations, options);
    const deterministicAudit = prerequisiteAudit ?? lightweightAudit;
    const audit = deterministicAudit ?? await this.reviewer.reviewSettled({ run, response, modelOutputTruncated: options.modelOutputTruncated, operations, progress, contextManifest });
    const evaluator = deterministicAudit ? "system" as const : audit.evaluator ?? this.reviewer.evaluator;
    const evaluatorModel = prerequisiteAudit ? "deterministic-prerequisite-gate" : lightweightAudit ? "deterministic-lightweight-delivery-v1" : audit.evaluatorModel ?? this.reviewer.model;
    const createdAt = Date.now();
    const manifest = { attempt: run.attempt, checkpointSeq, contract: run.contract, plan: run.plan, checks: run.checks, artifacts: run.artifacts.map(({ id, kind, uri }) => ({ id, kind, uri })), operations: operations.map(({ id, operationType, status, stage }) => ({ id, operationType, status, stage })), response, progress };
    const inputManifestHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    const gates = (["progress", "evidence", "contract", "completion", "continuation"] as const).map((gateType): GateEvaluation => {
      const reviewed = audit.gates[gateType];
      return { id: randomUUID(), runId: run.id, attempt: run.attempt, checkpointSeq, gateType, evaluator, evaluatorModel, summary: reviewed.summary, passed: reviewed.passed, failures: reviewed.failures, criterionCoverage: reviewed.criterionCoverage, inputManifestHash, createdAt };
    });
    for (const gate of gates) this.store.recordGateEvaluation(gate);
    return { gates, decision: this.createDecision(run, checkpointSeq, "settled", audit.action, audit.reasonCode, audit.rationale, audit.confidence, response, evaluator, evaluatorModel) };
  }

  private reviewLightweightCompletion(run: GovernanceTaskRunView, response: string, operations: OperationRecord[], options: { modelOutputTruncated?: boolean }): SupervisorAudit | undefined {
    const contract = run.contract;
    const objectives = contract?.objectives.filter((item) => item.timing === "current") ?? [];
    const objective = objectives[0];
    const risky = /(?:release|deploy|publish|production|credential|secret|permission|delete|remove|migration|security|发布|发版|部署|生产|凭据|密钥|权限|删除|迁移|安全)/i;
    const candidate = response.trim();
    // This path is intentionally narrow: a single discussion/answer objective, no side
    // effects, no truncation, and all deterministic prerequisites already satisfied.
    // Any ambiguity or execution work keeps the independent semantic reviewer.
    if (!contract || contract.intent !== "discussion" || objectives.length !== 1 || objective?.kind !== "answer") return undefined;
    if (contract.objectives.length !== 1 || contract.acceptanceCriteria.length > 1 || contract.nonGoals.length > 0) return undefined;
    if (operations.length > 0 || run.checks.some((check) => check.required) || run.artifacts.length > 0) return undefined;
    if (options.modelOutputTruncated || candidate.length < 20 || risky.test(`${contract.summary} ${contract.scope} ${candidate}`)) return undefined;
    const coverage: CriterionCoverage[] = contract.acceptanceCriteria.map((criterion) => ({
      criterion,
      status: "covered",
      evidenceRefs: [],
      reason: "The single low-risk answer objective is addressed by the complete standalone candidate.",
    }));
    const gate = (summary: string, criterionCoverage?: CriterionCoverage[]) => ({ passed: true, failures: [], summary, criterionCoverage });
    return {
      action: "complete_taskrun",
      reasonCode: "lightweight_delivery_validated",
      rationale: "Skipped the general semantic Supervisor for a low-risk single-answer Run after deterministic delivery validation.",
      confidence: 1,
      evaluator: "system",
      evaluatorModel: "deterministic-lightweight-delivery-v1",
      gates: {
        progress: gate("The required lightweight plan is complete."),
        evidence: gate("This discussion-only Run requires no external operation or check evidence."),
        contract: gate("The complete candidate directly addresses the single low-risk answer objective.", coverage),
        completion: gate("Deterministic prerequisites and lightweight delivery validation passed."),
        continuation: gate("No unresolved blocker requires continuation."),
      },
    };
  }

  private reviewDeterministicPrerequisites(run: GovernanceTaskRunView): SupervisorAudit | undefined {
    if (run.completionGate.passed) return undefined;
    const localFailures = run.completionGate.failures;
    // The deterministic completion gate is a floor for routed substantial work with an execution contract.
    // Legacy/lightweight runs without a contract retain semantic review so discussion-only work is not forced
    // into artificial plan/check continuations.
    if (!run.contract && localFailures.some((failure) => failure.kind === "plan" && failure.key === "plan")) return undefined;
    const toFailure = (failure: (typeof localFailures)[number]): GateFailure => ({
      ...failure,
      disposition: "auto_fixable",
    });
    const planFailures = localFailures.filter((failure) => failure.kind === "plan" || failure.kind === "plan_item").map(toFailure);
    const checkFailures = localFailures.filter((failure) => failure.kind === "check").map(toFailure);
    // Unknown local failure kinds must still go through semantic review instead of being guessed here.
    if (planFailures.length + checkFailures.length !== localFailures.length) return undefined;
    const criteria = run.contract?.acceptanceCriteria ?? [];
    const coverage: CriterionCoverage[] = criteria.map((criterion) => ({
      criterion,
      status: "blocked",
      evidenceRefs: [],
      reason: "Semantic contract audit deferred until deterministic plan and check prerequisites pass.",
    }));
    const contractFailures: GateFailure[] = criteria.length ? [{
      kind: "contract", key: "semantic_review_deferred",
      reason: "Acceptance criteria cannot be approved until deterministic plan and check prerequisites pass.",
      disposition: "auto_fixable",
    }] : [];
    const completionFailures = [...planFailures, ...checkFailures, ...contractFailures];
    const gate = (failures: GateFailure[], summary: string, criterionCoverage?: CriterionCoverage[]) => ({
      passed: failures.length === 0, failures, summary, criterionCoverage,
    });
    const action: SupervisorAction = planFailures.length === 0 && checkFailures.length > 0 ? "request_evidence" : "start_continuation";
    return {
      action,
      reasonCode: planFailures.length ? "deterministic_plan_incomplete" : "deterministic_check_incomplete",
      rationale: `Skipped semantic Supervisor call because ${localFailures.length} authoritative prerequisite failure(s) require repair first.`,
      confidence: 1,
      gates: {
        progress: gate(planFailures, planFailures.length ? "Required plan work is incomplete." : "Required plan work is complete."),
        evidence: gate(checkFailures, checkFailures.length ? "Required check evidence is missing, failed, or stale." : "Required check evidence prerequisites pass."),
        contract: gate(contractFailures, contractFailures.length ? "Semantic contract review was deferred." : "No acceptance criteria require semantic coverage.", coverage),
        completion: gate(completionFailures, "Completion is blocked by authoritative deterministic prerequisites."),
        continuation: gate([], "The prerequisite failures are automatically repairable."),
      },
    };
  }

  async reviewAttemptFailure(run: GovernanceTaskRunView, checkpointSeq: number, error: string) {
    const audit = await this.reviewer.reviewAttemptFailure({ run, error });
    return this.createDecision(run, checkpointSeq, "attempt_terminal", audit.action, audit.reasonCode, audit.rationale, audit.confidence);
  }

  recordReviewFailure(run: GovernanceTaskRunView, checkpointSeq: number, error: string) {
    return this.createDecision(run, checkpointSeq, "settled", "block_taskrun", "supervisor_review_failed", `Supervisor quality review could not produce a valid structured audit. The Agent result is preserved for audit and no automatic continuation was started. ${error}`, 1);
  }

  proposeParallelTaskStart(parentRunId: string, inboxItemId: string, summary: string) {
    const run = this.store.getRun(parentRunId); if (!run) throw new Error("Parent TaskRun not found");
    return this.createDecision(run, run.lastEventSeq, "manual", "pause_for_approval", "parallel_task_start_requested", `Start related Session Inbox task ${inboxItemId}: ${summary}`, 1);
  }

  markExecuted(id: string, status: "executed" | "superseded" | "failed", error = "") {
    return this.store.updateSupervisorDecision(id, status, error);
  }

  private createDecision(run: GovernanceTaskRunView, checkpointSeq: number, trigger: SupervisorDecision["trigger"], action: SupervisorAction, reasonCode: string, rationale: string, confidence: number, candidateResponse = "", evaluatorOverride?: SupervisorDecision["evaluator"], evaluatorModelOverride?: string) {
    const reviewed = trigger === "attempt_terminal" || (trigger === "settled" && !["wait_for_runtime"].includes(action));
    const evaluator = evaluatorOverride ?? (reviewed ? this.reviewer.evaluator : "system");
    const evaluatorModel = evaluatorModelOverride ?? (reviewed ? this.reviewer.model : "");
    const decision: SupervisorDecision = { id: randomUUID(), runId: run.id, evaluator, evaluatorModel, attempt: run.attempt, checkpointSeq, trigger, action, reasonCode, rationale, confidence, instruction: action === "steer" || action === "follow_up" ? rationale : "", candidateResponseHash: createHash("sha256").update(candidateResponse).digest("hex"), status: "proposed", error: "", createdAt: Date.now(), executedAt: null };
    return this.store.recordSupervisorDecision(decision);
  }
}
