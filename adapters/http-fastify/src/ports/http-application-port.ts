import type { AdmissionCoordinator } from "@tagent/admission";
import type { ExecutionCoordinator } from "@tagent/execution";

interface HttpWorkflowStep {
  stepId: string;
  instruction: string;
  required: boolean;
  expectedArtifact?: string;
  failureHandling?: string;
}

export interface HttpWorkflowSpec {
  name: string;
  intent: string;
  cueTerms: string[];
  applicability: string[];
  nonApplicability: string[];
  preconditions: string[];
  inputContract: Array<{ name: string; description: string; required: boolean; schema?: string }>;
  outputContract: Array<{ name: string; description: string; required: boolean; schema?: string }>;
  steps: HttpWorkflowStep[];
  verification: Array<{ check: string; required: boolean; successCondition: string }>;
  requiredCapabilities: string[];
  riskClass: "low" | "medium" | "high";
}

export type HttpWorkflowFeedbackSignal = "successful" | "failed" | "corrected" | "harmful" | "helpful";
export type HttpCommunicationDimension = "language" | "verbosity" | "technicalDepth" | "answerStructure" | "progressUpdatePolicy" | "clarificationTolerance" | "uncertaintyStyle" | "challengeLevel" | "forbiddenPatterns";

export interface HttpWorkflowApplicationInput {
  bindingId: string;
  status: "exposed" | "adopted" | "partial" | "rejected";
  executedStepIds?: string[];
  skippedSteps?: Array<{ stepId: string; reason: string }>;
  correctionObserved?: boolean;
  repeatedToolCalls?: number;
  continuationCount?: number;
  verificationMapping?: Array<{ verificationCheck: string; runCheckKey: string }>;
}

export interface HttpLearningApplicationPort {
  teachWorkflow(sessionId: string, spec: HttpWorkflowSpec, sourceId?: string): unknown;
  listWorkflows(sessionId: string): unknown;
  getWorkflow(workflowId: string, includeDeleted?: boolean): unknown;
  requestWorkflowActivation(workflowId: string, revisionId?: string, actor?: string, reason?: string): unknown;
  recordWorkflowApplication(input: HttpWorkflowApplicationInput): unknown;
  getLearningCenter(sessionId: string): unknown;
  decideWorkflowProposal(id: string, decision: "approved" | "rejected", actor: string, reason?: string): unknown;
  requestWorkflowProposalApplication(id: string, actor: string, reason?: string): unknown;
  runWorkflowDistiller(owner?: string): unknown;
  retryWorkflowDistillation(id: string, repair?: { taskSignature?: string }): unknown;
  listDeadLetterDistillations(limit?: number): unknown;
  executeWorkflowEvaluation(input: { workflowId: string; candidateRevisionId: string; baselineRevisionId: string; kind: "shadow" | "offline_replay"; datasetId: string; baselineRunIds: string[]; candidateRunIds: string[] }): unknown;
  verifyWorkflowEvaluation(id: string): unknown;
  requestWorkflowPromotion(workflowId: string, revisionId: string, canaryPercent?: number, maxFailureDelta?: number, actor?: string): unknown;
  listAutonomyApprovals(scopeId: string, limit?: number): unknown;
  listAutonomyApprovalsPage(scopeId: string, query: {
    snapshotCreatedAt?: number;
    after?: { createdAt: number; id: string };
    limit: number;
  }): { items: unknown[]; snapshotCreatedAt: number };
  getAutonomyApproval(id: string): unknown;
  decideAutonomyApproval(id: string, decision: "approved" | "rejected", actor: string, reason?: string): unknown;
  revokeAutonomyApproval(id: string, actor: string, reason?: string): unknown;
  reviseWorkflow(workflowId: string, patch: Partial<HttpWorkflowSpec>, sourceId: string, changeSummary: string): unknown;
  setRunLearningPolicy(runId: string, policy: "allow" | "metadata_only" | "deny", reason?: string): unknown;
  getRunLearningPolicy(runId: string): unknown;
  recordWorkflowFeedback(input: { workflowId: string; revisionId: string; runId: string; attempt: number; signal: HttpWorkflowFeedbackSignal; idempotencyKey: string; note?: string; adopted?: boolean; verified?: boolean }): unknown;
  setCommunicationPreference(input: { subjectId: string; scopeType: "global" | "workspace" | "project" | "session"; scopeId: string; dimension: HttpCommunicationDimension; value: string | string[]; sourceType: "explicit_user" | "inferred" | "governance"; sourceRef: string; confidence?: number; expiresAt?: number }): unknown;
  listCommunicationProfiles(subjectId: string): unknown;
  lockCommunicationProfile(profileId: string, locked: boolean): unknown;
  listLearningEvents(sessionId: string, limit?: number): unknown;
  listCorrections(sessionId: string, limit?: number): unknown;
  recordCorrection(input: { sessionId: string; runId?: string; attempt?: number; messageId?: number; correctionType?: string; targetType?: string; targetId?: string; content: string; source?: "explicit_user" | "router" | "governance" }): unknown;
  listFeedbackAttribution(sessionId: string, limit?: number): unknown;
  drainFeedbackAttribution(limit?: number): unknown;
}

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
