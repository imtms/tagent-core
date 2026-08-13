import type { AttemptRuntimeFactory } from "@tagent/execution/ports";
import type { MemoryFacade } from "@tagent/memory";
import type { LearningFeatureControl, SemanticJudge } from "@tagent/learning";
import type { AgentServicePersistencePort } from "./ports/index.js";
import type { CoreApplicationCoordinator } from "./core-application-coordinator.js";
import { composeExecutionApplication } from "../composition/execution-composition.js";
import type { ExecutionCoordinatorStartupOptions } from "@tagent/execution/composition";
import type { CoreRuntimeDefaults } from "../composition/execution-composition.js";

export type RuntimeDefaults = CoreRuntimeDefaults;

export type AgentServiceConstructorArguments = [
  persistence: AgentServicePersistencePort,
  workspace: string,
  runtimeFactory?: AttemptRuntimeFactory,
  runtimeDefaults?: RuntimeDefaults,
  memory?: MemoryFacade,
  memoryScopeId?: string,
  learningControl?: LearningFeatureControl,
  semanticJudge?: SemanticJudge,
  startupOptions?: ExecutionCoordinatorStartupOptions,
  projectRuleFiles?: string[],
  toolArtifactMaxBytes?: number,
];

export type AdmissionApplicationPort = Pick<CoreApplicationCoordinator,
  | "enqueueSessionInput" | "updateSessionInput" | "reorderSessionInputs"
  | "deleteSessionInput" | "decideSessionInput" | "mergeSessionInputs"
  | "startSessionInputNow" | "requestParallelSessionInputApproval"
  | "retryInboxLaunch" | "recoverSessionInbox" | "start"
  | "generateWorkspaceGoalRoadmap" | "startWorkspaceGoalRoadmapItem"
>;

export type ExecutionApplicationPort = Pick<CoreApplicationCoordinator,
  | "initialize" | "startBackgroundWork" | "closeRuntimes" | "recoverContinuations"
  | "enqueueControl" | "followUp" | "steer" | "compact" | "cancel" | "resume"
  | "approveRunApproval" | "rejectRunApproval" | "submitUserInput"
  | "subscribe" | "replay" | "getRun" | "getCurrentAttemptId"
>;

export type LearningApplicationPort = Pick<CoreApplicationCoordinator,
  | "teachWorkflow" | "listWorkflows" | "getWorkflow" | "requestWorkflowActivation"
  | "setWorkflowBindingMode" | "recordWorkflowApplication"
  | "getLearningCenter" | "decideWorkflowProposal" | "requestWorkflowProposalApplication"
  | "runWorkflowDistiller" | "retryWorkflowDistillation"
  | "listDeadLetterDistillations" | "executeWorkflowEvaluation" | "verifyWorkflowEvaluation"
  | "requestWorkflowPromotion" | "listAutonomyApprovals"
  | "decideAutonomyApproval" | "revokeAutonomyApproval"
  | "reviseWorkflow" | "setRunLearningPolicy" | "recordWorkflowFeedback"
  | "setCommunicationPreference" | "listCommunicationProfiles" | "lockCommunicationProfile"
  | "listLearningEvents" | "listCorrections" | "recordCorrection"
  | "listFeedbackAttribution" | "drainFeedbackAttribution"
>;

export type WorkflowGovernanceApplicationPort = Pick<CoreApplicationCoordinator,
  | "activateWorkflow" | "suspendWorkflow" | "rollbackWorkflow" | "forgetWorkflow"
  | "restoreWorkflow" | "applyWorkflowProposal" | "promoteWorkflow"
  | "executeAutonomyApproval" | "updateLearningSettings"
>;

export type SkillApplicationPort = Pick<CoreApplicationCoordinator,
  "listSkills" | "getSkill" | "listSkillRevisions" | "uploadSkill" | "updateSkill" | "deleteSkill"
  | "listWorkspaceSkills" | "replaceWorkspaceSkills"
>;

export type CoreApplicationPort = AdmissionApplicationPort
  & ExecutionApplicationPort
  & LearningApplicationPort
  & WorkflowGovernanceApplicationPort
  & SkillApplicationPort;

export function createAgentServiceApplications(
  ...args: AgentServiceConstructorArguments
): CoreApplicationPort {
  const [persistence, workspace, runtimeFactory, runtimeDefaults, memory, memoryScopeId, learningControl, semanticJudge, startupOptions, projectRuleFiles, toolArtifactMaxBytes] = args;
  return composeExecutionApplication({
    persistence, workspace, runtimeFactory, runtimeDefaults, memory,
    memoryScopeId, learningControl, semanticJudge, startupOptions, projectRuleFiles, toolArtifactMaxBytes,
  });
}
