import type { TaskRun } from "../domain/task-run.js";

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
