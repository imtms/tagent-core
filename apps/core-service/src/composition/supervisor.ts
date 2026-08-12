import { createHash, randomUUID } from "node:crypto";
import type {
  CriterionCoverage,
  GateEvaluation,
  GateFailure,
  SupervisorAction,
  SupervisorDecision,
} from "@tagent/governance/domain";
import { deriveSupervisorAction, effectiveTaskExecutionPolicy } from "@tagent/governance/domain";
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
    if (!["run.updated", "tool.completed", "tool.guard.blocked"].includes(event.type)) return undefined;
    const run = this.store.getRun(runId);
    if (!run || run.status !== "running") return undefined;
    const snapshot = this.store.updateProgressSnapshot(run, event);
    if (event.type === "run.updated") return undefined;
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
    // Do not spend a model round-trip proving facts already authoritatively known by the local gate.
    // Semantic review still runs whenever deterministic prerequisites pass.
    const prerequisiteAudit = this.reviewDeterministicPrerequisites(run);
    const operations = prerequisiteAudit ? [] : this.store.listOperations(run.id, {
      limit: 16,
      ids: run.checks.flatMap((check) => check.sourceOperationId ? [check.sourceOperationId] : []),
    });
    const executionPolicy = effectiveTaskExecutionPolicy(run.contract, operations, run.attempt);
    const exactAudit = prerequisiteAudit ? undefined : this.reviewExactCompletion(run, response, operations, options, executionPolicy);
    const deterministicAudit = prerequisiteAudit ?? exactAudit;
    const progress = deterministicAudit ? undefined : this.store.getProgressSnapshot(run.id);
    const contextManifest = deterministicAudit ? undefined : this.store.getLatestContextManifest(run.id);
    const reviewInput = { run, response, modelOutputTruncated: options.modelOutputTruncated, operations, progress, contextManifest };
    const reviewedAudit = deterministicAudit ?? (executionPolicy.reviewPolicy === "semantic_lite" && this.reviewer.reviewSemanticLite
      ? await this.reviewer.reviewSemanticLite(reviewInput)
      : await this.reviewer.reviewSettled(reviewInput));
    const audit = this.enforceAuditAlgebra(reviewedAudit);
    const evaluator = deterministicAudit ? "system" as const : audit.evaluator ?? this.reviewer.evaluator;
    const evaluatorModel = prerequisiteAudit ? "deterministic-prerequisite-gate" : exactAudit ? "deterministic-exact-delivery-v1" : audit.evaluatorModel ?? this.reviewer.model;
    const createdAt = Date.now();
    const manifest = {
      attempt: run.attempt, checkpointSeq, contract: run.contract, plan: run.plan, checks: run.checks,
      artifacts: run.artifacts.map(({ id, kind, content, uri }) => ({ id, kind, uri, contentHash: createHash("sha256").update(content).digest("hex") })),
      operations: operations.map(({ id, attempt, operationType, payloadHash, status, stage, result, completedAt }) => ({
        id, attempt, operationType, payloadHash, status, stage, completedAt,
        resultHash: createHash("sha256").update(JSON.stringify(result ?? null)).digest("hex"),
      })),
      response, progress,
    };
    const inputManifestHash = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
    const gates = (["progress", "evidence", "contract", "completion", "continuation"] as const).map((gateType): GateEvaluation => {
      const reviewed = audit.gates[gateType];
      return { id: randomUUID(), runId: run.id, attempt: run.attempt, checkpointSeq, gateType, evaluator, evaluatorModel, summary: reviewed.summary, passed: reviewed.passed, failures: reviewed.failures, criterionCoverage: reviewed.criterionCoverage, inputManifestHash, createdAt };
    });
    for (const gate of gates) this.store.recordGateEvaluation(gate);
    return { gates, decision: this.createDecision(run, checkpointSeq, "settled", audit.action, audit.reasonCode, audit.rationale, audit.confidence, response, evaluator, evaluatorModel) };
  }

  private reviewExactCompletion(
    run: GovernanceTaskRunView,
    response: string,
    operations: OperationRecord[],
    options: { modelOutputTruncated?: boolean },
    executionPolicy: ReturnType<typeof effectiveTaskExecutionPolicy>,
  ): SupervisorAudit | undefined {
    const contract = run.contract;
    if (!contract) return undefined;
    if (executionPolicy.reviewPolicy !== "local" || executionPolicy.mode !== "exact_delivery") return undefined;
    const expected = executionPolicy.exactOutput?.trim();
    if (!expected) return undefined;
    const passed = !options.modelOutputTruncated && response.trim() === expected && operations.length === 0 && run.artifacts.length === 0;
    const coverage: CriterionCoverage[] = contract.acceptanceCriteria.map((criterion) => ({
      criterion,
      status: passed ? "covered" : "contradicted",
      evidenceRefs: [],
      reason: passed ? "Core matched the complete candidate to the requested literal output." : "The candidate did not exactly match the requested literal output.",
    }));
    const failure: GateFailure = { kind: "contract", key: "exact_output", reason: "The candidate did not exactly match the requested literal output.", disposition: "auto_fixable" };
    const failures = passed ? [] : [failure];
    const gate = (summary: string, gateFailures: GateFailure[] = [], criterionCoverage?: CriterionCoverage[]) => ({ passed: gateFailures.length === 0, failures: gateFailures, summary, criterionCoverage });
    return {
      action: passed ? "complete_taskrun" : "start_continuation",
      reasonCode: passed ? "exact_delivery_validated" : "exact_delivery_mismatch",
      rationale: passed ? "Core exactly matched the requested literal delivery." : failure.reason,
      confidence: 1,
      evaluator: "system",
      evaluatorModel: "deterministic-exact-delivery-v1",
      gates: {
        progress: gate("Exact delivery requires no execution plan."),
        evidence: gate("Exact delivery requires no external evidence."),
        contract: gate(passed ? "The candidate exactly matches the requested literal output." : failure.reason, failures, coverage),
        completion: gate(passed ? "Exact delivery validation passed." : failure.reason, failures),
        continuation: gate(passed ? "No continuation is required." : "A corrected literal response can be produced automatically."),
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
      status: "unsupported",
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
    return {
      action: "start_continuation",
      reasonCode: planFailures.length ? "deterministic_plan_incomplete" : "deterministic_check_incomplete",
      rationale: `Skipped semantic Supervisor call because ${localFailures.length} authoritative prerequisite failure(s) require repair in a new Attempt.`,
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

  private enforceAuditAlgebra(source: SupervisorAudit): SupervisorAudit {
    const gates = Object.fromEntries(Object.entries(source.gates).map(([type, gate]) => [type, {
      ...gate,
      failures: [...gate.failures],
      criterionCoverage: gate.criterionCoverage?.map((coverage) => ({ ...coverage, evidenceRefs: [...coverage.evidenceRefs] })),
    }])) as SupervisorAudit["gates"];
    const contractCoverageFailures: GateFailure[] = (gates.contract.criterionCoverage ?? []).flatMap((coverage, index) =>
      coverage.status === "covered" ? [] : [{
        kind: "contract",
        key: `acceptance_criterion_${index + 1}`,
        reason: `Acceptance criterion is ${coverage.status}: ${coverage.reason}`,
        disposition: coverage.status === "blocked" ? "external_dependency" as const : "auto_fixable" as const,
      }]);
    gates.contract.failures = this.uniqueFailures([...gates.contract.failures, ...contractCoverageFailures]);
    gates.contract.passed = gates.contract.passed && gates.contract.failures.length === 0
      && (gates.contract.criterionCoverage?.every((coverage) => coverage.status === "covered") ?? true);
    gates.completion.failures = this.uniqueFailures([
      ...gates.completion.failures,
      ...gates.progress.failures,
      ...gates.evidence.failures,
      ...gates.contract.failures,
    ]);
    gates.completion.passed = gates.completion.passed && gates.progress.passed && gates.evidence.passed
      && gates.contract.passed && gates.completion.failures.length === 0;
    const action = deriveSupervisorAction(gates.completion.failures);
    return {
      ...source,
      gates,
      action,
      reasonCode: action === source.action ? source.reasonCode : `authoritative_${action}`,
      rationale: action === source.action ? source.rationale : `${source.rationale} Core corrected an inconsistent proposed action using authoritative gate failures.`,
    };
  }

  private uniqueFailures(failures: GateFailure[]) {
    const seen = new Set<string>();
    return failures.filter((failure) => {
      const key = `${failure.kind}\u0000${failure.key}\u0000${failure.reason}\u0000${failure.disposition}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async reviewAttemptFailure(run: GovernanceTaskRunView, checkpointSeq: number, error: string) {
    const deterministic = this.classifyAttemptFailure(error);
    if (deterministic) {
      return this.createDecision(run, checkpointSeq, "attempt_terminal", deterministic.action,
        deterministic.reasonCode, deterministic.rationale, 1, "", "system", "deterministic-runtime-failure-v1");
    }
    try {
      const audit = await this.reviewer.reviewAttemptFailure({ run, error });
      return this.createDecision(run, checkpointSeq, "attempt_terminal", audit.action, audit.reasonCode, audit.rationale, audit.confidence);
    } catch (failure) {
      return this.createDecision(run, checkpointSeq, "attempt_terminal", "block_taskrun",
        "runtime_failure_review_unavailable",
        `Runtime failed and the bounded semantic failure classifier was unavailable. The Run was safely terminalized without another Agent attempt. ${failure instanceof Error ? failure.message : String(failure)}`,
        1, "", "system", "deterministic-failure-fallback-v1");
    }
  }

  private classifyAttemptFailure(error: string): { action: "pause_for_approval" | "block_taskrun" | "start_continuation"; reasonCode: string; rationale: string } | undefined {
    const source = error.toLowerCase();
    if (/(?:approval required|requires? (?:explicit )?approval|needs? approval|等待.*审批|需要.*批准)/i.test(error)) {
      return { action: "pause_for_approval", reasonCode: "runtime_approval_required", rationale: `Runtime reported an explicit approval boundary: ${error}` };
    }
    if (/(?:\b401\b|\b403\b|unauthorized|forbidden|invalid api key|authentication|model is not allowed|missing (?:api key|configuration)|configuration error|unknown model)/i.test(source)) {
      return { action: "block_taskrun", reasonCode: "runtime_configuration_invalid", rationale: `Runtime authentication or configuration must be corrected externally: ${error}` };
    }
    if (/(?:\b408\b|\b429\b|\b50[0234]\b|rate.?limit|too many requests|timed?\s*out|timeout|econnreset|econnrefused|enotfound|socket hang up|network error|fetch failed|service unavailable|temporarily unavailable|context.?length)/i.test(source)) {
      return { action: "start_continuation", reasonCode: "runtime_transient_failure", rationale: `Runtime reported a known transient provider or transport failure: ${error}` };
    }
    return undefined;
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
