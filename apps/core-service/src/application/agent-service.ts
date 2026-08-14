import {
  createAgentServiceApplications,
  type AgentServiceConstructorArguments,
  type CoreApplicationPort,
} from "./agent-service-factory.js";

export type AgentServiceStartupOptions = NonNullable<AgentServiceConstructorArguments[8]>;

/** Compatibility facade for callers migrating to the narrow application ports. */
class AgentServiceFacade {
  readonly application: CoreApplicationPort;

  constructor(...args: AgentServiceConstructorArguments) {
    this.application = createAgentServiceApplications(...args);
  }
}

export type AgentService = AgentServiceFacade & CoreApplicationPort;

export const AgentService = AgentServiceFacade as unknown as {
  new (...args: AgentServiceConstructorArguments): AgentService;
  readonly prototype: AgentService;
};

const delegatedMethods = [
  "initialize", "startBackgroundWork", "closeRuntimes", "recoverContinuations",
  "enqueueControl", "followUp", "steer", "compact", "cancel", "resume",
  "approveRunApproval", "rejectRunApproval", "submitUserInput", "subscribe", "replay", "getRun", "getCurrentAttemptId",
  "enqueueSessionInput", "updateSessionInput", "reorderSessionInputs", "deleteSessionInput",
  "updateSessionInputProfile", "reorderSessionInputsProfile", "deleteSessionInputProfile",
  "decideSessionInput", "mergeSessionInputs", "startSessionInputNow",
  "decideSessionInputProfile", "mergeSessionInputsProfile",
  "requestParallelSessionInputApproval", "retryInboxLaunch", "recoverSessionInbox", "start",
  "generateWorkspaceGoalRoadmap", "startWorkspaceGoalRoadmapItem",
  "listSkills", "getSkill", "listSkillRevisions", "uploadSkill", "updateSkill", "deleteSkill",
  "listWorkspaceSkills", "replaceWorkspaceSkills",
  "listSkillsProfile", "getSkillProfile", "listSkillRevisionsProfile", "uploadSkillProfile",
  "updateSkillProfile", "deleteSkillProfile", "listWorkspaceSkillsProfile", "replaceWorkspaceSkillsProfile",
  "teachWorkflow", "listWorkflows", "getWorkflow", "requestWorkflowActivation", "activateWorkflow",
  "suspendWorkflow", "rollbackWorkflow", "forgetWorkflow", "restoreWorkflow", "setWorkflowBindingMode",
  "recordWorkflowApplication", "getLearningCenter", "decideWorkflowProposal",
  "requestWorkflowProposalApplication", "applyWorkflowProposal", "runWorkflowDistiller",
  "retryWorkflowDistillation", "listDeadLetterDistillations", "executeWorkflowEvaluation",
  "verifyWorkflowEvaluation", "requestWorkflowPromotion", "promoteWorkflow", "listAutonomyApprovals",
  "getAutonomyApproval", "decideAutonomyApproval", "revokeAutonomyApproval", "executeAutonomyApproval", "reviseWorkflow",
  "updateLearningSettings",
  "setRunLearningPolicy", "getRunLearningPolicy", "recordWorkflowFeedback", "setCommunicationPreference",
  "listCommunicationProfiles", "lockCommunicationProfile", "listLearningEvents", "listCorrections",
  "recordCorrection", "listFeedbackAttribution", "drainFeedbackAttribution",
] as const satisfies readonly (keyof CoreApplicationPort)[];

for (const method of delegatedMethods) {
  Object.defineProperty(AgentServiceFacade.prototype, method, {
    configurable: true,
    value(this: AgentServiceFacade, ...args: unknown[]) {
      const operation = this.application[method] as (...values: unknown[]) => unknown;
      return operation.apply(this.application, args);
    },
    writable: true,
  });
}
