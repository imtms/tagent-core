import { randomUUID } from "node:crypto";
import type { SessionId } from "@tagent/admission/domain";
import type { RunId } from "@tagent/execution/domain";
import {
  type WorkflowFeedbackSignal,
  type WorkflowSpec,
  WorkflowLearningService,
} from "../workflow-learning-service.js";
import {
  type CommunicationApplicability,
  type CommunicationDimension,
  LearningService,
} from "../learning-service.js";

/** Learning-owned application facade; it does not depend on Execution process state. */
export class LearningApplication {
  constructor(
    private readonly workflowService: WorkflowLearningService,
    private readonly learningService: LearningService,
  ) {}

  teachWorkflow(sessionId: SessionId, spec: WorkflowSpec, sourceId = `manual:${randomUUID()}`) { return this.workflowService.teach(sessionId, spec, sourceId); }
  listWorkflows(sessionId: SessionId) { return this.workflowService.listWorkflows(sessionId); }
  getWorkflow(workflowId: string) { return this.workflowService.getWorkflow(workflowId); }
  requestWorkflowActivation(workflowId: string, revisionId?: string, actor?: string, reason?: string) { return this.workflowService.requestActivation(workflowId, revisionId, actor, reason); }
  setWorkflowBindingMode(bindingId: string, mode: "suggested" | "adopted" | "partially_adopted" | "rejected") { return this.workflowService.setBindingMode(bindingId, mode); }
  recordWorkflowApplication(input: Parameters<WorkflowLearningService["recordApplication"]>[0]) { return this.workflowService.recordApplication(input); }
  getLearningCenter(sessionId: SessionId) { return this.workflowService.getLearningCenter(sessionId); }
  decideWorkflowProposal(id: string, decision: "approved" | "rejected", actor: string, reason?: string) { return this.workflowService.decideProposal(id, decision, actor, reason); }
  requestWorkflowProposalApplication(id: string, actor: string, reason?: string) { return this.workflowService.requestProposalApplication(id, actor, reason); }
  runWorkflowDistiller(owner?: string) { return this.workflowService.runNextDistillationJob(owner); }
  retryWorkflowDistillation(id: string, repair?: { taskSignature?: string }) { return this.workflowService.retryDistillationJob(id, repair); }
  listDeadLetterDistillations(limit?: number) { return this.workflowService.listDeadLetterJobs(limit); }
  executeWorkflowEvaluation(input: Parameters<WorkflowLearningService["executeEvaluation"]>[0]) { return this.workflowService.executeEvaluation(input); }
  verifyWorkflowEvaluation(id: string) { return this.workflowService.verifyEvaluationReceipt(id); }
  requestWorkflowPromotion(workflowId: string, revisionId: string, canaryPercent?: number, maxFailureDelta?: number, actor?: string) { return this.workflowService.requestPromotion(workflowId, revisionId, canaryPercent, maxFailureDelta, actor); }
  listAutonomyApprovals(scopeId: string, limit?: number) { return this.workflowService.listApprovals(scopeId, limit); }
  decideAutonomyApproval(id: string, decision: "approved" | "rejected", actor: string, reason?: string) { return this.workflowService.decideApproval(id, decision, actor, reason); }
  revokeAutonomyApproval(id: string, actor: string, reason?: string) { return this.workflowService.revokeApproval(id, actor, reason); }
  reviseWorkflow(workflowId: string, patch: Partial<WorkflowSpec>, sourceId: string, changeSummary: string) { return this.workflowService.revise(workflowId, patch, "user_correction", [sourceId], changeSummary); }
  setRunLearningPolicy(runId: RunId, policy: "allow" | "metadata_only" | "deny", reason?: string) { return this.workflowService.setRunLearningPolicy(runId, policy, reason); }
  recordWorkflowFeedback(input: { workflowId: string; revisionId: string; runId: string; attempt: number; signal: WorkflowFeedbackSignal; idempotencyKey: string; note?: string; adopted?: boolean; verified?: boolean }) { return this.workflowService.feedback(input); }
  setCommunicationPreference(input: { subjectId: string; scopeType: CommunicationApplicability; scopeId: string; dimension: CommunicationDimension; value: string | string[]; sourceType: "explicit_user" | "inferred" | "governance"; sourceRef: string; confidence?: number; expiresAt?: number }) { return this.learningService.recordCommunicationPreference(input); }
  listCommunicationProfiles(subjectId: string) { return this.learningService.listCommunicationProfiles(subjectId); }
  lockCommunicationProfile(profileId: string, locked: boolean) { return this.learningService.lockCommunicationProfile(profileId, locked); }
  listLearningEvents(sessionId: string, limit?: number) { return this.learningService.listLearningEvents(sessionId, limit); }
  listCorrections(sessionId: string, limit?: number) { return this.learningService.listCorrections(sessionId, limit); }
  recordCorrection(input: Parameters<LearningService["recordCorrection"]>[0]) { return this.learningService.recordCorrection(input); }
  listFeedbackAttribution(sessionId: string, limit?: number) { return this.learningService.listFeedbackAttribution(sessionId, limit); }
  drainFeedbackAttribution(limit?: number) { return this.learningService.drainFeedbackAttribution(limit); }
}
