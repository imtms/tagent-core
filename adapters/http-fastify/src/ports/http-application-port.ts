import type { AdmissionCoordinator } from "@tagent/admission";
import type { ExecutionCoordinator } from "@tagent/execution";
import type { WorkspaceGoal, WorkspaceGoalDecisionInput, WorkspaceGoalDefinition, WorkspaceGoalOperationReceipt, WorkspaceGoalRevision, WorkspaceGoalRoadmap, WorkspaceGoalSummary } from "@tagent/governance";

type HttpAdmissionApplicationPort = Pick<AdmissionCoordinator,
  | "enqueueSessionInput"
  | "updateSessionInputProfile" | "reorderSessionInputsProfile"
  | "deleteSessionInputProfile" | "decideSessionInputProfile" | "mergeSessionInputsProfile"
  | "startSessionInputNow" | "requestParallelSessionInputApproval" | "retryInboxLaunch"
>;

interface HttpWorkspaceGoalApplicationPort {
  listWorkspaceGoals(workspaceId:string):WorkspaceGoalSummary[];
  createWorkspaceGoal(workspaceId:string,input:{definition:WorkspaceGoalDefinition;actorId?:string;requestId?:string}):WorkspaceGoal;
  getWorkspaceGoal(goalId:string):WorkspaceGoal|null;
  reviseWorkspaceGoalDefinition(goalId:string,input:{definition:WorkspaceGoalDefinition;actorId?:string;requestId:string}):WorkspaceGoalRevision;
  reviseWorkspaceGoalRoadmap(goalId:string,input:{content:WorkspaceGoalRoadmap;sourceArtifactId?:string|null;actorId?:string;requestId:string}):WorkspaceGoal;
  requestWorkspaceGoalRoadmapGeneration(goalId:string,input:{requestId:string;actorId?:string}):Promise<WorkspaceGoal>;
  getWorkspaceGoalOperation(goalId:string,requestId:string):WorkspaceGoalOperationReceipt|undefined;
  startWorkspaceGoalRoadmapTask(goalId:string,roadmapItemId:string,requestId?:string):{goal:WorkspaceGoal;inboxItemId:string;runId:string|null};
  decideWorkspaceGoal(input:WorkspaceGoalDecisionInput):WorkspaceGoal;
}

type HttpExecutionApplicationPort = Pick<ExecutionCoordinator,
  | "closeRuntimes" | "followUp" | "steer" | "compact" | "cancel" | "resume"
  | "rejectRunApproval" | "submitUserInput" | "subscribe" | "replay" | "getRun"
  | "getCurrentAttemptId"
> & {
  approveRunApproval(approvalId: string, resolution?: string): unknown;
};

export type HttpApplicationPort = HttpAdmissionApplicationPort
  & HttpExecutionApplicationPort
  & HttpWorkspaceGoalApplicationPort
  & {
    listSkills(): unknown;
    getSkill(skillId: string): unknown;
    listSkillRevisions(skillId: string): unknown;
    uploadSkill(input: { filename: string; contentBase64: string }): unknown;
    updateSkill(skillId: string, input: { name: string; description: string; content: string; disableModelInvocation?: boolean }): unknown;
    deleteSkill(skillId: string): unknown;
    listWorkspaceSkills(workspaceId: string): unknown;
    replaceWorkspaceSkills(workspaceId: string, skillIds: readonly string[]): unknown;
    listSkillsProfile(query: import("@tagent/admission/ports").ProfilePageQuery): unknown;
    getSkillProfile(skillId: string): unknown;
    listSkillRevisionsProfile(skillId: string, query: import("@tagent/admission/ports").ProfilePageQuery): unknown;
    uploadSkillProfile(input: { filename: string; contentBase64: string }, mutation: import("@tagent/admission/ports").ProfileMutationContext): unknown;
    updateSkillProfile(skillId: string, input: { name: string; description: string; content: string; disableModelInvocation?: boolean }, mutation: import("@tagent/admission/ports").ProfileMutationContext): unknown;
    deleteSkillProfile(skillId: string, mutation: import("@tagent/admission/ports").ProfileMutationContext): unknown;
    listWorkspaceSkillsProfile(workspaceId: string, query: import("@tagent/admission/ports").ProfilePageQuery): unknown;
    replaceWorkspaceSkillsProfile(workspaceId: string, skillIds: readonly string[], mutation: import("@tagent/admission/ports").ProfileMutationContext): unknown;
  };
