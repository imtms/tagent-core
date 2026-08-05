import { describe, expect, it } from "vitest";
import {
  CanaryGovernanceWorker,
  WorkflowGovernanceService,
  type OwnedWorkflowGovernanceCommit,
  type WorkflowCanaryCheckEvidenceView,
  type WorkflowCanaryOutcomeView,
  type WorkflowGovernanceEffectResult,
  type WorkflowGovernancePersistencePort,
} from "@tagent/governance";

function outcomes(
  prefix: string,
  baselineSamples = 5,
  candidateSamples = 5,
): WorkflowCanaryOutcomeView[] {
  return [
    ...Array.from({ length: baselineSamples }, (_, index) => ({
      runId: `${prefix}-baseline-${index}`,
      variant: "baseline" as const,
      outcomeStatus: "completed",
      success: true,
      requiredChecks: 1,
      passedChecks: 1,
      recordedAt: 20,
    })),
    ...Array.from({ length: candidateSamples }, (_, index) => {
      const success = index !== candidateSamples - 1;
      return {
        runId: `${prefix}-candidate-${index}`,
        variant: "candidate" as const,
        outcomeStatus: "completed",
        success,
        requiredChecks: 1,
        passedChecks: success ? 1 : 0,
        recordedAt: 20,
      };
    }),
  ];
}

function mutableChecks(
  durableOutcomes: readonly WorkflowCanaryOutcomeView[],
  drifted: boolean,
): WorkflowCanaryCheckEvidenceView[] {
  return durableOutcomes.map((outcome) => ({
    runId: outcome.runId,
    checkKey: "required-check",
    required: true,
    status: drifted ? "passed" : "failed",
    stale: !drifted,
  }));
}

describe("Canary Governance worker", () => {
  it("uses durable outcome summaries despite mutable check drift and replays settlement idempotently", () => {
    const promotion = {
      promotionId: "promotion-1",
      workflowId: "workflow-1",
      scopeId: "scope-1",
      candidateRevisionId: "revision-2",
      previousRevisionId: "revision-1",
      authorizedMaxFailureDelta: 0.2,
      status: "canary" as const,
      createdAt: 10,
    };
    const durableOutcomes = outcomes("promotion-1");
    const committed = new Map<string, { input: OwnedWorkflowGovernanceCommit; result: WorkflowGovernanceEffectResult }>();
    let businessMutations = 0;
    let evidenceReads = 0;
    const persistence: WorkflowGovernancePersistencePort = {
      unitOfWork: { run: (work) => work() },
      reader: {
        getState: () => undefined,
        getReceipt: () => undefined,
        getExecutableApproval: () => undefined,
        getApprovedProposal: () => undefined,
        getRevision: () => undefined,
        listCanaryDecisionCandidates: () => [promotion],
        getCanaryDecisionEvidence: () => {
          evidenceReads += 1;
          const driftedChecks = mutableChecks(durableOutcomes, false);
          return {
            promotion,
            outcomes: evidenceReads % 2 === 0 ? [...durableOutcomes].reverse() : durableOutcomes,
            checks: evidenceReads % 2 === 0 ? [...driftedChecks].reverse() : driftedChecks,
          };
        },
      },
      mutations: {
        commitApprovedEffect() { throw new Error("not used"); },
        commitOwnedEffect(input) {
          const existing = committed.get(input.command.commandId);
          if (existing) {
            expect(input).toEqual(existing.input);
            return existing.result;
          }
          businessMutations += 1;
          expect(input.command).toMatchObject({
            action: "workflow.canary.settle",
            outcome: "promoted",
            activeRevisionId: "revision-2",
            evaluationReceipt: {
              baselineSampleSize: 5,
              candidateSampleSize: 5,
              baselineSuccessRate: 1,
              candidateSuccessRate: 0.8,
              authorizedMaxFailureDelta: 0.2,
              outcomes: expect.arrayContaining([
                expect.objectContaining({ success: true, requiredChecks: 1, passedChecks: 1 }),
                expect.objectContaining({ success: false, requiredChecks: 1, passedChecks: 0 }),
              ]),
            },
          });
          const result: WorkflowGovernanceEffectResult = {
            commandId: input.command.commandId,
            state: null,
            receipts: input.receipts,
            value: { promotionId: promotion.promotionId },
          };
          committed.set(input.command.commandId, { input: structuredClone(input), result });
          return result;
        },
      },
    };
    const service = new WorkflowGovernanceService(persistence, {
      materialize() { throw new Error("not used"); },
    });

    const first = new CanaryGovernanceWorker(persistence, service).runOnce(100);
    const replay = new CanaryGovernanceWorker(persistence, service).runOnce(200);

    expect(first).toMatchObject({ kind: "settled", promotionId: "promotion-1", outcome: "promoted" });
    expect(replay).toEqual(first);
    expect(businessMutations).toBe(1);
    expect(committed.size).toBe(1);
  });

  it("scans a bounded candidate page so an insufficient head does not starve a ready promotion", () => {
    const insufficientPromotion = {
      promotionId: "promotion-insufficient",
      workflowId: "workflow-1",
      scopeId: "scope-1",
      candidateRevisionId: "revision-2",
      previousRevisionId: "revision-1",
      authorizedMaxFailureDelta: 0.2,
      status: "canary" as const,
      createdAt: 10,
    };
    const readyPromotion = {
      ...insufficientPromotion,
      promotionId: "promotion-ready",
      workflowId: "workflow-2",
      candidateRevisionId: "revision-4",
      previousRevisionId: "revision-3",
      createdAt: 11,
    };
    const insufficientOutcomes = outcomes("insufficient", 4, 4);
    const readyOutcomes = outcomes("ready");
    const requestedLimits: number[] = [];
    let settledPromotionId: string | undefined;
    const persistence: WorkflowGovernancePersistencePort = {
      unitOfWork: { run: (work) => work() },
      reader: {
        getState: () => undefined,
        getReceipt: () => undefined,
        getExecutableApproval: () => undefined,
        getApprovedProposal: () => undefined,
        getRevision: () => undefined,
        listCanaryDecisionCandidates: (limit) => {
          requestedLimits.push(limit);
          return [insufficientPromotion, readyPromotion].slice(0, limit);
        },
        getCanaryDecisionEvidence: (promotionId) => {
          if (promotionId === insufficientPromotion.promotionId) {
            return {
              promotion: insufficientPromotion,
              outcomes: insufficientOutcomes,
              checks: mutableChecks(insufficientOutcomes, false),
            };
          }
          if (promotionId === readyPromotion.promotionId) {
            return {
              promotion: readyPromotion,
              outcomes: readyOutcomes,
              checks: mutableChecks(readyOutcomes, false),
            };
          }
          return undefined;
        },
      },
      mutations: {
        commitApprovedEffect() { throw new Error("not used"); },
        commitOwnedEffect(input) {
          if (input.command.action !== "workflow.canary.settle") throw new Error("unexpected command");
          settledPromotionId = input.command.promotionId;
          return {
            commandId: input.command.commandId,
            state: null,
            receipts: input.receipts,
            value: { promotionId: input.command.promotionId },
          };
        },
      },
    };
    const service = new WorkflowGovernanceService(persistence, {
      materialize() { throw new Error("not used"); },
    });

    const result = new CanaryGovernanceWorker(persistence, service).runOnce(100);

    expect(result).toMatchObject({
      kind: "settled",
      promotionId: "promotion-ready",
      outcome: "promoted",
    });
    expect(settledPromotionId).toBe("promotion-ready");
    expect(requestedLimits).toHaveLength(1);
    expect(requestedLimits[0]).toBeGreaterThan(1);
    expect(requestedLimits[0]).toBeLessThanOrEqual(100);
  });
});
