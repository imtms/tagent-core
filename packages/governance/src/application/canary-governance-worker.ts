import {
  canaryOutcomeDigest,
  type WorkflowCanaryPromotionCandidateView,
  WorkflowCanaryCheckEvidenceView,
  WorkflowCanaryDecisionEvidence,
  WorkflowCanaryOutcomeView,
} from "../domain/workflow-governance.js";
import type { WorkflowGovernancePersistencePort } from "../ports/workflow-governance-port.js";
import type { WorkflowGovernanceService } from "./workflow-governance-service.js";

const CANARY_CANDIDATE_SCAN_LIMIT = 32;

export type CanaryGovernanceWorkerResult =
  | { kind: "idle"; promotionId?: string; reason: "no_candidate" | "insufficient_samples" }
  | { kind: "stale"; promotionId: string }
  | {
      kind: "settled";
      promotionId: string;
      outcome: "promoted" | "rolled_back";
      outcomeDigest: string;
      commandId: string;
      evaluationReceiptId: string;
    }
  | { kind: "blocked"; promotionId: string; reason: string };

function assertTimestamp(timestamp: number): void {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError("Canary Governance timestamp is invalid");
  }
}

function sameCandidate(
  left: WorkflowCanaryDecisionEvidence["promotion"],
  right: WorkflowCanaryDecisionEvidence["promotion"],
): boolean {
  return left.promotionId === right.promotionId
    && left.workflowId === right.workflowId
    && left.scopeId === right.scopeId
    && left.candidateRevisionId === right.candidateRevisionId
    && left.previousRevisionId === right.previousRevisionId
    && left.authorizedMaxFailureDelta === right.authorizedMaxFailureDelta
    && left.status === right.status
    && left.createdAt === right.createdAt;
}

function sortedOutcomes(outcomes: readonly WorkflowCanaryOutcomeView[]): WorkflowCanaryOutcomeView[] {
  return [...outcomes].sort((left, right) => left.variant.localeCompare(right.variant)
    || left.runId.localeCompare(right.runId));
}

function sortedChecks(checks: readonly WorkflowCanaryCheckEvidenceView[]): WorkflowCanaryCheckEvidenceView[] {
  return [...checks].sort((left, right) => left.runId.localeCompare(right.runId)
    || left.checkKey.localeCompare(right.checkKey));
}

function successByRun(evidence: WorkflowCanaryDecisionEvidence): Map<string, boolean> {
  const outcomeRunIds = new Set<string>();
  for (const outcome of evidence.outcomes) {
    if (!outcome.runId || outcomeRunIds.has(outcome.runId)) {
      throw new Error("Canary evidence contains a duplicate or missing runId");
    }
    if (!Number.isSafeInteger(outcome.recordedAt) || outcome.recordedAt < 0) {
      throw new Error("Canary outcome recordedAt is invalid");
    }
    if (!Number.isSafeInteger(outcome.requiredChecks)
      || !Number.isSafeInteger(outcome.passedChecks)
      || outcome.requiredChecks < 0
      || outcome.passedChecks < 0
      || outcome.passedChecks > outcome.requiredChecks) {
      throw new Error("Canary outcome check counts are invalid");
    }
    const expectedSuccess = outcome.outcomeStatus === "completed"
      && outcome.requiredChecks > 0
      && outcome.passedChecks === outcome.requiredChecks;
    if (outcome.success !== expectedSuccess) {
      throw new Error("Canary outcome success conflicts with its durable check counts");
    }
    outcomeRunIds.add(outcome.runId);
  }
  const checkIds = new Set<string>();
  for (const check of evidence.checks) {
    const key = `${check.runId}\0${check.checkKey}`;
    if (!outcomeRunIds.has(check.runId) || !check.checkKey || checkIds.has(key)) {
      throw new Error("Canary check evidence is missing, duplicated, or refers to an unknown run");
    }
    checkIds.add(key);
  }
  return new Map(evidence.outcomes.map((outcome) => [outcome.runId, outcome.success]));
}

function average(values: boolean[]): number {
  return values.filter(Boolean).length / values.length;
}

/** Durable polling worker: startup recovery does not depend on an in-memory wake hint. */
export class CanaryGovernanceWorker {
  constructor(
    private readonly persistence: WorkflowGovernancePersistencePort,
    private readonly service: WorkflowGovernanceService,
  ) {}

  runOnce(timestamp = Date.now()): CanaryGovernanceWorkerResult {
    assertTimestamp(timestamp);
    const candidates = this.persistence.reader.listCanaryDecisionCandidates(CANARY_CANDIDATE_SCAN_LIMIT);
    if (!candidates.length) return { kind: "idle", reason: "no_candidate" };
    let deferred: CanaryGovernanceWorkerResult | undefined;
    for (const candidate of candidates) {
      const result = this.evaluateCandidate(candidate, timestamp);
      if (result.kind === "settled") return result;
      deferred ??= result;
    }
    return deferred ?? { kind: "idle", reason: "no_candidate" };
  }

  private evaluateCandidate(
    candidate: WorkflowCanaryPromotionCandidateView,
    timestamp: number,
  ): CanaryGovernanceWorkerResult {
    const evidence = this.persistence.reader.getCanaryDecisionEvidence(candidate.promotionId);
    if (!evidence || !sameCandidate(candidate, evidence.promotion)) {
      return { kind: "stale", promotionId: candidate.promotionId };
    }
    try {
      if (!Number.isFinite(candidate.authorizedMaxFailureDelta)
        || candidate.authorizedMaxFailureDelta < 0
        || candidate.authorizedMaxFailureDelta > 1) {
        throw new Error("authorized maxFailureDelta is invalid");
      }
      const baseline = evidence.outcomes.filter((outcome) => outcome.variant === "baseline");
      const candidateOutcomes = evidence.outcomes.filter((outcome) => outcome.variant === "candidate");
      if (baseline.length < 5 || candidateOutcomes.length < 5) {
        return { kind: "idle", promotionId: candidate.promotionId, reason: "insufficient_samples" };
      }
      const success = successByRun(evidence);
      const baselineRate = average(baseline.map((outcome) => success.get(outcome.runId)!));
      const candidateRate = average(candidateOutcomes.map((outcome) => success.get(outcome.runId)!));
      const evaluatedAt = Math.max(
        candidate.createdAt,
        ...evidence.outcomes.map((outcome) => outcome.recordedAt),
      );
      if (evaluatedAt > timestamp) throw new Error("Canary evidence is dated in the future");
      const outcome = candidateRate >= baselineRate - candidate.authorizedMaxFailureDelta
        ? "promoted" as const
        : "rolled_back" as const;
      const outcomeDigest = canaryOutcomeDigest(evidence);
      const durableOutcomes = sortedOutcomes(evidence.outcomes);
      const checkResults = sortedChecks(evidence.checks);
      const deterministicKey = `${candidate.promotionId}:${outcomeDigest}`;
      const commandId = `workflow-canary-settle:${deterministicKey}`;
      const evaluationReceiptId = `workflow-canary-evaluation:${deterministicKey}`;
      const result = this.service.settleCanary({
        commandId,
        workflowId: candidate.workflowId,
        scopeId: candidate.scopeId,
        promotionId: candidate.promotionId,
        outcome,
        activeRevisionId: outcome === "promoted"
          ? candidate.candidateRevisionId
          : candidate.previousRevisionId,
        evaluationReceipt: {
          id: evaluationReceiptId,
          promotionId: candidate.promotionId,
          outcomeDigest,
          outcome,
          baselineSampleSize: baseline.length,
          candidateSampleSize: candidateOutcomes.length,
          baselineSuccessRate: baselineRate,
          candidateSuccessRate: candidateRate,
          authorizedMaxFailureDelta: candidate.authorizedMaxFailureDelta,
          evaluationRunIds: durableOutcomes.map((item) => item.runId),
          outcomes: durableOutcomes,
          checkResults,
          evaluatedAt,
        },
        actorId: "canary_governance_worker",
        reason: outcome === "promoted" ? "canary passed" : "canary regression",
        timestamp: evaluatedAt,
      });
      if (result.commandId !== commandId) {
        return { kind: "stale", promotionId: candidate.promotionId };
      }
      return {
        kind: "settled",
        promotionId: candidate.promotionId,
        outcome,
        outcomeDigest,
        commandId,
        evaluationReceiptId,
      };
    } catch (error) {
      return {
        kind: "blocked",
        promotionId: candidate.promotionId,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
