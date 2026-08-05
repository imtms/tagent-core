import { describe, expect, it } from "vitest";
import {
  evaluateGovernanceApprovalAuthoritySwitch,
  GovernanceApprovalAuthoritySwitchRejectedError,
  selectGovernanceApprovalAuthority,
  type GovernanceApprovalAuthoritySwitchBlocker,
  type GovernanceApprovalAuthoritySwitchInput,
} from "@tagent/governance/domain";

function eligibleInput(
  requestedAuthority: GovernanceApprovalAuthoritySwitchInput["requestedAuthority"] = "canonical",
): GovernanceApprovalAuthoritySwitchInput {
  return {
    requestedAuthority,
    unresolved: {
      complete: true,
      summary: {
        total: 0,
        active: 0,
        bySource: { legacy_run: 0, legacy_workflow: 0 },
        activeBySource: { legacy_run: 0, legacy_workflow: 0 },
        byReason: {},
      },
    },
    comparisons: {
      complete: true,
      coverage: { expected: 2, compared: 2 },
      summary: {
        total: 2,
        match: 2,
        mismatch: 0,
        unresolved: 0,
        activeUnresolved: 0,
        missing: 0,
      },
    },
    handlers: {
      request: { ready: true, evidence: ["production request handler fitness passed"] },
      decide: { ready: true, evidence: ["production decide handler fitness passed"] },
      consume: { ready: true, evidence: ["production consume handler fitness passed"] },
      execute: { ready: true, evidence: ["production execute handler fitness passed"] },
    },
    noBypass: {
      approved: true,
      activeBypassCount: 0,
      evidence: ["production no-bypass audit approved"],
    },
  };
}

function expectBlocked(
  mutate: (input: GovernanceApprovalAuthoritySwitchInput) => void,
  blocker: GovernanceApprovalAuthoritySwitchBlocker,
) {
  const input = eligibleInput();
  mutate(input);
  const decision = evaluateGovernanceApprovalAuthoritySwitch(input);
  expect(decision).toMatchObject({
    requestedAuthority: "canonical",
    effectiveAuthority: "legacy",
    canonicalEligible: false,
    switchApproved: false,
  });
  expect(decision.blockers).toContain(blocker);
}

describe("Governance approval authority switch gate", () => {
  it("approves canonical only when every complete, non-vacuous evidence gate passes", () => {
    const input = eligibleInput();
    expect(evaluateGovernanceApprovalAuthoritySwitch(input)).toEqual({
      requestedAuthority: "canonical",
      effectiveAuthority: "canonical",
      canonicalEligible: true,
      switchApproved: true,
      blockers: [],
    });
    expect(selectGovernanceApprovalAuthority(input)).toBe("canonical");
  });

  it("keeps a legacy request on legacy without treating gate evidence as an authority switch", () => {
    const input = eligibleInput("legacy");
    input.handlers.execute.ready = false;
    const decision = evaluateGovernanceApprovalAuthoritySwitch(input);
    expect(decision).toMatchObject({
      requestedAuthority: "legacy",
      effectiveAuthority: "legacy",
      canonicalEligible: false,
      switchApproved: false,
    });
    expect(selectGovernanceApprovalAuthority(input)).toBe("legacy");
  });

  it("rejects an invalid authority at the Governance runtime boundary", () => {
    const input = eligibleInput() as unknown as { requestedAuthority: string };
    input.requestedAuthority = "shadow";
    expect(() => evaluateGovernanceApprovalAuthoritySwitch(input as unknown as GovernanceApprovalAuthoritySwitchInput))
      .toThrow("Governance approval authority request must be legacy or canonical");
    expect(() => selectGovernanceApprovalAuthority(input as unknown as GovernanceApprovalAuthoritySwitchInput))
      .toThrow(TypeError);
  });

  it("fails the current release closed while canonical handlers are dormant and no-bypass is unapproved", () => {
    const input = eligibleInput();
    for (const handler of ["request", "decide", "consume", "execute"] as const) {
      input.handlers[handler].ready = false;
      input.handlers[handler].evidence = [`current release ${handler} handler is dormant`];
    }
    input.noBypass.approved = false;
    input.noBypass.evidence = ["current release no-bypass gate has not been approved"];

    const decision = evaluateGovernanceApprovalAuthoritySwitch(input);
    expect(decision.blockers).toEqual([
      "request_handler_not_ready",
      "decide_handler_not_ready",
      "consume_handler_not_ready",
      "execute_handler_not_ready",
      "no_bypass_evidence_unapproved",
    ]);
    expect(decision).toMatchObject({ effectiveAuthority: "legacy", switchApproved: false });
    expect(() => selectGovernanceApprovalAuthority(input)).toThrow(
      "Governance approval authority canonical switch rejected: request_handler_not_ready",
    );
    try {
      selectGovernanceApprovalAuthority(input);
    } catch (error) {
      expect(error).toBeInstanceOf(GovernanceApprovalAuthoritySwitchRejectedError);
      expect((error as GovernanceApprovalAuthoritySwitchRejectedError).decision).toEqual(decision);
    }
  });

  it("requires a complete unresolved scan with zero active unresolved approvals", () => {
    expectBlocked((input) => { input.unresolved.complete = false; }, "unresolved_summary_incomplete");
    expectBlocked((input) => {
      input.unresolved.summary.total = 1;
    }, "unresolved_summary_invalid");
    expectBlocked((input) => {
      input.unresolved.summary.total = 1;
      input.unresolved.summary.active = 1;
      input.unresolved.summary.bySource = { legacy_run: 1, legacy_workflow: 0 };
      input.unresolved.summary.activeBySource = { legacy_run: 1, legacy_workflow: 0 };
    }, "active_unresolved_approvals");
  });

  it("requires complete, non-empty comparison coverage with no mismatch, unresolved, or missing rows", () => {
    expectBlocked((input) => { input.comparisons.complete = false; }, "comparison_summary_incomplete");
    expectBlocked((input) => {
      input.comparisons.coverage = { expected: 0, compared: 0 };
      input.comparisons.summary = {
        total: 0, match: 0, mismatch: 0, unresolved: 0, activeUnresolved: 0, missing: 0,
      };
    }, "comparison_coverage_empty");
    expectBlocked((input) => {
      input.comparisons.coverage.compared = 1;
      input.comparisons.summary.match = 1;
      input.comparisons.summary.missing = 1;
    }, "comparison_coverage_incomplete");
    expectBlocked((input) => {
      input.comparisons.summary.match = 1;
      input.comparisons.summary.mismatch = 1;
    }, "comparison_mismatch");
    expectBlocked((input) => {
      input.comparisons.summary.match = 1;
      input.comparisons.summary.unresolved = 1;
      input.comparisons.summary.activeUnresolved = 1;
    }, "comparison_unresolved");
    expectBlocked((input) => {
      input.comparisons.coverage.compared = 1;
      input.comparisons.summary.match = 1;
      input.comparisons.summary.missing = 1;
    }, "comparison_missing");
    expectBlocked((input) => {
      input.comparisons.summary.total = 3;
    }, "comparison_summary_invalid");
  });

  it("requires evidence-backed readiness for every production handler", () => {
    for (const handler of ["request", "decide", "consume", "execute"] as const) {
      expectBlocked((input) => { input.handlers[handler].ready = false; }, `${handler}_handler_not_ready`);
      expectBlocked((input) => { input.handlers[handler].evidence = []; }, `${handler}_handler_not_ready`);
    }
  });

  it("requires approved no-bypass evidence and zero active bypasses", () => {
    expectBlocked((input) => { input.noBypass.approved = false; }, "no_bypass_evidence_unapproved");
    expectBlocked((input) => { input.noBypass.evidence = []; }, "no_bypass_evidence_unapproved");
    expectBlocked((input) => { input.noBypass.activeBypassCount = -1; }, "no_bypass_evidence_invalid");
    expectBlocked((input) => { input.noBypass.activeBypassCount = 1; }, "active_approval_bypass");
  });
});
