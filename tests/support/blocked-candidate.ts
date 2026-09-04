import { randomUUID } from "node:crypto";
import type { TaskRunContractSnapshot } from "@tagent/execution/domain";
import type { CriterionCoverage, GateEvaluation, GateFailure, SupervisorDecision } from "@tagent/governance/domain";
import type { Store } from "@tagent/persistence-sqlite";
import { corePersistence } from "./test-persistence.js";

export function blockCandidateForUncertainty(
  store: Store,
  options: {
    sessionId?: string;
    statuses?: Array<"unsupported" | "blocked" | "contradicted">;
    response?: string;
    requestId?: string;
  } = {},
) {
  const sessionId = options.sessionId ?? store.createSession().id;
  const statuses = options.statuses ?? ["unsupported"];
  const response = options.response ?? "The requested result is unavailable after bounded investigation, and this limitation is documented.";
  const criteria = statuses.map((_, index) => `Acceptance criterion ${index + 1}`);
  const contract: TaskRunContractSnapshot = {
    sourceInput: "report irreducible uncertainty", summary: "Report irreducible uncertainty",
    objectives: [{ id: "objective-1", summary: "Investigate and report", timing: "current", kind: "investigate" }],
    acceptanceCriteria: criteria, scope: "This TaskRun only", nonGoals: [], sourceInboxIds: [],
    parentRunId: null, relation: "independent", intent: "new_task",
    decisionReason: "test fixture", routerVersion: "test",
    executionPolicy: {
      mode: "read_only_analysis", sideEffectRisk: "read_only", evidencePolicy: "operation_receipt",
      reviewPolicy: "full", gateProfile: "strict", policyVersion: "test", confidence: 1, reason: "test fixture",
    },
  };
  const run = store.createRun(sessionId, "report irreducible uncertainty", options.requestId, contract);
  const investigationArtifactId = `bounded-investigation:${run.id}`;
  store.addArtifact(run.id, {
    id: investigationArtifactId, kind: "text", title: "Bounded investigation",
    content: response, uri: "artifact://bounded-investigation",
  });
  store.upsertPlanItem(run.id, {
    key: "investigate", title: "Investigate", status: "done", required: true, position: 1,
    schemaVersion: 2, objectiveIds: ["objective-1"],
    criterionIds: criteria.map((_, index) => `ac-${index + 1}`), dependencies: [],
    completionEvidenceRefs: [`artifact:${investigationArtifactId}`],
  });
  const persistence = corePersistence(store);
  const attempt = persistence.attempts.getActiveAttempt(run.id)!;
  const ownerId = `blocked-candidate-fixture:${randomUUID()}`;
  const lease = persistence.attempts.acquireExecutionLease({
    attemptId: attempt.id, expectedVersion: attempt.version, ownerId, leaseMs: 60_000,
  });
  const candidate = persistence.attempts.recordCandidateResult({
    id: randomUUID(), attemptId: attempt.id, expectedVersion: attempt.version,
    leaseToken: lease.token, fence: lease.fence, response,
  });
  const coverage: CriterionCoverage[] = statuses.map((status, index) => ({
    criterion: criteria[index]!, status, evidenceRefs: [], reason: `${status} after bounded investigation`,
  }));
  const failures: GateFailure[] = statuses.map((status, index) => ({
    kind: "contract", key: `acceptance_criterion_${index + 1}`,
    reason: `Acceptance criterion is ${status}`,
    disposition: status === "contradicted" ? "non_recoverable" : "external_dependency",
  }));
  const checkpointSeq = run.lastEventSeq;
  const createdAt = Date.now();
  const gates = (["progress", "evidence", "contract", "completion", "continuation"] as const).map((gateType): GateEvaluation => {
    const gateFailures = gateType === "contract" || gateType === "completion" || gateType === "continuation" ? failures : [];
    return {
      id: randomUUID(), runId: run.id, attempt: run.attempt, checkpointSeq, gateType,
      evaluator: "llm", evaluatorModel: "fixture-supervisor",
      summary: gateFailures.length ? "Irreducible criterion uncertainty remains." : "Passed.",
      passed: gateFailures.length === 0, failures: structuredClone(gateFailures),
      criterionCoverage: gateType === "contract" || gateType === "completion" ? structuredClone(coverage) : undefined,
      inputManifestHash: "a".repeat(64), createdAt,
    };
  });
  for (const gate of gates) store.recordGateEvaluation(gate);
  const decision: SupervisorDecision = {
    id: randomUUID(), runId: run.id, evaluator: "llm", evaluatorModel: "fixture-supervisor",
    attempt: run.attempt, checkpointSeq, trigger: "settled", action: "block_taskrun",
    reasonCode: "irreducible_uncertainty", rationale: "An external dependency prevents full support.",
    confidence: 1, epistemicStatus: "model_assessed", instruction: "",
    candidateResponseHash: candidate.responseHash, status: "proposed", error: "", createdAt, executedAt: null,
  };
  store.recordSupervisorDecision(decision);
  const blockedAttempt = persistence.attempts.settleAttempt({
    attemptId: attempt.id, expectedVersion: candidate.attemptVersion,
    leaseToken: lease.token, fence: lease.fence, candidateResultId: candidate.id,
    supervisorDecisionId: decision.id, status: "blocked", reason: decision.rationale,
  });
  return { run: store.getRun(run.id)!, attempt: blockedAttempt, candidate, decision, gates, criteria };
}
