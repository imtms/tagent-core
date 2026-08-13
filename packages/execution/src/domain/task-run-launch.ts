import type { TaskExecutionPolicy } from "@tagent/governance/domain";

export type TaskRunObjectiveTiming = "current" | "follow_up" | "parallel";
export type TaskRunObjectiveKind = "change" | "investigate" | "verify" | "document" | "release" | "answer" | "other";
export type TaskRunContractRelation = "same_goal" | "correction" | "constraint" | "follow_up" | "parallel" | "derived" | "depends_on" | "independent";
export type TaskRunIntent = "steer_active" | "follow_up_active" | "update_active_context" | "new_task" | "parallel_task" | "merge_candidate" | "discussion" | "clarification" | "defer";

export interface TaskRunObjectiveSnapshot {
  id: string;
  summary: string;
  timing: TaskRunObjectiveTiming;
  kind: TaskRunObjectiveKind;
}

export interface TaskRunWorkspaceGoalCriterionSnapshot {
  key: string;
  title: string;
  required: boolean;
}

export interface TaskRunWorkspaceGoalRoadmapItemSnapshot {
  id: string;
  title: string;
  outcome: string;
  verification: string;
  criterionKeys: string[];
}

/** Immutable Goal direction attached before the first Attempt starts. */
export interface TaskRunWorkspaceGoalSnapshot {
  goalId: string;
  mode: "workspace" | "roadmap";
  definitionRevisionId: string;
  definitionRevision: number;
  definitionHash: string;
  title: string;
  outcome: string;
  scope: string[];
  nonGoals: string[];
  criteria: TaskRunWorkspaceGoalCriterionSnapshot[];
  roadmapRevisionId: string | null;
  roadmapRevision: number | null;
  roadmapHash: string | null;
  approvedRoadmapItemIds: string[];
  targetRoadmapItemIds: string[];
  roadmapItems: TaskRunWorkspaceGoalRoadmapItemSnapshot[];
  targetCriterionKeys: string[];
  criterionPrompts: Array<{ key: string; prompt: string }>;
  attachedAt: number;
}

/** Immutable Skill revision selected when the TaskRun is admitted. */
export interface TaskRunSkillSnapshot {
  skillId: string;
  revisionId: string;
  revision: number;
  name: string;
  description: string;
  content: string;
  /** Model-visible workspace-relative path to SKILL.md. */
  filePath: string;
  sha256: string;
  disableModelInvocation: boolean;
}

/** Immutable Admission decision copied into the durable Execution aggregate. */
export interface TaskRunContractSnapshot {
  sourceInput: string;
  summary: string;
  objectives: TaskRunObjectiveSnapshot[];
  acceptanceCriteria: string[];
  scope: string;
  nonGoals: string[];
  sourceInboxIds: string[];
  parentRunId: string | null;
  relation: TaskRunContractRelation;
  intent: TaskRunIntent;
  decisionReason: string;
  routerVersion: string;
  executionPolicy?: TaskExecutionPolicy;
  workspaceGoal?: TaskRunWorkspaceGoalSnapshot | null;
  skill?: TaskRunSkillSnapshot | null;
}

/** Admission-facing command contract. Execution owns this persisted launch representation. */
export interface TaskRunLaunchSpec {
  sessionRef: string;
  goal: string;
  requestId: string;
  contract: TaskRunContractSnapshot | null;
}
