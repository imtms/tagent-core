import type { MessageSourceRepository, SessionRepository, SubmissionQueue } from "@tagent/admission/ports";
import type {
  AttemptAuthorityRepository,
  AttemptRepository,
  CheckpointRepository,
  ContinuationQueue,
  ControlInbox,
  EventConsumerRepository,
  FencedRuntimeMutationPort,
  TaskRunTransitionPort,
  RunEventJournal,
  RuntimePersistencePort,
  TaskRunRepository,
  TaskRunCommandReceiptRepository,
  ToolPersistencePort,
  TranscriptRepository,
} from "@tagent/execution/ports";
import type {
  ApprovalRepository,
  ContextManifestRepository,
  EvidenceRepository,
  GateEvaluationRepository,
  OperationRepository,
  ProgressRepository,
  SupervisorDecisionJournal,
  SupervisorPersistencePort,
  WorkflowGovernancePersistencePort,
  WorkspaceGoalRepository,
  WorkspaceGoalOperationRepository,
} from "@tagent/governance/ports";
import type {
  LearningLedgerRepository,
  LearningProjectionIntegrationPersistencePort,
  LearningProjectionQueue,
  LearningServicePersistencePort,
  SemanticLearningJobQueue,
  SemanticCacheRepository,
  SettingsRepository,
  WorkflowRepository,
  WorkflowServicePersistencePort,
} from "@tagent/learning/ports";
import type { MemorySourceRepository } from "@tagent/memory/ports";
import type { Store } from "../store.js";
import type { MutationUnitOfWork, SynchronousResult } from "../unit-of-work.js";
import type { WriterFenceGuard } from "./writer-fence-guard.js";
import { LegacyLearningLedgerRepository } from "./legacy-learning-ledger-repository.js";
import { LegacyWorkflowRepository } from "./legacy-workflow-repository.js";
import { SqliteAttemptAuthorityRepository } from "./attempt-authority-repository.js";
import { SqliteAttemptRepository } from "./attempt-repository.js";
import { SqliteFencedRuntimeMutationRepository } from "./attempt-runtime-mutation-repository.js";
import { SqliteTaskRunTransitionRepository } from "./task-run-transition-repository.js";
import { SqliteWorkflowGovernanceRepository } from "./sqlite-workflow-governance-repository.js";
import { SqliteLearningEffectRepository } from "./sqlite-learning-effect-repository.js";
import { SqliteLearningProjectionAuthorityRepository } from "./sqlite-learning-projection-authority-repository.js";
import { SqliteLearningProjectionDeliveryRepository } from "./sqlite-learning-projection-delivery-repository.js";
import { SqliteLearningProjectionReconciliationRepository } from "./sqlite-learning-projection-reconciliation-repository.js";
import { SqliteWorkspaceGoalRepository } from "./workspace-goal-repository.js";

type Operation<Args extends unknown[], Result> = (...args: Args) => Result;
type SynchronousOperation<Args extends unknown[], Result> = (...args: Args) => Result & SynchronousResult<Result>;

function query<Args extends unknown[], Result>(operation: Operation<Args, Result>): Operation<Args, Result> {
  return (...args) => operation(...args);
}

function mutation<Args extends unknown[], Result>(
  unitOfWork: MutationUnitOfWork,
  operation: SynchronousOperation<Args, Result>,
): Operation<Args, Result> {
  return (...args) => unitOfWork.run<Result>(() => operation(...args));
}

/** Adapts the SQLite writer fence's database callback to the storage-neutral UnitOfWork callback. */
export class GuardedStoreUnitOfWork implements MutationUnitOfWork {
  constructor(private readonly writerFenceGuard: WriterFenceGuard) {}

  run<T>(work: () => T & SynchronousResult<T>): T {
    return this.writerFenceGuard.run<T>(() => work());
  }
}

/**
 * Context-oriented compatibility bundle for the legacy SQLite Store.
 *
 * The Store is captured only by the delegates below. It is intentionally not
 * retained on the public object, so neither Store nor its `db` can escape this
 * persistence boundary.
 */
export class LegacyStoreAdapter {
  readonly sessions: SessionRepository;
  readonly messageSources: MessageSourceRepository;
  readonly submissions: SubmissionQueue;
  readonly taskRuns: TaskRunRepository;
  readonly continuations: ContinuationQueue;
  readonly controlInbox: ControlInbox;
  readonly events: RunEventJournal;
  readonly transcript: TranscriptRepository;
  readonly checkpoints: CheckpointRepository;
  readonly eventConsumers: EventConsumerRepository;
  readonly operations: OperationRepository;
  readonly evidence: EvidenceRepository;
  readonly gates: GateEvaluationRepository;
  readonly progress: ProgressRepository;
  readonly contextManifests: ContextManifestRepository;
  readonly approvals: ApprovalRepository;
  readonly supervisorDecisions: SupervisorDecisionJournal;
  readonly learningProjections: LearningProjectionQueue;
  readonly semanticLearningJobs: SemanticLearningJobQueue;
  readonly settings: SettingsRepository;
  readonly semanticCache: SemanticCacheRepository;
  readonly learning: LearningServicePersistencePort;
  readonly learningIntegration: LearningProjectionIntegrationPersistencePort;
  readonly workflow: WorkflowServicePersistencePort;
  readonly workflowGovernance: WorkflowGovernancePersistencePort;
  readonly runtime: RuntimePersistencePort;
  readonly tools: ToolPersistencePort;
  readonly supervisor: SupervisorPersistencePort;
  readonly memory: MemorySourceRepository;
  readonly attempts: AttemptRepository;
  readonly attemptAuthority: AttemptAuthorityRepository;
  readonly runtimeMutations: FencedRuntimeMutationPort;
  readonly taskRunTransitions: TaskRunTransitionPort;
  readonly workspaceGoals: WorkspaceGoalRepository;
  readonly workspaceGoalOperations: WorkspaceGoalOperationRepository;
  readonly taskRunCommands: TaskRunCommandReceiptRepository;
  readonly operatorRead: {
    listSessionsPage: Store["listOperatorSessionsPage"];
    listSessionTaskRunsPage: Store["listOperatorSessionTaskRunsPage"];
    getLatestSessionTaskRun: Store["getLatestOperatorSessionTaskRun"];
  };

  constructor(store: Store, mutationUnitOfWork: MutationUnitOfWork) {
    const mutate = <Args extends unknown[], Result>(operation: SynchronousOperation<Args, Result>) =>
      mutation(mutationUnitOfWork, operation);
    const legacyLearningLedger = new LegacyLearningLedgerRepository(store.db);
    const legacyWorkflow = new LegacyWorkflowRepository(store.db);
    const sqliteAttempts = new SqliteAttemptRepository(store.db, store.getRun.bind(store));
    const sqliteAttemptAuthority = new SqliteAttemptAuthorityRepository(store.db);
    const sqliteRuntimeMutations = new SqliteFencedRuntimeMutationRepository(store.db, store);
    const sqliteTaskRunTransitions = new SqliteTaskRunTransitionRepository(store.db, store);
    const sqliteWorkflowGovernance = new SqliteWorkflowGovernanceRepository(store.db);
    const sqliteLearningEffects = new SqliteLearningEffectRepository(store.db);
    const sqliteLearningProjectionAuthority = new SqliteLearningProjectionAuthorityRepository(store.db);
    const sqliteLearningProjectionDelivery = new SqliteLearningProjectionDeliveryRepository(store.db);
    const sqliteLearningProjectionReconciliation = new SqliteLearningProjectionReconciliationRepository(store.db);
    const sqliteWorkspaceGoals = new SqliteWorkspaceGoalRepository(store.db);

    this.workspaceGoals = Object.freeze({
      createGoal: mutate(sqliteWorkspaceGoals.createGoal.bind(sqliteWorkspaceGoals)),
      listGoals: query(sqliteWorkspaceGoals.listGoals.bind(sqliteWorkspaceGoals)),
      getGoal: query(sqliteWorkspaceGoals.getGoal.bind(sqliteWorkspaceGoals)),
      addDefinitionRevision: mutate(sqliteWorkspaceGoals.addDefinitionRevision.bind(sqliteWorkspaceGoals)),
      addRoadmapRevision: mutate(sqliteWorkspaceGoals.addRoadmapRevision.bind(sqliteWorkspaceGoals)),
      decideGoal: mutate(sqliteWorkspaceGoals.decideGoal.bind(sqliteWorkspaceGoals)),
      linkRun: mutate(sqliteWorkspaceGoals.linkRun.bind(sqliteWorkspaceGoals)),
      linkInbox: mutate(sqliteWorkspaceGoals.linkInbox.bind(sqliteWorkspaceGoals)),
      attachRun: mutate(sqliteWorkspaceGoals.attachRun.bind(sqliteWorkspaceGoals)),
      recordRunOutcome: mutate(sqliteWorkspaceGoals.recordRunOutcome.bind(sqliteWorkspaceGoals)),
      linkEvidence: mutate(sqliteWorkspaceGoals.linkEvidence.bind(sqliteWorkspaceGoals)),
      authorizeRunMutation: query(sqliteWorkspaceGoals.authorizeRunMutation.bind(sqliteWorkspaceGoals)),
    });
    this.workspaceGoalOperations = Object.freeze({
      claimWorkspaceGoalOperation: mutate(store.claimWorkspaceGoalOperation.bind(store)),
      getWorkspaceGoalOperation: query(store.getWorkspaceGoalOperation.bind(store)),
      settleWorkspaceGoalOperation: mutate(store.settleWorkspaceGoalOperation.bind(store)),
    });

    this.learningIntegration = Object.freeze({
      unitOfWork: mutationUnitOfWork,
      authority: Object.freeze({
        getState: query(sqliteLearningProjectionAuthority.getState.bind(sqliteLearningProjectionAuthority)),
        acquire: mutate(sqliteLearningProjectionAuthority.acquire.bind(sqliteLearningProjectionAuthority)),
        renew: mutate(sqliteLearningProjectionAuthority.renew.bind(sqliteLearningProjectionAuthority)),
        release: mutate(sqliteLearningProjectionAuthority.release.bind(sqliteLearningProjectionAuthority)),
        prepareCutover: mutate(sqliteLearningProjectionAuthority.prepareCutover.bind(sqliteLearningProjectionAuthority)),
        activateIntegration: mutate(sqliteLearningProjectionAuthority.activateIntegration.bind(sqliteLearningProjectionAuthority)),
        prepareRollback: mutate(sqliteLearningProjectionAuthority.prepareRollback.bind(sqliteLearningProjectionAuthority)),
        activateLegacy: mutate(sqliteLearningProjectionAuthority.activateLegacy.bind(sqliteLearningProjectionAuthority)),
      }),
      delivery: Object.freeze({
        getCheckpoint: query(sqliteLearningProjectionDelivery.getCheckpoint.bind(sqliteLearningProjectionDelivery)),
        claimNextShadow: mutate(sqliteLearningProjectionDelivery.claimNextShadow.bind(sqliteLearningProjectionDelivery)),
        claimNextActive: mutate(sqliteLearningProjectionDelivery.claimNextActive.bind(sqliteLearningProjectionDelivery)),
        acknowledgeActive: mutate(sqliteLearningProjectionDelivery.acknowledgeActive.bind(sqliteLearningProjectionDelivery)),
        failActive: mutate(sqliteLearningProjectionDelivery.failActive.bind(sqliteLearningProjectionDelivery)),
      }),
      effects: Object.freeze({
        get: query(sqliteLearningEffects.get.bind(sqliteLearningEffects)),
        record: mutate(sqliteLearningEffects.record.bind(sqliteLearningEffects)),
      }),
      reconciliation: Object.freeze({
        getProjectionPair: query(sqliteLearningProjectionReconciliation.getProjectionPair.bind(sqliteLearningProjectionReconciliation)),
        completeShadowClaim: mutate(sqliteLearningProjectionReconciliation.completeShadowClaim.bind(sqliteLearningProjectionReconciliation)),
        getContiguousWatermark: query(sqliteLearningProjectionReconciliation.getContiguousWatermark.bind(sqliteLearningProjectionReconciliation)),
      }),
    });

    this.attempts = Object.freeze({
      getAttempt: query(sqliteAttempts.getAttempt.bind(sqliteAttempts)),
      getAttemptForRun: query(sqliteAttempts.getAttemptForRun.bind(sqliteAttempts)),
      getActiveAttempt: query(sqliteAttempts.getActiveAttempt.bind(sqliteAttempts)),
      listAttempts: query(sqliteAttempts.listAttempts.bind(sqliteAttempts)),
      listTransitionAudit: query(sqliteAttempts.listTransitionAudit.bind(sqliteAttempts)),
      listShadowComparisons: query(sqliteAttempts.listShadowComparisons.bind(sqliteAttempts)),
      acquireExecutionLease: mutate(sqliteAttempts.acquireExecutionLease.bind(sqliteAttempts)),
      renewExecutionLease: mutate(sqliteAttempts.renewExecutionLease.bind(sqliteAttempts)),
      releaseExecutionLease: mutate(sqliteAttempts.releaseExecutionLease.bind(sqliteAttempts)),
      recordCandidateResult: mutate(sqliteAttempts.recordCandidateResult.bind(sqliteAttempts)),
      settleAttempt: mutate(sqliteAttempts.settleAttempt.bind(sqliteAttempts)),
      recoverInterruptedAttempt: mutate(sqliteAttempts.recoverInterruptedAttempt.bind(sqliteAttempts)),
      cancelAttempt: mutate(sqliteAttempts.cancelAttempt.bind(sqliteAttempts)),
    });

    this.attemptAuthority = Object.freeze({
      getAuthorityState: query(sqliteAttemptAuthority.getAuthorityState.bind(sqliteAttemptAuthority)),
      evaluateAuthorityGate: query(sqliteAttemptAuthority.evaluateAuthorityGate.bind(sqliteAttemptAuthority)),
      recordShadowComparisons: mutate(sqliteAttemptAuthority.recordShadowComparisons.bind(sqliteAttemptAuthority)),
      recordAuthorityReceipt: mutate(sqliteAttemptAuthority.recordAuthorityReceipt.bind(sqliteAttemptAuthority)),
      requestAuthority: mutate(sqliteAttemptAuthority.requestAuthority.bind(sqliteAttemptAuthority)),
      assertAttemptApproved: query(sqliteAttemptAuthority.assertAttemptApproved.bind(sqliteAttemptAuthority)),
      rollbackAuthority: mutate(sqliteAttemptAuthority.rollbackAuthority.bind(sqliteAttemptAuthority)),
    });

    this.runtimeMutations = Object.freeze({
      appendEvent: mutate(sqliteRuntimeMutations.appendEvent.bind(sqliteRuntimeMutations)),
      appendTranscript: mutate(sqliteRuntimeMutations.appendTranscript.bind(sqliteRuntimeMutations)),
      setRunPhase: mutate(sqliteRuntimeMutations.setRunPhase.bind(sqliteRuntimeMutations)),
      advanceRunPhase: mutate(sqliteRuntimeMutations.advanceRunPhase.bind(sqliteRuntimeMutations)),
      requestUserInput: mutate(sqliteRuntimeMutations.requestUserInput.bind(sqliteRuntimeMutations)),
      upsertCheckpoint: mutate(sqliteRuntimeMutations.upsertCheckpoint.bind(sqliteRuntimeMutations)),
      claimOperation: mutate(sqliteRuntimeMutations.claimOperation.bind(sqliteRuntimeMutations)),
      updateOperation: mutate(sqliteRuntimeMutations.updateOperation.bind(sqliteRuntimeMutations)),
      recordToolAttempt: mutate(sqliteRuntimeMutations.recordToolAttempt.bind(sqliteRuntimeMutations)),
      completeToolAttempt: mutate(sqliteRuntimeMutations.completeToolAttempt.bind(sqliteRuntimeMutations)),
      completeControlDelivery: mutate(sqliteRuntimeMutations.completeControlDelivery.bind(sqliteRuntimeMutations)),
      completeSupervisorDecision: mutate(sqliteRuntimeMutations.completeSupervisorDecision.bind(sqliteRuntimeMutations)),
      upsertPlanItem: mutate(sqliteRuntimeMutations.upsertPlanItem.bind(sqliteRuntimeMutations)),
      markChecksStale: mutate(sqliteRuntimeMutations.markChecksStale.bind(sqliteRuntimeMutations)),
      upsertCheck: mutate(sqliteRuntimeMutations.upsertCheck.bind(sqliteRuntimeMutations)),
      applyTaskRunBatch: mutate(sqliteRuntimeMutations.applyTaskRunBatch.bind(sqliteRuntimeMutations)),
      addArtifact: mutate(sqliteRuntimeMutations.addArtifact.bind(sqliteRuntimeMutations)),
    });

    this.taskRunTransitions = Object.freeze({
      transitionRuntime: mutate(sqliteTaskRunTransitions.transitionRuntime.bind(sqliteTaskRunTransitions)),
      transitionSystem: mutate(sqliteTaskRunTransitions.transitionSystem.bind(sqliteTaskRunTransitions)),
    });

    this.workflowGovernance = Object.freeze({
      unitOfWork: mutationUnitOfWork,
      reader: Object.freeze({
        getState: query(sqliteWorkflowGovernance.getState.bind(sqliteWorkflowGovernance)),
        getReceipt: query(sqliteWorkflowGovernance.getReceipt.bind(sqliteWorkflowGovernance)),
        getApprovedProposal: query(sqliteWorkflowGovernance.getApprovedProposal.bind(sqliteWorkflowGovernance)),
        getRevision: query(sqliteWorkflowGovernance.getRevision.bind(sqliteWorkflowGovernance)),
        getExecutableApproval: query(sqliteWorkflowGovernance.getExecutableApproval.bind(sqliteWorkflowGovernance)),
        listCanaryDecisionCandidates: query(sqliteWorkflowGovernance.listCanaryDecisionCandidates.bind(sqliteWorkflowGovernance)),
        getCanaryDecisionEvidence: query(sqliteWorkflowGovernance.getCanaryDecisionEvidence.bind(sqliteWorkflowGovernance)),
      }),
      mutations: Object.freeze({
        commitApprovedEffect: mutate(sqliteWorkflowGovernance.commitApprovedEffect.bind(sqliteWorkflowGovernance)),
        commitOwnedEffect: mutate(sqliteWorkflowGovernance.commitOwnedEffect.bind(sqliteWorkflowGovernance)),
      }),
    });

    this.sessions = Object.freeze({
      createSession: mutate(store.createSession.bind(store)),
      createSessionIdempotent: mutate(store.createSessionIdempotent.bind(store)),
      listSessions: query(store.listSessions.bind(store)),
      getSession: query(store.getSession.bind(store)),
      updateSession: mutate(store.updateSession.bind(store)),
      renameSession: mutate(store.renameSession.bind(store)),
      listMessages: query(store.listMessages.bind(store)),
      listRecentMessages: query(store.listRecentMessages.bind(store)),
      appendMessage: mutate(store.appendMessage.bind(store)),
    });

    this.operatorRead = Object.freeze({
      listSessionsPage: query(store.listOperatorSessionsPage.bind(store)),
      listSessionTaskRunsPage: query(store.listOperatorSessionTaskRunsPage.bind(store)),
      getLatestSessionTaskRun: query(store.getLatestOperatorSessionTaskRun.bind(store)),
    });

    this.taskRunCommands = Object.freeze({
      claimTaskRunCommand: mutate(store.claimTaskRunCommand.bind(store)),
      getTaskRunCommand: query(store.getTaskRunCommand.bind(store)),
      settleTaskRunCommand: mutate(store.settleTaskRunCommand.bind(store)),
    });

    this.messageSources = Object.freeze({
      getMessageSource: query(store.getMessageSource.bind(store)),
      listDurableUserMessages: query(store.listDurableUserMessages.bind(store)),
    });

    this.submissions = Object.freeze({
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
      updateSessionInboxItem: mutate(store.updateSessionInboxItem.bind(store)),
      reorderSessionInbox: mutate(store.reorderSessionInbox.bind(store)),
      deleteSessionInboxItem: mutate(store.deleteSessionInboxItem.bind(store)),
      discardSessionInboxItem: mutate(store.discardSessionInboxItem.bind(store)),
      decideSessionInboxItem: mutate(store.decideSessionInboxItem.bind(store)),
      mergeSessionInboxItems: mutate(store.mergeSessionInboxItems.bind(store)),
      claimNextSessionInbox: mutate(store.claimNextSessionInbox.bind(store)),
      claimSessionInboxNow: mutate(store.claimSessionInboxNow.bind(store)),
      recordSessionInboxLaunchFailure: mutate(store.recordSessionInboxLaunchFailure.bind(store)),
      retryInboxLaunch: mutate(store.retryInboxLaunch.bind(store)),
      listSessionsWithQueuedInbox: query(store.listSessionsWithQueuedInbox.bind(store)),
    });

    this.taskRuns = Object.freeze({
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
    });

    this.continuations = Object.freeze({
      nextContinuationLeaseExpiry: query(store.nextContinuationLeaseExpiry.bind(store)),
      ownsContinuationLease: query(store.ownsContinuationLease.bind(store)),
      recoverContinuationsAfterRestart: mutate(store.recoverContinuationsAfterRestart.bind(store)),
      releaseContinuationLease: mutate(store.releaseContinuationLease.bind(store)),
      releaseContinuationLeases: mutate(store.releaseContinuationLeases.bind(store)),
      renewContinuationLease: mutate(store.renewContinuationLease.bind(store)),
      listContinuations: query(store.listContinuations.bind(store)),
      queueContinuation: mutate(store.queueContinuation.bind(store)),
      claimContinuation: mutate(store.claimContinuation.bind(store)),
      updateContinuation: mutate(store.updateContinuation.bind(store)),
      cancelQueuedContinuations: mutate(store.cancelQueuedContinuations.bind(store)),
    });

    this.controlInbox = Object.freeze({
      enqueueControl: mutate(store.enqueueControl.bind(store)),
      getControlItem: query(store.getControlItem.bind(store)),
      listControlInbox: query(store.listControlInbox.bind(store)),
      claimControlItem: mutate(store.claimControlItem.bind(store)),
      completeControlItem: mutate(store.completeControlItem.bind(store)),
    });

    this.events = Object.freeze({
      appendEvent: mutate(store.appendEvent.bind(store)),
      listEvents: query(store.listEvents.bind(store)),
    });

    this.transcript = Object.freeze({
      getLastTranscriptSeq: query(store.getLastTranscriptSeq.bind(store)),
      getTranscriptCount: query(store.getTranscriptCount.bind(store)),
      appendTranscript: mutate(store.appendTranscript.bind(store)),
      listTranscriptEntries: query(store.listTranscriptEntries.bind(store)),
      listTranscript: query(store.listTranscript.bind(store)),
      repairTranscript: mutate(store.repairTranscript.bind(store)),
      listTranscriptView: query(store.listTranscriptView.bind(store)),
    });

    this.checkpoints = Object.freeze({
      getCheckpoint: query(store.getCheckpoint.bind(store)),
      upsertCheckpoint: mutate(store.upsertCheckpoint.bind(store)),
    });

    this.eventConsumers = Object.freeze({
      claimEventConsumer: mutate(store.claimEventConsumer.bind(store)),
      getEventConsumer: query(store.getEventConsumer.bind(store)),
      ackEventConsumer: mutate(store.ackEventConsumer.bind(store)),
    });

    this.operations = Object.freeze({
      claimOperation: mutate(store.claimOperation.bind(store)),
      updateOperation: mutate(store.updateOperation.bind(store)),
      getOperation: query(store.getOperation.bind(store)),
      listOperations: query(store.listOperations.bind(store)),
      recordToolAttempt: mutate(store.recordToolAttempt.bind(store)),
      completeToolAttempt: mutate(store.completeToolAttempt.bind(store)),
    });

    this.evidence = Object.freeze({
      upsertPlanItem: mutate(store.upsertPlanItem.bind(store)),
      markChecksStale: mutate(store.markChecksStale.bind(store)),
      upsertCheck: mutate(store.upsertCheck.bind(store)),
      getArtifact: query(store.getArtifact.bind(store)),
      listArtifacts: query(store.listArtifacts.bind(store)),
      addArtifact: mutate(store.addArtifact.bind(store)),
    });

    this.gates = Object.freeze({
      recordGateEvaluation: mutate(store.recordGateEvaluation.bind(store)),
      listLatestGateEvaluations: query(store.listLatestGateEvaluations.bind(store)),
      evaluateGate: query(store.evaluateGate.bind(store)),
    });

    this.progress = Object.freeze({
      getProgressSnapshot: query(store.getProgressSnapshot.bind(store)),
      updateProgressSnapshot: mutate(store.updateProgressSnapshot.bind(store)),
    });

    this.contextManifests = Object.freeze({
      recordContextManifest: mutate(store.recordContextManifest.bind(store)),
      listContextManifests: query(store.listContextManifests.bind(store)),
      getLatestContextManifest: query(store.getLatestContextManifest.bind(store)),
      getContextManifestForAttempt: query(store.getContextManifestForAttempt.bind(store)),
    });

    this.approvals = Object.freeze({
      ensureApprovalRequest: mutate(store.ensureApprovalRequest.bind(store)),
      getApprovalRequest: query(store.getApprovalRequest.bind(store)),
      listApprovalRequests: query(store.listApprovalRequests.bind(store)),
      resolveApprovalRequest: mutate(store.resolveApprovalRequest.bind(store)),
      hasPendingApproval: query(store.hasPendingApproval.bind(store)),
      authorizeExternalAction: mutate(store.authorizeExternalAction.bind(store)),
    });

    this.supervisorDecisions = Object.freeze({
      recordSupervisorDecision: mutate(store.recordSupervisorDecision.bind(store)),
      listSupervisorDecisions: query(store.listSupervisorDecisions.bind(store)),
      updateSupervisorDecision: mutate(store.updateSupervisorDecision.bind(store)),
      listSupervisorContinuationsNeedingReconcile: query(
        store.listSupervisorContinuationsNeedingReconcile.bind(store),
      ),
      reconcileSupervisorDecisionStatuses: mutate(store.reconcileSupervisorDecisionStatuses.bind(store)),
    });

    this.settings = Object.freeze({
      getLearningSettings: query(store.getLearningSettings.bind(store)),
    });

    this.semanticCache = Object.freeze({
      getSemanticCacheEntry: query(store.getSemanticCacheEntry.bind(store)),
      putSemanticCacheEntry: mutate(store.putSemanticCacheEntry.bind(store)),
      deleteExpiredSemanticCacheEntries: mutate(store.deleteExpiredSemanticCacheEntries.bind(store)),
    });

    this.learningProjections = Object.freeze({
      listPendingLearningProjections: query(store.listPendingLearningProjections.bind(store)),
      completeLearningProjection: mutate(store.completeLearningProjection.bind(store)),
      failLearningProjection: mutate(store.failLearningProjection.bind(store)),
    });

    this.semanticLearningJobs = Object.freeze({
      enqueueSemanticLearningJob: mutate(store.enqueueSemanticLearningJob.bind(store)),
      claimSemanticLearningJobs: mutate(store.claimSemanticLearningJobs.bind(store)),
      renewSemanticLearningJob: mutate(store.renewSemanticLearningJob.bind(store)),
      completeSemanticLearningJob: mutate(store.completeSemanticLearningJob.bind(store)),
      failSemanticLearningJob: mutate(store.failSemanticLearningJob.bind(store)),
    });

    const learningLedger: LearningLedgerRepository = Object.freeze({
      updateCommunicationProfile: mutate(legacyLearningLedger.updateCommunicationProfile.bind(legacyLearningLedger)),
      findCommunicationProfile: query(legacyLearningLedger.findCommunicationProfile.bind(legacyLearningLedger)),
      setCommunicationProfileLocked: mutate(legacyLearningLedger.setCommunicationProfileLocked.bind(legacyLearningLedger)),
      listCommunicationProfileIds: query(legacyLearningLedger.listCommunicationProfileIds.bind(legacyLearningLedger)),
      getCommunicationProfile: query(legacyLearningLedger.getCommunicationProfile.bind(legacyLearningLedger)),
      getCommunicationRevision: query(legacyLearningLedger.getCommunicationRevision.bind(legacyLearningLedger)),
      recordCorrection: mutate(legacyLearningLedger.recordCorrection.bind(legacyLearningLedger)),
      listUnprojectedLearningRows: query(legacyLearningLedger.listUnprojectedLearningRows.bind(legacyLearningLedger)),
      listLearningToolAttempts: query(legacyLearningLedger.listLearningToolAttempts.bind(legacyLearningLedger)),
      countRunCorrections: query(legacyLearningLedger.countRunCorrections.bind(legacyLearningLedger)),
      getRunLearningPolicyRecord: query(legacyLearningLedger.getRunLearningPolicyRecord.bind(legacyLearningLedger)),
      recordLearningEvent: mutate(legacyLearningLedger.recordLearningEvent.bind(legacyLearningLedger)),
      correctionReferencesRecord: query(legacyLearningLedger.correctionReferencesRecord.bind(legacyLearningLedger)),
      listCorrectionContents: query(legacyLearningLedger.listCorrectionContents.bind(legacyLearningLedger)),
      recordFeedbackAttributionReceipt: mutate(legacyLearningLedger.recordFeedbackAttributionReceipt.bind(legacyLearningLedger)),
      listFeedbackAttributionWork: query(legacyLearningLedger.listFeedbackAttributionWork.bind(legacyLearningLedger)),
      completeFeedbackAttribution: mutate(legacyLearningLedger.completeFeedbackAttribution.bind(legacyLearningLedger)),
      failFeedbackAttribution: mutate(legacyLearningLedger.failFeedbackAttribution.bind(legacyLearningLedger)),
      getLearningEventRow: query(legacyLearningLedger.getLearningEventRow.bind(legacyLearningLedger)),
      listLearningEventIds: query(legacyLearningLedger.listLearningEventIds.bind(legacyLearningLedger)),
      listCorrectionRows: query(legacyLearningLedger.listCorrectionRows.bind(legacyLearningLedger)),
      listFeedbackAttributionRows: query(legacyLearningLedger.listFeedbackAttributionRows.bind(legacyLearningLedger)),
    });
    this.learning = Object.freeze({
      getRun: this.taskRuns.getRun,
      listMessages: this.sessions.listMessages,
      getContextManifestForAttempt: this.contextManifests.getContextManifestForAttempt,
      ...this.semanticLearningJobs,
      learningLedger,
    });

    const workflowRepository: WorkflowRepository = Object.freeze({
      upsertRunLearningPolicy: mutate(legacyWorkflow.upsertRunLearningPolicy.bind(legacyWorkflow)),
      getRunLearningPolicy: query(legacyWorkflow.getRunLearningPolicy.bind(legacyWorkflow)),
      recordExperienceObservation: mutate(legacyWorkflow.recordExperienceObservation.bind(legacyWorkflow)),
      enqueueDistillationJob: mutate(legacyWorkflow.enqueueDistillationJob.bind(legacyWorkflow)),
      claimDistillationJob: mutate(legacyWorkflow.claimDistillationJob.bind(legacyWorkflow)),
      renewDistillationLease: mutate(legacyWorkflow.renewDistillationLease.bind(legacyWorkflow)),
      checkpointDistillationJob: mutate(legacyWorkflow.checkpointDistillationJob.bind(legacyWorkflow)),
      updateDistillationCheckpoint: mutate(legacyWorkflow.updateDistillationCheckpoint.bind(legacyWorkflow)),
      getDistillationCheckpoint: query(legacyWorkflow.getDistillationCheckpoint.bind(legacyWorkflow)),
      completeDistillationJob: mutate(legacyWorkflow.completeDistillationJob.bind(legacyWorkflow)),
      failDistillationJob: mutate(legacyWorkflow.failDistillationJob.bind(legacyWorkflow)),
      listExperienceCandidates: query(legacyWorkflow.listExperienceCandidates.bind(legacyWorkflow)),
      findDistilledWorkflow: query(legacyWorkflow.findDistilledWorkflow.bind(legacyWorkflow)),
      recordDistillationConflict: mutate(legacyWorkflow.recordDistillationConflict.bind(legacyWorkflow)),
      recordWorkflowDistillation: mutate(legacyWorkflow.recordWorkflowDistillation.bind(legacyWorkflow)),
      createWorkflow: mutate(legacyWorkflow.createWorkflow.bind(legacyWorkflow)),
      createWorkflowRevision: mutate(legacyWorkflow.createWorkflowRevision.bind(legacyWorkflow)),
      listWorkflowDefinitions: query(legacyWorkflow.listWorkflowDefinitions.bind(legacyWorkflow)),
      getWorkflowDefinition: query(legacyWorkflow.getWorkflowDefinition.bind(legacyWorkflow)),
      listWorkflowRevisionIds: query(legacyWorkflow.listWorkflowRevisionIds.bind(legacyWorkflow)),
      getWorkflowRevision: query(legacyWorkflow.getWorkflowRevision.bind(legacyWorkflow)),
      recordGovernanceReceipt: mutate(legacyWorkflow.recordGovernanceReceipt.bind(legacyWorkflow)),
      findActiveApprovalByHash: query(legacyWorkflow.findActiveApprovalByHash.bind(legacyWorkflow)),
      createApproval: mutate(legacyWorkflow.createApproval.bind(legacyWorkflow)),
      getApproval: query(legacyWorkflow.getApproval.bind(legacyWorkflow)),
      listApprovals: query(legacyWorkflow.listApprovals.bind(legacyWorkflow)),
      decideApproval: mutate(legacyWorkflow.decideApproval.bind(legacyWorkflow)),
      revokeApproval: mutate(legacyWorkflow.revokeApproval.bind(legacyWorkflow)),
      expireApprovals: mutate(legacyWorkflow.expireApprovals.bind(legacyWorkflow)),
      setBindingMode: mutate(legacyWorkflow.setBindingMode.bind(legacyWorkflow)),
      recordApplication: mutate(legacyWorkflow.recordApplication.bind(legacyWorkflow)),
      getApplicationReceipt: query(legacyWorkflow.getApplicationReceipt.bind(legacyWorkflow)),
      listRunBindings: query(legacyWorkflow.listRunBindings.bind(legacyWorkflow)),
      recordRunApplication: mutate(legacyWorkflow.recordRunApplication.bind(legacyWorkflow)),
      recordFeedback: mutate(legacyWorkflow.recordFeedback.bind(legacyWorkflow)),
      workflowQuality: query(legacyWorkflow.workflowQuality.bind(legacyWorkflow)),
      recordSelectorReceipt: mutate(legacyWorkflow.recordSelectorReceipt.bind(legacyWorkflow)),
      getCanaryPromotion: query(legacyWorkflow.getCanaryPromotion.bind(legacyWorkflow)),
      recordCanaryAssignment: mutate(legacyWorkflow.recordCanaryAssignment.bind(legacyWorkflow)),
      recordWorkflowBinding: mutate(legacyWorkflow.recordWorkflowBinding.bind(legacyWorkflow)),
      listBindings: query(legacyWorkflow.listBindings.bind(legacyWorkflow)),
      listFeedback: query(legacyWorkflow.listFeedback.bind(legacyWorkflow)),
      createProposal: mutate(legacyWorkflow.createProposal.bind(legacyWorkflow)),
      listProposals: query(legacyWorkflow.listProposals.bind(legacyWorkflow)),
      getProposal: query(legacyWorkflow.getProposal.bind(legacyWorkflow)),
      decideProposal: mutate(legacyWorkflow.decideProposal.bind(legacyWorkflow)),
      listDistillationJobs: query(legacyWorkflow.listDistillationJobs.bind(legacyWorkflow)),
      listRunLearningPolicies: query(legacyWorkflow.listRunLearningPolicies.bind(legacyWorkflow)),
      listWorkflowQuality: query(legacyWorkflow.listWorkflowQuality.bind(legacyWorkflow)),
      listEvaluations: query(legacyWorkflow.listEvaluations.bind(legacyWorkflow)),
      listCanaryBindings: query(legacyWorkflow.listCanaryBindings.bind(legacyWorkflow)),
      getDistillationMetrics: query(legacyWorkflow.getDistillationMetrics.bind(legacyWorkflow)),
      listAutonomyAudit: query(legacyWorkflow.listAutonomyAudit.bind(legacyWorkflow)),
      recordAutonomyAudit: mutate(legacyWorkflow.recordAutonomyAudit.bind(legacyWorkflow)),
      getEvaluationReceipt: query(legacyWorkflow.getEvaluationReceipt.bind(legacyWorkflow)),
      recordEvaluationReceipt: mutate(legacyWorkflow.recordEvaluationReceipt.bind(legacyWorkflow)),
      hasWorkflowBinding: query(legacyWorkflow.hasWorkflowBinding.bind(legacyWorkflow)),
      listPassedEvaluations: query(legacyWorkflow.listPassedEvaluations.bind(legacyWorkflow)),
      listPendingCanaryBindings: query(legacyWorkflow.listPendingCanaryBindings.bind(legacyWorkflow)),
      recordCanaryOutcome: mutate(legacyWorkflow.recordCanaryOutcome.bind(legacyWorkflow)),
      retryDistillationJob: mutate(legacyWorkflow.retryDistillationJob.bind(legacyWorkflow)),
      listDeadLetterJobs: query(legacyWorkflow.listDeadLetterJobs.bind(legacyWorkflow)),
    });
    this.workflow = Object.freeze({
      getRun: this.taskRuns.getRun,
      ...this.learningProjections,
      ...this.semanticLearningJobs,
      unitOfWork: mutationUnitOfWork,
      workflow: workflowRepository,
    });

    this.tools = Object.freeze({
      getRun: this.taskRuns.getRun,
      advanceRunPhase: this.taskRuns.advanceRunPhase,
      setRunPhase: this.taskRuns.setRunPhase,
      requestUserInput: this.taskRuns.requestUserInput,
      claimOperation: this.operations.claimOperation,
      updateOperation: this.operations.updateOperation,
      listOperations: this.operations.listOperations,
      upsertPlanItem: this.evidence.upsertPlanItem,
      markChecksStale: this.evidence.markChecksStale,
      upsertCheck: this.evidence.upsertCheck,
      addArtifact: this.evidence.addArtifact,
      appendEvent: this.events.appendEvent,
    });

    this.runtime = Object.freeze({
      ...this.tools,
      recordToolAttempt: this.operations.recordToolAttempt,
      completeToolAttempt: this.operations.completeToolAttempt,
      appendTranscript: this.transcript.appendTranscript,
    });

    this.supervisor = Object.freeze({
      getRun: this.taskRuns.getRun,
      listControlInbox: this.controlInbox.listControlInbox,
      listOperations: this.operations.listOperations,
      getProgressSnapshot: this.progress.getProgressSnapshot,
      updateProgressSnapshot: this.progress.updateProgressSnapshot,
      getLatestContextManifest: this.contextManifests.getLatestContextManifest,
      recordGateEvaluation: this.gates.recordGateEvaluation,
      recordSupervisorDecision: this.supervisorDecisions.recordSupervisorDecision,
      listSupervisorDecisions: this.supervisorDecisions.listSupervisorDecisions,
      updateSupervisorDecision: this.supervisorDecisions.updateSupervisorDecision,
    });

    this.memory = Object.freeze({
      getMessageSource: this.messageSources.getMessageSource,
      listDurableUserMessages: this.messageSources.listDurableUserMessages,
      getRun: this.taskRuns.getRun,
      listTranscriptView: this.transcript.listTranscriptView,
      appendEvent: this.events.appendEvent,
    });
  }
}

export function createGuardedLegacyStoreAdapter(store: Store, writerFenceGuard: WriterFenceGuard): LegacyStoreAdapter {
  return new LegacyStoreAdapter(store, new GuardedStoreUnitOfWork(writerFenceGuard));
}
