import type { ApprovalSource } from "./approval.js";

/**
 * Selects the approval mutation authority only. Attempt execution authority is
 * a separate concern and is intentionally absent from this contract.
 */
export type GovernanceApprovalAuthority = "legacy" | "canonical";

export interface GovernanceApprovalUnresolvedSummary {
  total: number;
  active: number;
  bySource: Readonly<Record<ApprovalSource, number>>;
  activeBySource: Readonly<Record<ApprovalSource, number>>;
  byReason: Readonly<Record<string, number | undefined>>;
}

export interface GovernanceApprovalUnresolvedEvidence {
  complete: boolean;
  summary: GovernanceApprovalUnresolvedSummary;
}

export interface GovernanceApprovalComparisonSummary {
  total: number;
  match: number;
  mismatch: number;
  unresolved: number;
  activeUnresolved: number;
  missing: number;
}

export interface GovernanceApprovalComparisonEvidence {
  complete: boolean;
  coverage: {
    expected: number;
    compared: number;
  };
  summary: GovernanceApprovalComparisonSummary;
}

export type GovernanceApprovalHandler = "request" | "decide" | "consume" | "execute";

export interface GovernanceApprovalHandlerEvidence {
  ready: boolean;
  evidence: readonly string[];
}

export interface GovernanceApprovalNoBypassEvidence {
  approved: boolean;
  activeBypassCount: number;
  evidence: readonly string[];
}

export interface GovernanceApprovalAuthoritySwitchEvidence {
  unresolved: GovernanceApprovalUnresolvedEvidence;
  comparisons: GovernanceApprovalComparisonEvidence;
  handlers: Readonly<Record<GovernanceApprovalHandler, GovernanceApprovalHandlerEvidence>>;
  noBypass: GovernanceApprovalNoBypassEvidence;
}

export interface GovernanceApprovalAuthoritySwitchInput
extends GovernanceApprovalAuthoritySwitchEvidence {
  requestedAuthority: GovernanceApprovalAuthority;
}

export type GovernanceApprovalAuthoritySwitchBlocker =
  | "unresolved_summary_incomplete"
  | "unresolved_summary_invalid"
  | "active_unresolved_approvals"
  | "comparison_summary_incomplete"
  | "comparison_summary_invalid"
  | "comparison_coverage_empty"
  | "comparison_coverage_incomplete"
  | "comparison_mismatch"
  | "comparison_unresolved"
  | "comparison_missing"
  | "request_handler_not_ready"
  | "decide_handler_not_ready"
  | "consume_handler_not_ready"
  | "execute_handler_not_ready"
  | "no_bypass_evidence_invalid"
  | "no_bypass_evidence_unapproved"
  | "active_approval_bypass";

export interface GovernanceApprovalAuthoritySwitchDecision {
  requestedAuthority: GovernanceApprovalAuthority;
  effectiveAuthority: GovernanceApprovalAuthority;
  canonicalEligible: boolean;
  switchApproved: boolean;
  blockers: readonly GovernanceApprovalAuthoritySwitchBlocker[];
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasEvidence(items: readonly string[]): boolean {
  return Array.isArray(items) && items.length > 0
    && items.every((item) => typeof item === "string" && item.trim().length > 0);
}

function hasValidUnresolvedSummary(summary: GovernanceApprovalUnresolvedSummary): boolean {
  const counts = [
    summary.total,
    summary.active,
    summary.bySource.legacy_run,
    summary.bySource.legacy_workflow,
    summary.activeBySource.legacy_run,
    summary.activeBySource.legacy_workflow,
    ...Object.values(summary.byReason).filter((value): value is number => value !== undefined),
  ];
  return counts.every(isNonNegativeInteger)
    && summary.active <= summary.total
    && summary.bySource.legacy_run + summary.bySource.legacy_workflow === summary.total
    && summary.activeBySource.legacy_run + summary.activeBySource.legacy_workflow === summary.active
    && summary.activeBySource.legacy_run <= summary.bySource.legacy_run
    && summary.activeBySource.legacy_workflow <= summary.bySource.legacy_workflow;
}

function hasValidComparisonSummary(evidence: GovernanceApprovalComparisonEvidence): boolean {
  const { coverage, summary } = evidence;
  const counts = [
    coverage.expected,
    coverage.compared,
    summary.total,
    summary.match,
    summary.mismatch,
    summary.unresolved,
    summary.activeUnresolved,
    summary.missing,
  ];
  return counts.every(isNonNegativeInteger)
    && summary.activeUnresolved <= summary.unresolved
    && summary.total === coverage.expected
    && summary.match + summary.mismatch + summary.unresolved === coverage.compared
    && coverage.compared + summary.missing === summary.total;
}

export function evaluateGovernanceApprovalAuthoritySwitch(
  input: GovernanceApprovalAuthoritySwitchInput,
): GovernanceApprovalAuthoritySwitchDecision {
  if (input.requestedAuthority !== "legacy" && input.requestedAuthority !== "canonical") {
    throw new TypeError("Governance approval authority request must be legacy or canonical");
  }
  const blockers: GovernanceApprovalAuthoritySwitchBlocker[] = [];
  const unresolvedValid = hasValidUnresolvedSummary(input.unresolved.summary);
  if (!input.unresolved.complete) blockers.push("unresolved_summary_incomplete");
  if (!unresolvedValid) blockers.push("unresolved_summary_invalid");
  if (input.unresolved.summary.active !== 0) blockers.push("active_unresolved_approvals");

  const comparisonsValid = hasValidComparisonSummary(input.comparisons);
  if (!input.comparisons.complete) blockers.push("comparison_summary_incomplete");
  if (!comparisonsValid) blockers.push("comparison_summary_invalid");
  if (input.comparisons.coverage.expected === 0) blockers.push("comparison_coverage_empty");
  if (input.comparisons.coverage.compared !== input.comparisons.coverage.expected) {
    blockers.push("comparison_coverage_incomplete");
  }
  if (input.comparisons.summary.mismatch !== 0) blockers.push("comparison_mismatch");
  if (input.comparisons.summary.unresolved !== 0) blockers.push("comparison_unresolved");
  if (input.comparisons.summary.missing !== 0) blockers.push("comparison_missing");

  for (const handler of ["request", "decide", "consume", "execute"] as const) {
    const readiness = input.handlers[handler];
    if (!readiness.ready || !hasEvidence(readiness.evidence)) {
      blockers.push(`${handler}_handler_not_ready`);
    }
  }

  if (!isNonNegativeInteger(input.noBypass.activeBypassCount)) {
    blockers.push("no_bypass_evidence_invalid");
  }
  if (!input.noBypass.approved || !hasEvidence(input.noBypass.evidence)) {
    blockers.push("no_bypass_evidence_unapproved");
  }
  if (input.noBypass.activeBypassCount > 0) blockers.push("active_approval_bypass");

  const canonicalEligible = blockers.length === 0;
  const switchApproved = input.requestedAuthority === "canonical" && canonicalEligible;
  return Object.freeze({
    requestedAuthority: input.requestedAuthority,
    effectiveAuthority: switchApproved ? "canonical" : "legacy",
    canonicalEligible,
    switchApproved,
    blockers: Object.freeze(blockers),
  });
}

export class GovernanceApprovalAuthoritySwitchRejectedError extends Error {
  readonly decision: GovernanceApprovalAuthoritySwitchDecision;

  constructor(decision: GovernanceApprovalAuthoritySwitchDecision) {
    super(`Governance approval authority canonical switch rejected: ${decision.blockers.join(", ")}`);
    this.name = "GovernanceApprovalAuthoritySwitchRejectedError";
    this.decision = decision;
  }
}

/**
 * Composition roots call this before acquiring production resources. A legacy
 * request always remains legacy; a canonical request must have a fully approved
 * switch decision and otherwise fails closed with a stable error.
 */
export function selectGovernanceApprovalAuthority(
  input: GovernanceApprovalAuthoritySwitchInput,
): GovernanceApprovalAuthority {
  const decision = evaluateGovernanceApprovalAuthoritySwitch(input);
  if (input.requestedAuthority === "canonical" && !decision.switchApproved) {
    throw new GovernanceApprovalAuthoritySwitchRejectedError(decision);
  }
  return decision.effectiveAuthority;
}
