import { createHash, randomUUID } from "node:crypto";
import type { RunEventPublisherPort } from "@tagent/execution/composition";
import type { AttemptRepository, TaskRunRepository } from "@tagent/execution/ports";
import type {
  AcceptedUncertainty,
  GateEvaluation,
  SupervisorDecision,
} from "@tagent/governance/domain";
import { effectiveGateProfile, stableJson } from "@tagent/governance/domain";
import { enforceCompletionAuditAlgebra } from "@tagent/governance/application";
import type {
  AcceptedUncertaintyRepository,
  SupervisorPersistencePort,
} from "@tagent/governance/ports";

type RunGovernancePersistence = {
  mutations: { run<T>(work: () => T): T };
  taskRuns: Pick<TaskRunRepository, "getRun">;
  attempts: Pick<AttemptRepository,
    "getAttemptForRun" | "getCandidateForAttempt" | "reAdjudicateBlockedCandidate">;
  uncertainties: AcceptedUncertaintyRepository;
  supervisor: Pick<SupervisorPersistencePort, "recordGateEvaluation" | "recordSupervisorDecision">;
};

type RunGovernanceDependencies = {
  eventHub: Pick<RunEventPublisherPort, "publish">;
  taskFinalized?: (runId: string) => void;
};

const gateTypes = ["progress", "evidence", "contract", "completion", "continuation"] as const;

function normalizeEvidenceRefs(values: readonly string[] = []): string[] {
  if (values.length > 100) throw new Error("Accepted uncertainty has too many evidence references");
  const refs = [...new Set(values.map((ref) => ref.trim()).filter(Boolean))];
  if (refs.some((ref) => ref.includes("\0") || ref.length > 2_000)) {
    throw new Error("Accepted uncertainty evidence reference is invalid");
  }
  return refs;
}

/** Authorized control-plane governance decisions; intentionally not exposed through Agent tools. */
export class CoreRunGovernanceApplication {
  constructor(
    private readonly persistence: RunGovernancePersistence,
    private readonly dependencies: RunGovernanceDependencies,
  ) {}

  acceptRunUncertainty(input: {
    decisionId: string;
    runId: string;
    criterionId: string;
    actorId: string;
    rationale: string;
    scope: string;
    evidenceRefs?: string[];
    expiresAt?: number | null;
  }): AcceptedUncertainty & { runCompleted: boolean } {
    const uncertaintyId = `uncertainty:${input.runId}:${input.decisionId}`;
    const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs);
    const prior = this.persistence.uncertainties.listAcceptedUncertainties(input.runId)
      .find((item) => item.id === uncertaintyId);
    if (prior) {
      const expected = {
        runId: input.runId, criterionId: input.criterionId, actorId: input.actorId.trim(),
        rationale: input.rationale.trim(), scope: input.scope.trim(),
        evidenceRefs,
        expiresAt: input.expiresAt ?? null,
      };
      const observed = {
        runId: prior.runId, criterionId: prior.criterionId, actorId: prior.actorId,
        rationale: prior.rationale, scope: prior.scope, evidenceRefs: prior.evidenceRefs,
        expiresAt: prior.expiresAt,
      };
      if (stableJson(expected) !== stableJson(observed)) {
        throw new Error("Accepted uncertainty decision id already exists with different content");
      }
      return { ...prior, runCompleted: this.persistence.taskRuns.getRun(input.runId)?.status === "completed" };
    }

    const outcome = this.persistence.mutations.run(() => {
      const run = this.persistence.taskRuns.getRun(input.runId);
      if (!run?.contract) throw new Error("TaskRun has no immutable contract to qualify");
      if (run.status !== "blocked") throw new Error("Accepted uncertainty requires a blocked TaskRun Candidate");
      if (effectiveGateProfile(run.contract) !== "strict") {
        throw new Error("Accepted uncertainty is only valid for a strict completion Gate");
      }
      const latestDecision = run.supervision.latestDecision;
      if (!latestDecision || latestDecision.attempt !== run.attempt
        || latestDecision.action !== "block_taskrun" || latestDecision.status !== "executed") {
        throw new Error("TaskRun has no current executed blocking decision to re-adjudicate");
      }
      const attempt = this.persistence.attempts.getAttemptForRun(run.id, run.attempt);
      const candidate = attempt && this.persistence.attempts.getCandidateForAttempt(attempt.id);
      if (!attempt || attempt.status !== "blocked" || attempt.active
        || !candidate || candidate.status !== "rejected"
        || latestDecision.candidateResponseHash !== candidate.responseHash) {
        throw new Error("TaskRun has no integrity-bound rejected Candidate to re-adjudicate");
      }
      const match = /^ac-([1-9]\d*)$/.exec(input.criterionId);
      const index = match ? Number(match[1]) - 1 : -1;
      const coverage = run.supervision.latestGates.find((gate) => gate.gateType === "contract")?.criterionCoverage?.[index];
      if (!coverage || !["unsupported", "blocked"].includes(coverage.status)) {
        throw new Error("Only a currently unsupported or blocked criterion can receive accepted uncertainty");
      }
      const createdAt = Date.now();
      const uncertainty = this.persistence.uncertainties.acceptUncertainty({
        id: uncertaintyId,
        runId: input.runId,
        criterionId: input.criterionId,
        actorId: input.actorId,
        rationale: input.rationale,
        scope: input.scope,
        evidenceRefs,
        expiresAt: input.expiresAt ?? null,
        createdAt,
      });
      const activeUncertainties = this.persistence.uncertainties.listAcceptedUncertainties(run.id, createdAt);
      const latestGates = new Map(run.supervision.latestGates.map((gate) => [gate.gateType, gate]));
      if (gateTypes.some((type) => !latestGates.has(type))) {
        throw new Error("Blocked Candidate has an incomplete Gate evaluation set");
      }
      const sourceAudit = {
        action: latestDecision.action,
        reasonCode: latestDecision.reasonCode,
        rationale: latestDecision.rationale,
        gates: Object.fromEntries(gateTypes.map((type) => {
          const gate = latestGates.get(type)!;
          return [type, {
            passed: gate.passed,
            failures: structuredClone(gate.failures),
            criterionCoverage: gate.criterionCoverage?.map((item) => structuredClone(item)),
            summary: gate.summary,
          }];
        })) as Parameters<typeof enforceCompletionAuditAlgebra>[0]["gates"],
      };
      const audit = enforceCompletionAuditAlgebra(sourceAudit, "strict", activeUncertainties);
      if (audit.action !== "complete_taskrun" || !audit.gates.completion.passed) {
        return { uncertainty, runCompleted: false, event: undefined };
      }
      const checkpointSeq = run.lastEventSeq + 1;
      const inputManifestHash = createHash("sha256").update(stableJson({
        candidateResponseHash: candidate.responseHash,
        priorGateIds: gateTypes.map((type) => latestGates.get(type)!.id),
        acceptedUncertaintyIds: activeUncertainties.map((item) => item.id),
      })).digest("hex");
      const gates = gateTypes.map((gateType): GateEvaluation => ({
        id: randomUUID(),
        runId: run.id,
        attempt: run.attempt,
        checkpointSeq,
        gateType,
        evaluator: "system",
        evaluatorModel: "accepted-uncertainty-readjudication-v1",
        summary: audit.gates[gateType].summary,
        passed: audit.gates[gateType].passed,
        failures: audit.gates[gateType].failures,
        criterionCoverage: audit.gates[gateType].criterionCoverage,
        inputManifestHash,
        createdAt,
      }));
      for (const gate of gates) this.persistence.supervisor.recordGateEvaluation(gate);
      const decision: SupervisorDecision = {
        id: randomUUID(), runId: run.id, evaluator: "system",
        evaluatorModel: "accepted-uncertainty-readjudication-v1",
        attempt: run.attempt, checkpointSeq, trigger: "manual",
        action: "complete_taskrun", reasonCode: "accepted_uncertainty_readjudicated",
        rationale: "Every remaining unsupported or blocked acceptance criterion is covered by an active operator acceptance; Core re-adjudicated the preserved Candidate without rerunning the Agent.",
        confidence: 1, epistemicStatus: "deterministic", instruction: "",
        candidateResponseHash: candidate.responseHash, status: "proposed", error: "",
        createdAt, executedAt: null,
      };
      this.persistence.supervisor.recordSupervisorDecision(decision);
      const settled = this.persistence.attempts.reAdjudicateBlockedCandidate({
        attemptId: attempt.id,
        expectedVersion: attempt.version,
        candidateResultId: candidate.id,
        candidateResponseHash: candidate.responseHash,
        previousSupervisorDecisionId: latestDecision.id,
        supervisorDecisionId: decision.id,
        gateEvaluationIds: gates.map((gate) => gate.id),
        acceptedUncertaintyIds: activeUncertainties.map((item) => item.id),
        reason: decision.rationale,
        timestamp: createdAt,
      });
      return { uncertainty, runCompleted: true, event: settled.event };
    });
    if (outcome.event) this.dependencies.eventHub.publish(outcome.event);
    if (outcome.runCompleted) this.dependencies.taskFinalized?.(input.runId);
    return { ...outcome.uncertainty, runCompleted: outcome.runCompleted };
  }
}
