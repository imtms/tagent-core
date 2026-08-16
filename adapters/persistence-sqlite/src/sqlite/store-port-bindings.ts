import type { RunEventJournal } from "@tagent/execution/ports";
import type { Store } from "../store.js";
import type { MutationUnitOfWork, SynchronousResult } from "../unit-of-work.js";
import type { SqliteAttemptRequestEnvelopeRepository } from "./attempt-request-envelope-repository.js";

type Operation<Args extends unknown[], Result> = (...args: Args) => Result;
type SynchronousOperation<Args extends unknown[], Result> =
  (...args: Args) => Result & SynchronousResult<Result>;

function query<Args extends unknown[], Result>(
  operation: Operation<Args, Result>,
): Operation<Args, Result> {
  return (...args) => operation(...args);
}

function mutation<Args extends unknown[], Result>(
  unitOfWork: MutationUnitOfWork,
  operation: SynchronousOperation<Args, Result>,
): Operation<Args, Result> {
  return (...args) => unitOfWork.run<Result>(() => operation(...args));
}

/** Binds Store compatibility methods to narrow application ports in one internal module. */
export function createStoreBackedPorts(
  store: Store,
  mutationUnitOfWork: MutationUnitOfWork,
  sqliteRequestEnvelopes: SqliteAttemptRequestEnvelopeRepository,
) {
  const mutate = <Args extends unknown[], Result>(operation: SynchronousOperation<Args, Result>) =>
    mutation(mutationUnitOfWork, operation);
  return {
    sessions: Object.freeze({
      createSession: mutate(store.createSession.bind(store)),
      createSessionIdempotent: mutate(store.createSessionIdempotent.bind(store)),
      listSessions: query(store.listSessions.bind(store)),
      getSession: query(store.getSession.bind(store)),
      updateSession: mutate(store.updateSession.bind(store)),
      renameSession: mutate(store.renameSession.bind(store)),
      listMessages: query(store.listMessages.bind(store)),
      listRecentMessages: query(store.listRecentMessages.bind(store)),
      appendMessage: mutate(store.appendMessage.bind(store)),
    }),

    skills: Object.freeze({
      createRevision: mutate(store.createSkillRevision.bind(store)),
      listSkills: query(store.listSkills.bind(store)),
      getSkill: query(store.getSkill.bind(store)),
      listRevisions: query(store.listSkillRevisions.bind(store)),
      getRevision: query(store.getSkillRevision.bind(store)),
      listWorkspaceSkills: query(store.listWorkspaceSkills.bind(store)),
      replaceWorkspaceSkills: mutate(store.replaceWorkspaceSkills.bind(store)),
      deleteSkill: mutate(store.deleteSkill.bind(store)),
      getCatalogRevision: query(store.getCatalogRevision.bind(store)),
      getSkillResourceRevision: query(store.getSkillResourceRevision.bind(store)),
      getWorkspaceSkillRevision: query(store.getWorkspaceSkillRevision.bind(store)),
      listProfileSkillsPage: query(store.listProfileSkillsPage.bind(store)),
      listProfileSkillRevisionsPage: query(store.listProfileSkillRevisionsPage.bind(store)),
      listProfileWorkspaceSkillsPage: query(store.listProfileWorkspaceSkillsPage.bind(store)),
      createRevisionProfile: mutate(store.createRevisionProfile.bind(store)),
      deleteSkillProfile: mutate(store.deleteSkillProfile.bind(store)),
      replaceWorkspaceSkillsProfile: mutate(store.replaceWorkspaceSkillsProfile.bind(store)),
    }),

    operatorRead: Object.freeze({
      listSessionsPage: query(store.listOperatorSessionsPage.bind(store)),
      listSessionTaskRunsPage: query(store.listOperatorSessionTaskRunsPage.bind(store)),
      getLatestSessionTaskRun: query(store.getLatestOperatorSessionTaskRun.bind(store)),
    }),

    taskRunCommands: Object.freeze({
      claimTaskRunCommand: mutate(store.claimTaskRunCommand.bind(store)),
      getTaskRunCommand: query(store.getTaskRunCommand.bind(store)),
      settleTaskRunCommand: mutate(store.settleTaskRunCommand.bind(store)),
    }),

    messageSources: Object.freeze({
      getMessageSource: query(store.getMessageSource.bind(store)),
      listDurableUserMessages: query(store.listDurableUserMessages.bind(store)),
    }),

    submissions: Object.freeze({
      updateSessionInboxItemProfile: mutate(store.updateSessionInboxItemProfile.bind(store)),
      reorderSessionInboxProfile: mutate(store.reorderSessionInboxProfile.bind(store)),
      deleteSessionInboxItemProfile: mutate(store.deleteSessionInboxItemProfile.bind(store)),
      decideSessionInboxItemProfile: mutate(store.decideSessionInboxItemProfile.bind(store)),
      mergeSessionInboxItemsProfile: mutate(store.mergeSessionInboxItemsProfile.bind(store)),
      enqueueSessionInbox: mutate(store.enqueueSessionInbox.bind(store)),
      getSessionInboxItem: query(store.getSessionInboxItem.bind(store)),
      getSessionSubmission: query(store.getSessionSubmission.bind(store)),
      recordSubmissionAudit: mutate(store.recordSubmissionAudit.bind(store)),
      getSubmissionAudit: query(store.getSubmissionAudit.bind(store)),
      getSessionPrincipalId: query(store.getSessionPrincipalId.bind(store)),
      listSessionInbox: query(store.listSessionInbox.bind(store)),
      routeSessionInboxItem: mutate(store.routeSessionInboxItem.bind(store)),
      findMergeCandidate: query(store.findMergeCandidate.bind(store)),
      markSessionInboxDuplicate: mutate(store.markSessionInboxDuplicate.bind(store)),
      discardSessionInboxItem: mutate(store.discardSessionInboxItem.bind(store)),
      decideSessionInboxItem: mutate(store.decideSessionInboxItem.bind(store)),
      claimNextSessionInbox: mutate(store.claimNextSessionInbox.bind(store)),
      claimSessionInboxNow: mutate(store.claimSessionInboxNow.bind(store)),
      recordSessionInboxLaunchFailure: mutate(store.recordSessionInboxLaunchFailure.bind(store)),
      retryInboxLaunch: mutate(store.retryInboxLaunch.bind(store)),
      listSessionsWithQueuedInbox: query(store.listSessionsWithQueuedInbox.bind(store)),
    }),

    taskRuns: Object.freeze({
      createRun: mutate(store.createRun.bind(store)),
      hasRun: query(store.hasRun.bind(store)),
      getRun: query(store.getRun.bind(store)),
      getRunExecutionState: query(store.getRunExecutionState.bind(store)),
      getRunByRequestId: query(store.getRunByRequestId.bind(store)),
      listRuns: query(store.listRuns.bind(store)),
      listRunSummaries: query(store.listRunSummaries.bind(store)),
      getLatestRun: query(store.getLatestRun.bind(store)),
      getActiveRun: query(store.getActiveRun.bind(store)),
      getPendingUserInputRequest: query(store.getPendingUserInputRequest.bind(store)),
      getPendingUserInputRequestById: query(store.getPendingUserInputRequestById.bind(store)),
      requestUserInput: mutate(store.requestUserInput.bind(store)),
      submitUserInput: mutate(store.submitUserInput.bind(store)),
      recordModelUsage: mutate(store.recordModelUsage.bind(store)),
      setRunPhase: mutate(store.setRunPhase.bind(store)),
      advanceRunPhase: mutate(store.advanceRunPhase.bind(store)),
      listTaskRunEdges: query(store.listTaskRunEdges.bind(store)),
      isRunResumable: query(store.isRunResumable.bind(store)),
    }),

    continuations: Object.freeze({
      nextContinuationLeaseExpiry: query(store.nextContinuationLeaseExpiry.bind(store)),
      ownsContinuationLease: query(store.ownsContinuationLease.bind(store)),
      queueSafeCrashRecoveryContinuations: mutate(store.queueSafeCrashRecoveryContinuations.bind(store)),
      recoverContinuationsAfterRestart: mutate(store.recoverContinuationsAfterRestart.bind(store)),
      releaseContinuationLease: mutate(store.releaseContinuationLease.bind(store)),
      releaseContinuationLeases: mutate(store.releaseContinuationLeases.bind(store)),
      renewContinuationLease: mutate(store.renewContinuationLease.bind(store)),
      listContinuations: query(store.listContinuations.bind(store)),
      queueContinuation: mutate(store.queueContinuation.bind(store)),
      claimContinuation: mutate(store.claimContinuation.bind(store)),
      updateContinuation: mutate(store.updateContinuation.bind(store)),
      cancelQueuedContinuations: mutate(store.cancelQueuedContinuations.bind(store)),
    }),

    controlInbox: Object.freeze({
      enqueueControl: mutate(store.enqueueControl.bind(store)),
      getControlItem: query(store.getControlItem.bind(store)),
      listControlInbox: query(store.listControlInbox.bind(store)),
      claimControlItem: mutate(store.claimControlItem.bind(store)),
      completeControlItem: mutate(store.completeControlItem.bind(store)),
    }),

    events: Object.freeze({
      appendEvent: ((runId, type, data) => mutationUnitOfWork.run(() => store.appendEvent(runId, type, data))) as RunEventJournal["appendEvent"],
      listEvents: query(store.listEvents.bind(store)),
    }),

    transcript: Object.freeze({
      getLastTranscriptSeq: query(store.getLastTranscriptSeq.bind(store)),
      getTranscriptCount: query(store.getTranscriptCount.bind(store)),
      appendTranscript: mutate(store.appendTranscript.bind(store)),
      listTranscriptEntries: query(store.listTranscriptEntries.bind(store)),
      searchTranscriptLiteral: query(store.searchTranscriptLiteral.bind(store)),
      listTranscript: query(store.listTranscript.bind(store)),
      repairTranscript: mutate(store.repairTranscript.bind(store)),
      listTranscriptView: query(store.listTranscriptView.bind(store)),
    }),

    checkpoints: Object.freeze({
      getCheckpoint: query(store.getCheckpoint.bind(store)),
      upsertCheckpoint: mutate(store.upsertCheckpoint.bind(store)),
    }),

    eventConsumers: Object.freeze({
      claimEventConsumer: mutate(store.claimEventConsumer.bind(store)),
      getEventConsumer: query(store.getEventConsumer.bind(store)),
      ackEventConsumer: mutate(store.ackEventConsumer.bind(store)),
    }),

    operations: Object.freeze({
      claimOperation: mutate(store.claimOperation.bind(store)),
      updateOperation: mutate(store.updateOperation.bind(store)),
      getOperation: query(store.getOperation.bind(store)),
      listOperations: query(store.listOperations.bind(store)),
      recordToolAttempt: mutate(store.recordToolAttempt.bind(store)),
      completeToolAttempt: mutate(store.completeToolAttempt.bind(store)),
    }),

    evidence: Object.freeze({
      upsertPlanItem: mutate(store.upsertPlanItem.bind(store)),
      markChecksStale: mutate(store.markChecksStale.bind(store)),
      upsertCheck: mutate(store.upsertCheck.bind(store)),
      getArtifact: query(store.getArtifact.bind(store)),
      listArtifacts: query(store.listArtifacts.bind(store)),
      addArtifact: mutate(store.addArtifact.bind(store)),
    }),

    gates: Object.freeze({
      recordGateEvaluation: mutate(store.recordGateEvaluation.bind(store)),
      listLatestGateEvaluations: query(store.listLatestGateEvaluations.bind(store)),
      evaluateGate: query(store.evaluateGate.bind(store)),
    }),

    progress: Object.freeze({
      getProgressSnapshot: query(store.getProgressSnapshot.bind(store)),
      updateProgressSnapshot: mutate(store.updateProgressSnapshot.bind(store)),
    }),

    contextManifests: Object.freeze({
      recordContextManifest: mutate(store.recordContextManifest.bind(store)),
      listContextManifests: query(store.listContextManifests.bind(store)),
      getLatestContextManifest: query(store.getLatestContextManifest.bind(store)),
      getContextManifestForAttempt: query(store.getContextManifestForAttempt.bind(store)),
    }),
    requestEnvelopes: Object.freeze({
      record: mutate(sqliteRequestEnvelopes.record.bind(sqliteRequestEnvelopes)),
      get: query(sqliteRequestEnvelopes.get.bind(sqliteRequestEnvelopes)),
      listForAttempt: query(sqliteRequestEnvelopes.listForAttempt.bind(sqliteRequestEnvelopes)),
    }),

    generationMaintenance: Object.freeze({
      listPendingGenerationActivations: query(store.listPendingGenerationActivations.bind(store)),
      prepareGenerationHandoff: mutate(store.prepareGenerationHandoff.bind(store)),
      recordGenerationActivationResult: mutate(store.recordGenerationActivationResult.bind(store)),
    }),

    approvals: Object.freeze({
      ensureApprovalRequest: mutate(store.ensureApprovalRequest.bind(store)),
      getApprovalRequest: query(store.getApprovalRequest.bind(store)),
      listApprovalRequests: query(store.listApprovalRequests.bind(store)),
      resolveApprovalRequest: mutate(store.resolveApprovalRequest.bind(store)),
      hasPendingApproval: query(store.hasPendingApproval.bind(store)),
      authorizeExternalAction: mutate(store.authorizeExternalAction.bind(store)),
    }),

    supervisorDecisions: Object.freeze({
      recordSupervisorDecision: mutate(store.recordSupervisorDecision.bind(store)),
      listSupervisorDecisions: query(store.listSupervisorDecisions.bind(store)),
      updateSupervisorDecision: mutate(store.updateSupervisorDecision.bind(store)),
      listSupervisorContinuationsNeedingReconcile: query(
        store.listSupervisorContinuationsNeedingReconcile.bind(store),
      ),
      reconcileSupervisorDecisionStatuses: mutate(store.reconcileSupervisorDecisionStatuses.bind(store)),
    }),

    settings: Object.freeze({
      getLearningSettings: query(store.getLearningSettings.bind(store)),
    }),

    semanticCache: Object.freeze({
      getSemanticCacheEntry: query(store.getSemanticCacheEntry.bind(store)),
      putSemanticCacheEntry: mutate(store.putSemanticCacheEntry.bind(store)),
      deleteExpiredSemanticCacheEntries: mutate(store.deleteExpiredSemanticCacheEntries.bind(store)),
    }),

    semanticLearningJobs: Object.freeze({
      enqueueSemanticLearningJob: mutate(store.enqueueSemanticLearningJob.bind(store)),
      claimSemanticLearningJobs: mutate(store.claimSemanticLearningJobs.bind(store)),
      renewSemanticLearningJob: mutate(store.renewSemanticLearningJob.bind(store)),
      completeSemanticLearningJob: mutate(store.completeSemanticLearningJob.bind(store)),
      failSemanticLearningJob: mutate(store.failSemanticLearningJob.bind(store)),
    }),

  };
}

