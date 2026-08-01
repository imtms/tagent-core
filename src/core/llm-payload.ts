import type { TaskRun } from "./types.js";

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
    } : null,
    plan: run.plan.slice(0, 50).map(({ key, title, status, required, position }) => ({ key, title: truncateUtf8(title, 500), status, required, position })),
    checks: run.checks.slice(0, 50).map(({ key, title, status, required, command, evidence, stale }) => ({ key, title: truncateUtf8(title, 500), status, required, command: truncateUtf8(command, 500), evidence: truncateUtf8(evidence, 1_000), stale })),
    artifacts: run.artifacts.slice(0, 30).map(({ id, title, kind, uri }) => ({ id, title: truncateUtf8(title, 500), kind, uri: truncateUtf8(uri, 1_000) })),
    completionGate: run.completionGate,
  };
}
