export type WorkspaceGoalStatus = "draft" | "active" | "paused" | "ready_to_close" | "completed" | "cancelled";
export type WorkspaceGoalRevisionKind = "definition" | "roadmap";
export type WorkspaceGoalDecisionKind = "approve_goal" | "approve_roadmap" | "request_change" | "pause" | "resume" | "close" | "cancel";
export type WorkspaceGoalEvidenceStatus = "valid" | "stale" | "contradicted";
export type WorkspaceGoalRunLinkMode = "workspace" | "roadmap";
export type WorkspaceGoalRoadmapItemStatus = "unapproved" | "pending" | "running" | "completed" | "blocked";

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

export interface WorkspaceGoalRoadmapItem {
  id: string;
  title: string;
  outcome: string;
  verification: string;
  /** Goal criteria this bounded TaskRun is expected to advance. */
  criterionKeys: string[];
}

export interface WorkspaceGoalRoadmap {
  summary: string;
  items: WorkspaceGoalRoadmapItem[];
}

export interface WorkspaceGoalRevision {
  id: string;
  goalId: string;
  kind: WorkspaceGoalRevisionKind;
  revision: number;
  content: WorkspaceGoalDefinition | WorkspaceGoalRoadmap;
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
  roadmapRevisionId: string | null;
  roadmapItemIds: string[];
  criterionKeys: string[];
  mode: WorkspaceGoalRunLinkMode;
  createdAt: number;
}

export interface WorkspaceGoalRoadmapItemProgress {
  goalId: string;
  roadmapRevisionId: string;
  itemId: string;
  status: WorkspaceGoalRoadmapItemStatus;
  /** Supervisor Inbox work that has been admitted but has not attached a TaskRun yet. */
  queueStatus?: "queued" | "claimed" | null;
  inboxItemId?: string | null;
  runId: string | null;
  runStatus: "running" | "waiting_input" | "completed" | "blocked" | "interrupted" | "cancelled" | "failed" | null;
  retryable: boolean;
  updatedAt: number;
  completedAt: number | null;
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
  kind: "review_goal" | "generate_roadmap" | "review_roadmap" | "run_roadmap_item" | "view_running_task" | "resolve_problem" | "resume" | "view_result";
  title: string;
  explanation: string;
  primaryActionLabel: string;
  roadmapItemId: string | null;
  /** TaskRun to open when resolving an item that no longer owns Goal attention. */
  taskRunId?: string | null;
}

export interface WorkspaceGoal {
  id: string;
  workspaceId: string;
  status: WorkspaceGoalStatus;
  activeDefinitionRevisionId: string | null;
  activeRoadmapRevisionId: string | null;
  currentRunId: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  definition: WorkspaceGoalRevision | null;
  roadmap: WorkspaceGoalRevision | null;
  decisions: WorkspaceGoalDecision[];
  runLinks: WorkspaceGoalRunLink[];
  roadmapProgress: WorkspaceGoalRoadmapItemProgress[];
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
  roadmapRevisionId?: string | null;
  roadmapItemIds?: string[];
  criterionKeys?: string[];
  mode?: WorkspaceGoalRunLinkMode;
}

export interface LinkWorkspaceGoalInboxInput {
  goalId: string;
  inboxItemId: string;
  goalRevision: number;
  roadmapRevisionId: string;
  roadmapItemIds: string[];
  criterionKeys: string[];
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
  status?: WorkspaceGoalEvidenceStatus;
}
