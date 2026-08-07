export type WorkspaceGoalStatus = "draft" | "active" | "paused" | "ready_to_close" | "completed" | "cancelled";
export type WorkspaceGoalRevisionKind = "definition" | "plan";
export type WorkspaceGoalDecisionKind = "approve_goal" | "approve_plan" | "request_change" | "pause" | "resume" | "close" | "cancel";
export type WorkspaceGoalEvidenceStatus = "valid" | "stale" | "contradicted";

export interface WorkspaceGoalCriterionDefinition {
  key: string;
  title: string;
  required: boolean;
}

export interface WorkspaceGoalDefinition {
  title: string;
  outcome: string;
  scope: string[];
  nonGoals: string[];
  criteria: WorkspaceGoalCriterionDefinition[];
  completionPolicy: "user_confirm";
}

export interface WorkspaceGoalPlanItem {
  id: string;
  title: string;
  outcome: string;
  verification: string;
}

export interface WorkspaceGoalPlan {
  summary: string;
  items: WorkspaceGoalPlanItem[];
}

export interface WorkspaceGoalRevision {
  id: string;
  goalId: string;
  kind: WorkspaceGoalRevisionKind;
  revision: number;
  content: WorkspaceGoalDefinition | WorkspaceGoalPlan;
  contentHash: string;
  sourceArtifactId: string | null;
  createdBy: string;
  createdAt: number;
}

export interface WorkspaceGoalDecision {
  id: string;
  requestId: string;
  payloadHash: string;
  goalId: string;
  targetRevisionId: string;
  targetHash: string;
  kind: WorkspaceGoalDecisionKind;
  approvedItemIds: string[];
  reason: string;
  actorId: string;
  createdAt: number;
}

export interface WorkspaceGoalRunLink {
  goalId: string;
  runId: string;
  goalRevision: number;
  planRevisionId: string | null;
  approvedItemIds: string[];
  criterionKeys: string[];
  createdAt: number;
}

export interface WorkspaceGoalEvidenceLink {
  id: string;
  goalId: string;
  goalRevision: number;
  criterionKey: string;
  runId: string;
  checkKey: string | null;
  artifactId: string | null;
  operationId: string | null;
  sourceDigest: string;
  status: WorkspaceGoalEvidenceStatus;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceGoalNextAction {
  actor: "user" | "system" | "none";
  kind: "review_goal" | "create_plan" | "review_plan" | "run_task" | "view_running_task" | "resolve_problem" | "resume" | "view_result";
  title: string;
  explanation: string;
  primaryActionLabel: string;
}

export interface WorkspaceGoal {
  id: string;
  workspaceId: string;
  status: WorkspaceGoalStatus;
  activeDefinitionRevisionId: string | null;
  activePlanRevisionId: string | null;
  currentRunId: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  definition: WorkspaceGoalRevision | null;
  plan: WorkspaceGoalRevision | null;
  decisions: WorkspaceGoalDecision[];
  runLinks: WorkspaceGoalRunLink[];
  evidenceLinks: WorkspaceGoalEvidenceLink[];
  requiredCriteria: number;
  verifiedCriteria: number;
  nextAction: WorkspaceGoalNextAction;
}

export interface WorkspaceGoalSummary {
  id: string;
  workspaceId: string;
  status: WorkspaceGoalStatus;
  title: string;
  outcome: string;
  requiredCriteria: number;
  verifiedCriteria: number;
  currentRunId: string | null;
  nextAction: WorkspaceGoalNextAction;
  createdAt: number;
  updatedAt: number;
}

export interface CreateWorkspaceGoalInput {
  workspaceId: string;
  definition: WorkspaceGoalDefinition;
  createdBy: string;
  idempotencyKey?: string;
}

export interface WorkspaceGoalDecisionInput {
  goalId: string;
  requestId?: string;
  targetRevisionId: string;
  targetHash: string;
  kind: WorkspaceGoalDecisionKind;
  approvedItemIds?: string[];
  reason?: string;
  actorId: string;
}

export interface LinkWorkspaceGoalRunInput {
  goalId: string;
  runId: string;
  goalRevision: number;
  planRevisionId?: string | null;
  approvedItemIds?: string[];
  criterionKeys?: string[];
}

export interface LinkWorkspaceGoalEvidenceInput {
  goalId: string;
  requestId?: string;
  goalRevision: number;
  criterionKey: string;
  runId: string;
  checkKey?: string | null;
  artifactId?: string | null;
  operationId?: string | null;
  sourceDigest?: string;
  status?: WorkspaceGoalEvidenceStatus;
}
