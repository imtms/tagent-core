import type { SessionInputAnalysis } from "../domain/session-input.js";

export interface GoalRoadmapAdmissionInput {
  goalId: string;
  goalOutcome: string;
  roadmapItem: {
    id: string;
    title: string;
    outcome: string;
    verification: string;
    criterionKeys: string[];
  };
}

/** Canonical Inbox payload for one explicitly approved Workspace Goal Roadmap item. */
export function buildGoalRoadmapAdmission(input: GoalRoadmapAdmissionInput): {
  content: string;
  analysis: SessionInputAnalysis;
} {
  const content = [
    `Advance Workspace Goal: ${input.goalOutcome}`,
    `Execute Goal Roadmap item: ${input.roadmapItem.title}`,
    `Expected outcome: ${input.roadmapItem.outcome}`,
    `Verification: ${input.roadmapItem.verification}`,
  ].join("\n");
  const analysis: SessionInputAnalysis = {
    summary: input.roadmapItem.title,
    objectives: [{ id: `roadmap-${input.roadmapItem.id}`, summary: input.roadmapItem.outcome, timing: "current", kind: "change" }],
    intent: "new_task",
    targetRunId: null,
    priority: 700,
    urgency: "normal",
    relation: "independent",
    acceptanceCriteria: [input.roadmapItem.outcome, input.roadmapItem.verification],
    scope: input.roadmapItem.outcome,
    nonGoals: [],
    confidence: 1,
    reason: `Explicitly launched from Workspace Goal ${input.goalId} Roadmap item ${input.roadmapItem.id}.`,
    routerVersion: "workspace-goal-roadmap-v1",
    executionPolicy: {
      mode: "workspace_mutation",
      sideEffectRisk: "workspace",
      evidencePolicy: "trusted_check",
      reviewPolicy: "full",
      policyVersion: "workspace-goal-v1",
      confidence: 1,
      reason: "Workspace Goal Roadmap execution mutates durable workspace state and requires trusted verification.",
    },
  };
  return { content, analysis };
}

export function matchesGoalRoadmapAdmission(
  actual: { content: string; analysis: SessionInputAnalysis },
  expected: ReturnType<typeof buildGoalRoadmapAdmission>,
): boolean {
  // Pre-policy Goal Inbox rows from early 0.8 builds did not persist the
  // explicit executionPolicy. The immutable Goal snapshot still raises those
  // exact legacy rows to Roadmap governance; every other field remains bound.
  const normalizedAnalysis = actual.analysis.executionPolicy
    ? actual.analysis
    : { ...actual.analysis, executionPolicy: expected.analysis.executionPolicy };
  return actual.content === expected.content && canonicalJson(normalizedAnalysis) === canonicalJson(expected.analysis);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
