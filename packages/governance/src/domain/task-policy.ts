export type TaskExecutionMode =
  | "exact_delivery"
  | "semantic_delivery"
  | "read_only_analysis"
  | "workspace_mutation"
  | "external_action";

export type TaskSideEffectRisk = "none" | "read_only" | "workspace" | "external_high";
export type TaskEvidencePolicy = "none" | "semantic" | "operation_receipt" | "trusted_check";
export type TaskReviewPolicy = "local" | "semantic_lite" | "full";

/** Semantic policy proposed at Admission. Core may only preserve or raise it. */
export interface TaskExecutionPolicy {
  mode: TaskExecutionMode;
  sideEffectRisk: TaskSideEffectRisk;
  evidencePolicy: TaskEvidencePolicy;
  reviewPolicy: TaskReviewPolicy;
  policyVersion: string;
  confidence: number;
  reason: string;
  /** Present only when the user requested one literal response. */
  exactOutput?: string;
}

export interface TaskPolicyContractView {
  objectives: Array<{ timing: string; kind: string }>;
  workspaceGoal?: object | null;
  executionPolicy?: TaskExecutionPolicy | null;
}

export interface TaskPolicyOperationView {
  operationType: string;
  status: string;
  attempt: number;
}

const riskRank: Record<TaskSideEffectRisk, number> = { none: 0, read_only: 1, workspace: 2, external_high: 3 };
const evidenceRank: Record<TaskEvidencePolicy, number> = { none: 0, semantic: 1, operation_receipt: 2, trusted_check: 3 };
const reviewRank: Record<TaskReviewPolicy, number> = { local: 0, semantic_lite: 1, full: 2 };

function maxByRank<T extends string>(left: T, right: T, rank: Record<T, number>) {
  return rank[left] >= rank[right] ? left : right;
}

export function legacyTaskExecutionPolicy(contract: TaskPolicyContractView | null): TaskExecutionPolicy {
  const currentKinds = contract?.objectives.filter((item) => item.timing === "current").map((item) => item.kind) ?? [];
  const mutating = currentKinds.some((kind) => ["change", "verify", "release"].includes(kind));
  const discussion = currentKinds.length === 1 && currentKinds[0] === "answer";
  return {
    mode: mutating ? "workspace_mutation" : discussion ? "semantic_delivery" : "read_only_analysis",
    sideEffectRisk: mutating ? "workspace" : discussion ? "none" : "read_only",
    evidencePolicy: mutating ? "trusted_check" : discussion ? "semantic" : "operation_receipt",
    reviewPolicy: mutating || !discussion ? "full" : "semantic_lite",
    policyVersion: "legacy-conservative-v1",
    confidence: 1,
    reason: "Core conservatively derived policy for a legacy contract without an Admission execution policy.",
  };
}

/**
 * Applies Core-owned non-downgradable floors to the Admission proposal.
 * Observed mutation-capable operations and Workspace Goals always require full review.
 */
export function effectiveTaskExecutionPolicy(
  contract: TaskPolicyContractView | null,
  operations: TaskPolicyOperationView[] = [],
  currentAttempt?: number,
): TaskExecutionPolicy {
  const source = contract?.executionPolicy ?? legacyTaskExecutionPolicy(contract);
  const normalizedMode: TaskExecutionMode = source.mode === "external_action" || source.sideEffectRisk === "external_high"
    ? "external_action"
    : source.mode === "workspace_mutation" || source.sideEffectRisk === "workspace" || source.evidencePolicy === "trusted_check"
      ? "workspace_mutation"
      : source.mode === "read_only_analysis" || source.sideEffectRisk === "read_only" || source.evidencePolicy === "operation_receipt"
        ? "read_only_analysis"
        : source.mode === "semantic_delivery" || source.evidencePolicy === "semantic"
          || source.reviewPolicy !== "local" || !source.exactOutput?.trim()
          ? "semantic_delivery"
          : "exact_delivery";
  const profile = normalizedMode === "external_action"
    ? { sideEffectRisk: "external_high" as const, evidencePolicy: "trusted_check" as const, reviewPolicy: "full" as const }
    : normalizedMode === "workspace_mutation"
      ? { sideEffectRisk: "workspace" as const, evidencePolicy: "trusted_check" as const, reviewPolicy: "full" as const }
      : normalizedMode === "read_only_analysis"
        ? { sideEffectRisk: "read_only" as const, evidencePolicy: "operation_receipt" as const, reviewPolicy: "full" as const }
        : normalizedMode === "exact_delivery"
          ? { sideEffectRisk: "none" as const, evidencePolicy: "none" as const, reviewPolicy: "local" as const }
          : { sideEffectRisk: "none" as const, evidencePolicy: "semantic" as const, reviewPolicy: "semantic_lite" as const };
  const normalizedReviewPolicy = maxByRank(source.reviewPolicy, profile.reviewPolicy, reviewRank);
  const proposed: TaskExecutionPolicy = { ...source, mode: normalizedMode, ...profile, reviewPolicy: normalizedReviewPolicy };
  let mode = proposed.mode;
  let sideEffectRisk = proposed.sideEffectRisk;
  let evidencePolicy = proposed.evidencePolicy;
  let reviewPolicy = proposed.reviewPolicy;
  const reasons = [proposed.reason];
  if (normalizedMode !== source.mode || source.sideEffectRisk !== profile.sideEffectRisk
    || source.evidencePolicy !== profile.evidencePolicy || source.reviewPolicy !== normalizedReviewPolicy) {
    reasons.push("Core normalized an inconsistent execution-policy profile to its strongest safety implication.");
  }
  const currentOperations = currentAttempt === undefined ? operations : operations.filter((item) => item.attempt === currentAttempt);
  const mutationObserved = currentOperations.some((item) =>
    ["tool.write", "tool.edit", "tool.patch", "tool.bash", "tool.memory_forget"].includes(item.operationType)
    && item.status !== "pre_effect_rejected");
  if (contract?.workspaceGoal || mutationObserved) {
    mode = mode === "external_action" ? mode : "workspace_mutation";
    sideEffectRisk = maxByRank(sideEffectRisk, "workspace", riskRank);
    evidencePolicy = maxByRank(evidencePolicy, "trusted_check", evidenceRank);
    reviewPolicy = maxByRank(reviewPolicy, "full", reviewRank);
    reasons.push(contract?.workspaceGoal
      ? "Core raised the policy because a Workspace Goal is attached."
      : "Core raised the policy because a mutation-capable operation was observed in the current Attempt.");
  }
  if (mode === "external_action") {
    sideEffectRisk = "external_high";
    evidencePolicy = "trusted_check";
    reviewPolicy = "full";
  } else if (mode === "workspace_mutation") {
    sideEffectRisk = maxByRank(sideEffectRisk, "workspace", riskRank);
    evidencePolicy = maxByRank(evidencePolicy, "trusted_check", evidenceRank);
    reviewPolicy = "full";
  }
  if (reviewPolicy === "local" && mode !== "exact_delivery") reviewPolicy = "semantic_lite";
  return { ...proposed, mode, sideEffectRisk, evidencePolicy, reviewPolicy, reason: reasons.join(" ") };
}
