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
  if (["workspace_mutation", "external_action"].includes(policy.mode)) return "Use the task_run tool for substantial work. Maintain a plan and checks before claiming completion. A passed required check must follow a successful Bash verification in the current Attempt; task_run will bind it by exact command or the latest successful Bash receipt and Core will derive the evidence. Batch independent TaskRun mutations in one task_run action=batch call instead of spending a model round-trip per item.";
  if (policy.mode === "exact_delivery") return `Return exactly the requested literal output${policy.exactOutput ? `: ${JSON.stringify(policy.exactOutput)}` : ""}. Do not create plans, checks, Artifacts, or tool operations.`;
  if (policy.mode === "semantic_delivery") return "This is a no-side-effect semantic delivery. Do not create artificial plans, checks, Bash receipts, or workspace Artifacts. Produce one relevant, complete, standalone response; if you use a mutation-capable tool, Core will automatically raise the Run to full governance.";
  return "This is read-only analysis. Maintain a concise required plan for substantial investigation and cite actual inspected operations or Artifacts when they support factual conclusions. Do not mutate the workspace unless the user requested it; mutation automatically raises the Run to full trusted-check governance.";
}

export function taskPolicyResumeInstructions(policy: TaskExecutionPolicy): [string, string] {
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

/** Minimal, bounded TaskRun projection used at the LLM boundary. Durable state remains in Store. */
export function runtimeRunContext(run: TaskRun) {
  return {
    id: run.id,
    status: run.status,
    phase: run.phase,
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
      skill: run.contract.skill ? {
        skillId: run.contract.skill.skillId,
        revisionId: run.contract.skill.revisionId,
        revision: run.contract.skill.revision,
        name: run.contract.skill.name,
        description: truncateUtf8(run.contract.skill.description, 1_000),
        filePath: run.contract.skill.filePath,
        sha256: run.contract.skill.sha256,
      } : null,
      workspaceGoal: run.contract.workspaceGoal ? {
        goalId: run.contract.workspaceGoal.goalId,
        mode: run.contract.workspaceGoal.mode,
        definitionRevision: run.contract.workspaceGoal.definitionRevision,
        definitionHash: run.contract.workspaceGoal.definitionHash,
        title: truncateUtf8(run.contract.workspaceGoal.title, 500),
        outcome: truncateUtf8(run.contract.workspaceGoal.outcome, 3_000),
        scope: run.contract.workspaceGoal.scope.slice(0, 30).map((item) => truncateUtf8(item, 1_000)),
        nonGoals: run.contract.workspaceGoal.nonGoals.slice(0, 30).map((item) => truncateUtf8(item, 1_000)),
        criteria: run.contract.workspaceGoal.criteria.slice(0, 100).map((item) => ({ ...item, title: truncateUtf8(item.title, 1_000) })),
        roadmapRevision: run.contract.workspaceGoal.roadmapRevision,
        approvedRoadmapItemIds: run.contract.workspaceGoal.approvedRoadmapItemIds.slice(0, 50),
        targetRoadmapItemIds: run.contract.workspaceGoal.targetRoadmapItemIds.slice(0, 20),
        roadmapItems: run.contract.workspaceGoal.roadmapItems.slice(0, 20).map((item) => ({
          ...item,
          title: truncateUtf8(item.title, 500),
          outcome: truncateUtf8(item.outcome, 2_000),
          verification: truncateUtf8(item.verification, 2_000),
        })),
        targetCriterionKeys: run.contract.workspaceGoal.targetCriterionKeys.slice(0, 100),
      } : null,
    } : null,
    plan: run.plan.slice(0, 50).map(({ key, title, status, required, position }) => ({ key, title: truncateUtf8(title, 500), status, required, position })),
    checks: run.checks.slice(0, 50).map(({ key, title, status, required, command, evidence, stale, sourceOperationId, observedAt }) => ({ key, title: truncateUtf8(title, 500), status, required, command: truncateUtf8(command, 500), evidence: truncateUtf8(evidence, 1_000), stale, sourceOperationId: sourceOperationId ?? null, observedAt: observedAt ?? null })),
    artifacts: run.artifacts.slice(0, 30).map(({ id, title, kind, uri }) => ({ id, title: truncateUtf8(title, 500), kind, uri: truncateUtf8(uri, 1_000) })),
    completionGate: run.completionGate,
  };
}
