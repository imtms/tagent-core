import type {
  CreateWorkspaceGoalInput,
  LinkWorkspaceGoalEvidenceInput,
  LinkWorkspaceGoalInboxInput,
  LinkWorkspaceGoalRunInput,
  WorkspaceGoal,
  WorkspaceGoalDecision,
  WorkspaceGoalDecisionInput,
  WorkspaceGoalEvidenceLink,
  WorkspaceGoalRoadmap,
  WorkspaceGoalRevision,
  WorkspaceGoalSummary,
} from "../domain/workspace-goal.js";

export interface WorkspaceGoalRepository {
  createGoal(input: CreateWorkspaceGoalInput): WorkspaceGoal;
  listGoals(workspaceId: string): WorkspaceGoalSummary[];
  getGoal(goalId: string): WorkspaceGoal | null;
  addDefinitionRevision(goalId: string, definition: CreateWorkspaceGoalInput["definition"], createdBy: string): WorkspaceGoalRevision;
  addRoadmapRevision(goalId: string, content: WorkspaceGoalRoadmap, sourceArtifactId: string | null, createdBy: string): WorkspaceGoalRevision;
  decideGoal(input: WorkspaceGoalDecisionInput): WorkspaceGoalDecision;
  linkRun(input: LinkWorkspaceGoalRunInput): WorkspaceGoal;
  linkInbox(input: LinkWorkspaceGoalInboxInput): void;
  attachRun(runId: string, inboxItemId: string | null): WorkspaceGoal | null;
  recordRunOutcome(runId: string): WorkspaceGoal | null;
  /** Repairs interrupted Inbox attachment and replays idempotent Run projections after restart. */
  reconcileRunState(): string[];
  linkEvidence(input: LinkWorkspaceGoalEvidenceInput): WorkspaceGoalEvidenceLink;
  authorizeRunMutation(runId: string): { allowed: boolean; reason: string };
}
