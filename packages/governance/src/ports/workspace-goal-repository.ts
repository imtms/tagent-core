import type {
  CreateWorkspaceGoalInput,
  LinkWorkspaceGoalEvidenceInput,
  LinkWorkspaceGoalRunInput,
  WorkspaceGoal,
  WorkspaceGoalDecision,
  WorkspaceGoalDecisionInput,
  WorkspaceGoalEvidenceLink,
  WorkspaceGoalPlan,
  WorkspaceGoalRevision,
  WorkspaceGoalSummary,
} from "../domain/workspace-goal.js";

export interface WorkspaceGoalRepository {
  createGoal(input: CreateWorkspaceGoalInput): WorkspaceGoal;
  listGoals(workspaceId: string): WorkspaceGoalSummary[];
  getGoal(goalId: string): WorkspaceGoal | null;
  addDefinitionRevision(goalId: string, definition: CreateWorkspaceGoalInput["definition"], createdBy: string): WorkspaceGoalRevision;
  addPlanRevision(goalId: string, content: WorkspaceGoalPlan, sourceArtifactId: string | null, createdBy: string): WorkspaceGoalRevision;
  decideGoal(input: WorkspaceGoalDecisionInput): WorkspaceGoalDecision;
  linkRun(input: LinkWorkspaceGoalRunInput): WorkspaceGoal;
  linkEvidence(input: LinkWorkspaceGoalEvidenceInput): WorkspaceGoalEvidenceLink;
  authorizeRunMutation(runId: string): { allowed: boolean; reason: string };
}
