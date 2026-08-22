import type { TaskRun } from "../domain/task-run.js";
import type { TaskExecutionPolicy } from "@tagent/governance/domain";

const encoder = new TextEncoder();

export function utf8Bytes(value: string) { return encoder.encode(value).byteLength; }

export function truncateUtf8(value: string, maxBytes: number, marker = "\n[truncated]") {
  if (utf8Bytes(value) <= maxBytes) return value;
  const markerBytes = utf8Bytes(marker);
  const budget = Math.max(0, maxBytes - markerBytes);
  let low = 0; let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low) + marker;
}

function utf8Prefix(value: string, maxBytes: number) {
  if (utf8Bytes(value) <= maxBytes) return value;
  let low = 0; let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1])) low -= 1;
  return value.slice(0, low);
}

function utf8Suffix(value: string, maxBytes: number) {
  if (utf8Bytes(value) <= maxBytes) return value;
  let low = 0; let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (utf8Bytes(value.slice(value.length - middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  let start = value.length - low;
  if (start < value.length && /[\uDC00-\uDFFF]/.test(value[start])) start += 1;
  return value.slice(start);
}

/** Bounded review projection that keeps both the opening context and final delivery. */
export function projectUtf8HeadTail(value: string, maxBytes: number, headBytes = Math.floor(maxBytes * .4)) {
  const originalBytes = utf8Bytes(value);
  if (originalBytes <= maxBytes) return { text: value, originalBytes, projectedBytes: originalBytes, omittedBytes: 0, strategy: "full" as const };
  const marker = "\n\n[... middle omitted from Supervisor projection; durable candidate remains complete ...]\n\n";
  const markerBytes = utf8Bytes(marker);
  const contentBudget = Math.max(0, maxBytes - markerBytes);
  const boundedHeadBytes = Math.max(0, Math.min(headBytes, contentBudget));
  const text = utf8Prefix(value, boundedHeadBytes) + marker + utf8Suffix(value, contentBudget - boundedHeadBytes);
  const projectedBytes = utf8Bytes(text);
  return { text, originalBytes, projectedBytes, omittedBytes: originalBytes - projectedBytes + markerBytes, strategy: "head_tail" as const };
}

export function taskPolicySystemInstruction(policy: TaskExecutionPolicy): string {
  const gateProfile = policy.gateProfile ?? "strict";
  if (gateProfile === "off") return "Completion Gate is disabled for this TaskRun. Focus on the requested outcome and return the best final response directly; do not create plans, checks, Bash receipts, or Artifacts solely for settlement. Safety approvals and tool policies still apply.";
  if (gateProfile === "relaxed") return "This TaskRun uses result-oriented completion review. Focus on delivering the core outcome. Plans, checks, Bash receipts, and Artifacts are optional unless they genuinely help the work; do not create them solely for settlement. State meaningful uncertainty or blockers honestly.";
  if (["workspace_mutation", "external_action"].includes(policy.mode)) return "Use the task_run tool for substantial work. Maintain a plan and checks before claiming completion. A passed required check must follow a successful Bash verification in the current Attempt; task_run will bind it by exact command or the latest successful Bash receipt and Core will derive the evidence. Batch independent TaskRun mutations in one task_run action=batch call instead of spending a model round-trip per item.";
  if (policy.mode === "exact_delivery") return `Return exactly the requested literal output${policy.exactOutput ? `: ${JSON.stringify(policy.exactOutput)}` : ""}. Do not create plans, checks, Artifacts, or tool operations.`;
  if (policy.mode === "semantic_delivery") return "This is a no-side-effect semantic delivery. Do not create artificial plans, checks, Bash receipts, or workspace Artifacts. Produce one relevant, complete, standalone response; if you use a mutation-capable tool, Core will automatically raise the Run to full governance.";
  return "This is read-only analysis. Maintain a concise required plan for substantial investigation and cite actual inspected operations or Artifacts when they support factual conclusions. Do not mutate the workspace unless the user requested it; mutation automatically raises the Run to full trusted-check governance.";
}

export function taskPolicyResumeInstructions(policy: TaskExecutionPolicy): [string, string] {
  const gateProfile = policy.gateProfile ?? "strict";
  if (gateProfile === "off") return [
    "Completion Gate is disabled for this TaskRun; do not manufacture plan, check, receipt, or Artifact records for settlement.",
    "Address the remaining user request directly. Safety approvals and tool policies remain mandatory.",
  ];
  if (gateProfile === "relaxed") return [
    "This TaskRun uses result-oriented completion review; formal plans, trusted checks, and criterion-by-criterion evidence are not prerequisites.",
    "Repair only the missing or contradicted core outcome, then provide a relevant, coherent final delivery with uncertainty stated honestly.",
  ];
  if (["workspace_mutation", "external_action"].includes(policy.mode)) return [
    "Completion-gate requirements override conflicting instructions in the original goal, including instructions not to use task_run or not to create plan/check records.",
    "Before producing a final answer, run the actual verification command, then use one task_run action=batch call when possible to ensure at least one required plan item is done and every required check is bound to that successful Bash receipt. Agent-authored evidence text alone cannot pass the gate.",
  ];
  if (policy.mode === "read_only_analysis") return [
    "Completion-gate requirements override conflicting instructions in the original goal, including instructions not to use task_run or not to create a required investigation plan.",
    "Maintain a concise required plan and ground factual conclusions in successful inspected operations or Artifacts. Read-only analysis does not require an artificial Bash verification receipt; do not mutate the workspace unless the user requested it.",
  ];
  if (policy.mode === "exact_delivery") return [
    "This is an exact no-side-effect text delivery. Do not create plans, checks, Bash receipts, workspace Artifacts, or tool operations solely for settlement.",
    `Return exactly the requested literal output${policy.exactOutput ? `: ${JSON.stringify(policy.exactOutput)}` : ""}; Core will validate it locally.`,
  ];
  return [
    "This is a no-side-effect semantic delivery. Do not create artificial plans, checks, Bash receipts, or workspace Artifacts solely for settlement.",
    "Produce one complete standalone response that directly satisfies the contract; a compact semantic judge will evaluate it.",
  ];
}

/** Large immutable projection reused for every provider request in one Attempt. */
export function runtimeAttemptRunContext(run: TaskRun) {
  const workspaceGoal = run.contract?.workspaceGoal;
  const targetRoadmapItemIds = new Set(workspaceGoal?.targetRoadmapItemIds ?? []);
  const targetCriterionKeys = new Set(workspaceGoal?.targetCriterionKeys ?? []);
  return {
    id: run.id,
    attempt: run.attempt,
    goal: truncateUtf8(run.goal, 4_000),
    contract: run.contract ? {
      summary: truncateUtf8(run.contract.summary, 3_000),
      objectives: run.contract.objectives.slice(0, 20).map((item) => ({ ...item, summary: truncateUtf8(item.summary, 2_000) })),
      acceptanceCriteria: run.contract.acceptanceCriteria.slice(0, 30).map((item) => truncateUtf8(item, 2_000)),
      scope: truncateUtf8(run.contract.scope, 2_000),
      nonGoals: run.contract.nonGoals.slice(0, 20).map((item) => truncateUtf8(item, 1_000)),
      intent: run.contract.intent,
      relation: run.contract.relation,
      executionPolicy: run.contract.executionPolicy ?? null,
      skills: (run.contract.skills ?? []).slice(0, 32).map((skill) => ({
        skillId: skill.skillId, revisionId: skill.revisionId, revision: skill.revision, name: skill.name,
        description: truncateUtf8(skill.description, 1_000), filePath: skill.filePath, sha256: skill.sha256,
        disableModelInvocation: skill.disableModelInvocation,
      })),
      workspaceGoal: workspaceGoal ? {
        goalId: workspaceGoal.goalId,
        mode: workspaceGoal.mode,
        definitionRevision: workspaceGoal.definitionRevision,
        definitionHash: workspaceGoal.definitionHash,
        title: truncateUtf8(workspaceGoal.title, 500),
        outcome: truncateUtf8(workspaceGoal.outcome, 3_000),
        scope: workspaceGoal.scope.slice(0, 30).map((item) => truncateUtf8(item, 1_000)),
        nonGoals: workspaceGoal.nonGoals.slice(0, 30).map((item) => truncateUtf8(item, 1_000)),
        criteria: workspaceGoal.mode === "roadmap"
          ? workspaceGoal.criteria.filter((item) => targetCriterionKeys.has(item.key)).slice(0, 50).map((item) => ({ ...item, title: truncateUtf8(item.title, 1_000) }))
          : [],
        roadmapRevision: workspaceGoal.roadmapRevision,
        targetRoadmapItemIds: workspaceGoal.targetRoadmapItemIds.slice(0, 20),
        roadmapItems: workspaceGoal.mode === "roadmap"
          ? workspaceGoal.roadmapItems.filter((item) => targetRoadmapItemIds.has(item.id)).slice(0, 20).map((item) => ({
          ...item,
          title: truncateUtf8(item.title, 500),
          outcome: truncateUtf8(item.outcome, 2_000),
          verification: truncateUtf8(item.verification, 2_000),
          }))
          : [],
        targetCriterionKeys: workspaceGoal.targetCriterionKeys.slice(0, 50),
      } : null,
    } : null,
  };
}

/** Small mutable projection refreshed immediately before each provider request. */
export function runtimeLiveRunContext(run: TaskRun) {
  return {
    id: run.id,
    attempt: run.attempt,
    status: run.status,
    phase: run.phase,
    plan: run.plan.slice(0, 50).map(({ key, title, status, required, position }) => ({ key, title: truncateUtf8(title, 500), status, required, position })),
    checks: run.checks.slice(0, 50).map(({ key, title, status, required, stale, sourceOperationId }) => ({
      key, title: truncateUtf8(title, 500), status, required, stale, sourceOperationId: sourceOperationId ?? null,
    })),
    artifacts: run.artifacts.slice(0, 30).map(({ id, title, kind, uri }) => ({ id, title: truncateUtf8(title, 500), kind, uri: truncateUtf8(uri, 1_000) })),
    completionGate: {
      passed: run.completionGate.passed,
      failures: run.completionGate.failures.slice(0, 30).map(({ kind, key, reason }) => ({ kind, key, reason: truncateUtf8(reason, 1_000) })),
    },
  };
}

/** Compatibility projection for consumers that need the complete bounded model view. */
export function runtimeRunContext(run: TaskRun) {
  return { ...runtimeAttemptRunContext(run), ...runtimeLiveRunContext(run) };
}
