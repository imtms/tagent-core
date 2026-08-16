import type { AdmissionCoordinator } from "@tagent/admission";
import type { ExecutionCoordinator } from "@tagent/execution";

import type { LearningApplication } from "@tagent/learning/application";
import type {
  CommunicationDimension,
  WorkflowFeedbackSignal,
  WorkflowSpec,
} from "@tagent/learning";

export type HttpWorkflowSpec = WorkflowSpec;
export type HttpWorkflowFeedbackSignal = WorkflowFeedbackSignal;
export type HttpCommunicationDimension = CommunicationDimension;
export type HttpWorkflowApplicationInput =
  Parameters<LearningApplication["recordWorkflowApplication"]>[0];

export type HttpLearningApplicationPort = Pick<LearningApplication,
  | "teachWorkflow" | "listWorkflows" | "getWorkflow" | "requestWorkflowActivation"
  | "recordWorkflowApplication" | "getLearningCenter" | "decideWorkflowProposal"
  | "requestWorkflowProposalApplication" | "runWorkflowDistiller" | "retryWorkflowDistillation"
  | "listDeadLetterDistillations" | "executeWorkflowEvaluation" | "verifyWorkflowEvaluation"
  | "requestWorkflowPromotion" | "listAutonomyApprovals" | "listAutonomyApprovalsPage"
  | "getAutonomyApproval" | "decideAutonomyApproval" | "revokeAutonomyApproval"
  | "reviseWorkflow" | "setRunLearningPolicy" | "getRunLearningPolicy"
  | "recordWorkflowFeedback" | "setCommunicationPreference" | "listCommunicationProfiles"
  | "lockCommunicationProfile" | "listLearningEvents" | "listCorrections" | "recordCorrection"
  | "listFeedbackAttribution" | "drainFeedbackAttribution"
>;

interface HttpWorkflowGovernanceApplicationPort {
  activateWorkflow(workflowId: string, revisionId?: string, approvalId?: string): unknown;
  suspendWorkflow(workflowId: string, reason?: string): unknown;
  rollbackWorkflow(workflowId: string, revisionId: string, approvalId?: string): unknown;
  forgetWorkflow(workflowId: string, reason?: string, gracePeriodMs?: number): unknown;
  restoreWorkflow(workflowId: string): unknown;
  applyWorkflowProposal(id: string, actor: string, approvalId?: string): unknown;
  promoteWorkflow(workflowId: string, revisionId: string, canaryPercent?: number, maxFailureDelta?: number, approvalId?: string): unknown;
  executeAutonomyApproval(id: string, actor: string): unknown;
  updateLearningSettings(input: {
    memoryEnabled?: boolean;
    learningEnabled?: boolean;
    autoExecutionEnabled?: boolean;
    reason?: string;
  }): unknown;
}

type HttpAdmissionApplicationPort = Pick<AdmissionCoordinator,
  | "enqueueSessionInput"
  | "updateSessionInputProfile" | "reorderSessionInputsProfile"
  | "deleteSessionInputProfile" | "decideSessionInputProfile" | "mergeSessionInputsProfile"
  | "startSessionInputNow" | "requestParallelSessionInputApproval" | "retryInboxLaunch"
>;

interface HttpWorkspaceGoalApplicationPort {
  generateWorkspaceGoalRoadmap(goalId: string, actorId?: string): unknown;
  startWorkspaceGoalRoadmapItem(goalId: string, roadmapItemId: string, requestId?: string): unknown;
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
  & HttpLearningApplicationPort
  & HttpWorkflowGovernanceApplicationPort
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
