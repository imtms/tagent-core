import type {
  AcceptedUncertainty,
  CriterionCoverage,
  GateFailure,
  SupervisorAction,
} from "../domain/governance.js";
import { deriveSupervisorAction } from "../domain/governance.js";

export type CompletionAuditGateType = "progress" | "evidence" | "contract" | "completion" | "continuation";

export interface CompletionAuditGate {
  passed: boolean;
  failures: GateFailure[];
  criterionCoverage?: CriterionCoverage[];
  summary: string;
}

export interface CompletionAuditAlgebraInput {
  action: SupervisorAction;
  reasonCode: string;
  rationale: string;
  gates: Record<CompletionAuditGateType, CompletionAuditGate>;
}

function uniqueFailures(failures: GateFailure[]) {
  const seen = new Set<string>();
  return failures.filter((failure) => {
    const key = `${failure.kind}\u0000${failure.key}\u0000${failure.reason}\u0000${failure.disposition}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Core-owned completion algebra. Accepted uncertainty can qualify only honest
 * unsupported/blocked criterion coverage; it never erases contradictions,
 * approvals, candidate-integrity failures, or unrelated Gate failures.
 */
export function enforceCompletionAuditAlgebra<T extends CompletionAuditAlgebraInput>(
  source: T,
  gateProfile: "relaxed" | "strict" = "strict",
  acceptedUncertainties: AcceptedUncertainty[] = [],
): Omit<T, keyof CompletionAuditAlgebraInput> & CompletionAuditAlgebraInput {
  const acceptedByCriterion = new Map(acceptedUncertainties.map((item) => [item.criterionId, item]));
  const acceptedFailureKeys = new Set<string>();
  const gates = Object.fromEntries(Object.entries(source.gates).map(([type, gate]) => [type, {
    ...gate,
    failures: [...gate.failures],
    criterionCoverage: gate.criterionCoverage?.map((coverage, index) => {
      // Only the contract Gate owns TaskRun acceptance-criterion identifiers.
      // Evidence may carry Workspace Goal coverage in the same array position;
      // accepting ac-N must never qualify gc-N or another Gate's failure.
      const accepted = type === "contract" ? acceptedByCriterion.get(`ac-${index + 1}`) : undefined;
      if (accepted && (coverage.status === "unsupported" || coverage.status === "blocked")) {
        acceptedFailureKeys.add(`ac-${index + 1}`);
        acceptedFailureKeys.add(`acceptance_criterion_${index + 1}`);
      }
      return {
        ...coverage,
        evidenceRefs: [...coverage.evidenceRefs],
        evidenceQuotes: coverage.evidenceQuotes?.map((quote) => structuredClone(quote)),
        ...(accepted && (coverage.status === "unsupported" || coverage.status === "blocked")
          ? { acceptedUncertaintyId: accepted.id }
          : {}),
      };
    }),
  }])) as CompletionAuditAlgebraInput["gates"];
  for (const [type, gate] of Object.entries(gates)) {
    const priorFailureCount = gate.failures.length;
    gate.failures = gate.failures.filter((failure) => !(
      (type === "contract" || type === "completion")
      && failure.kind === "contract"
      && acceptedFailureKeys.has(failure.key)
    ));
    if (priorFailureCount > gate.failures.length && gate.failures.length === 0) gate.passed = true;
  }
  const contractCoverageFailures: GateFailure[] = (gates.contract.criterionCoverage ?? []).flatMap((coverage, index) =>
    coverage.status === "covered" || coverage.acceptedUncertaintyId
      || (gateProfile === "relaxed" && coverage.status === "unsupported")
      ? []
      : [{
        kind: "contract",
        key: `acceptance_criterion_${index + 1}`,
        reason: `Acceptance criterion is ${coverage.status}: ${coverage.reason}`,
        disposition: coverage.status === "blocked" ? "external_dependency" as const : "auto_fixable" as const,
      }]);
  gates.contract.failures = uniqueFailures([...gates.contract.failures, ...contractCoverageFailures]);
  const contractCoveragePassed = gates.contract.criterionCoverage?.every((coverage) =>
    coverage.status === "covered"
    || Boolean(coverage.acceptedUncertaintyId)
    || (gateProfile === "relaxed" && coverage.status === "unsupported"));
  gates.contract.passed = gates.contract.failures.length === 0
    && (contractCoveragePassed ?? source.gates.contract.passed);
  gates.completion.failures = uniqueFailures([
    ...gates.completion.failures,
    ...gates.progress.failures,
    ...gates.evidence.failures,
    ...gates.contract.failures,
  ]);
  const unexplainedFailure = gates.completion.failures.length === 0
    && (["progress", "evidence", "contract", "completion"] as const)
      .some((type) => !source.gates[type].passed && source.gates[type].failures.length === 0);
  if (unexplainedFailure) gates.completion.failures.push({
    kind: "supervisor",
    key: "inconsistent_gate_state",
    reason: "A Supervisor Gate reported failure without an auditable failure reason; completion is fail-closed.",
    disposition: "non_recoverable",
  });
  gates.completion.passed = gates.progress.passed && gates.evidence.passed
    && gates.contract.passed && gates.completion.failures.length === 0;
  const action = deriveSupervisorAction(gates.completion.failures);
  return {
    ...source,
    gates,
    action,
    reasonCode: action === source.action ? source.reasonCode : `authoritative_${action}`,
    rationale: action === source.action
      ? source.rationale
      : `${source.rationale} Core corrected an inconsistent proposed action using authoritative gate failures.`,
  };
}
