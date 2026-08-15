import type { MessageSourceRepository, ProfileContractRepository, SessionRepository, SkillRepository, SubmissionQueue } from "@tagent/admission/ports";
import type {
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
  AttemptRequestEnvelopeRepository,
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
  LearningServicePersistencePort,
  SemanticLearningJobQueue,
  SemanticCacheRepository,
  SettingsRepository,
  WorkflowLearningRepository,
  WorkflowLearningPersistencePort,
} from "@tagent/learning/ports";
import type { MemorySourceRepository } from "@tagent/memory/ports";
import type { Store } from "../store.js";
import type { MutationUnitOfWork, SynchronousResult } from "../unit-of-work.js";
import type { WriterFenceGuard } from "./writer-fence-guard.js";
import { SqliteLearningLedgerRepository } from "./learning-ledger-repository.js";
import { SqliteWorkflowLearningRepository } from "./workflow-repository.js";
import { SqliteAttemptRepository } from "./attempt-repository.js";
import { SqliteFencedRuntimeMutationRepository } from "./attempt-runtime-mutation-repository.js";
import { SqliteTaskRunTransitionRepository } from "./task-run-transition-repository.js";
import { SqliteWorkflowGovernanceRepository } from "./sqlite-workflow-governance-repository.js";
import { SqliteLearningEffectRepository } from "./sqlite-learning-effect-repository.js";
import { SqliteLearningProjectionDeliveryRepository } from "./sqlite-learning-projection-delivery-repository.js";
import { SqliteWorkspaceGoalRepository } from "./workspace-goal-repository.js";
import { SqliteAttemptRequestEnvelopeRepository } from "./attempt-request-envelope-repository.js";
import { SqliteProfileContractRepository } from "./profile-contract-repository.js";

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
export class GuardedSqliteUnitOfWork implements MutationUnitOfWork {
  constructor(private readonly writerFenceGuard: WriterFenceGuard) {}

  run<T>(work: () => T & SynchronousResult<T>): T {
    return this.writerFenceGuard.run<T>(() => work());
  }
}

/** Narrow, context-oriented ports over the SQLite Store and its writer fence. */
export class SqlitePersistence {
  readonly sessions: SessionRepository;
  readonly skills: SkillRepository;
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
  readonly requestEnvelopes: AttemptRequestEnvelopeRepository;
  readonly approvals: ApprovalRepository;
  readonly supervisorDecisions: SupervisorDecisionJournal;
  readonly semanticLearningJobs: SemanticLearningJobQueue;
  readonly settings: SettingsRepository;
  readonly semanticCache: SemanticCacheRepository;
  readonly learning: LearningServicePersistencePort;
  readonly learningIntegration: LearningProjectionIntegrationPersistencePort;
  readonly workflow: WorkflowLearningPersistencePort;
  readonly workflowGovernance: WorkflowGovernancePersistencePort;
  readonly runtime: RuntimePersistencePort;
  readonly tools: ToolPersistencePort;
  readonly supervisor: SupervisorPersistencePort;
  readonly memory: MemorySourceRepository;
  readonly attempts: AttemptRepository;
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
  readonly profileContracts: ProfileContractRepository;

  constructor(store: Store, mutationUnitOfWork: MutationUnitOfWork) {
    const mutate = <Args extends unknown[], Result>(operation: SynchronousOperation<Args, Result>) =>
      mutation(mutationUnitOfWork, operation);
    const learningLedgerRepository = new SqliteLearningLedgerRepository(store.db);
    const workflowLearning = new SqliteWorkflowLearningRepository(store.db);
    const sqliteAttempts = new SqliteAttemptRepository(store.db, store.getRun.bind(store));
    const sqliteRuntimeMutations = new SqliteFencedRuntimeMutationRepository(store.db, store);
    const sqliteTaskRunTransitions = new SqliteTaskRunTransitionRepository(store.db, store);
    const sqliteWorkflowGovernance = new SqliteWorkflowGovernanceRepository(store.db);
    const sqliteLearningEffects = new SqliteLearningEffectRepository(store.db);
    const sqliteLearningProjectionDelivery = new SqliteLearningProjectionDeliveryRepository(store.db);
    const sqliteWorkspaceGoals = new SqliteWorkspaceGoalRepository(store.db);
    const sqliteRequestEnvelopes = new SqliteAttemptRequestEnvelopeRepository(store.db);
    const sqliteProfileContracts = new SqliteProfileContractRepository(store.db);

    this.profileContracts = Object.freeze({
      getProfileResourceRevision: query(sqliteProfileContracts.getProfileResourceRevision.bind(sqliteProfileContracts)),
      bumpProfileResourceRevision: mutate(sqliteProfileContracts.bumpProfileResourceRevision.bind(sqliteProfileContracts)),
      runSynchronousMutation: mutate(sqliteProfileContracts.runSynchronousMutation.bind(sqliteProfileContracts)),
      replaySynchronousMutation: query(sqliteProfileContracts.replaySynchronousMutation.bind(sqliteProfileContracts)),
      getInboxCollectionRevision: query(sqliteProfileContracts.getInboxCollectionRevision.bind(sqliteProfileContracts)),
      getInboxItem: query(sqliteProfileContracts.getInboxItem.bind(sqliteProfileContracts)),
      listInboxPage: query(sqliteProfileContracts.listInboxPage.bind(sqliteProfileContracts)),
      getTaskRunSessionId: query(sqliteProfileContracts.getTaskRunSessionId.bind(sqliteProfileContracts)),
      listContextManifestPage: query(sqliteProfileContracts.listContextManifestPage.bind(sqliteProfileContracts)),
      getSessionSettings: query(sqliteProfileContracts.getSessionSettings.bind(sqliteProfileContracts)),
      updateSessionSettings: mutate(sqliteProfileContracts.updateSessionSettings.bind(sqliteProfileContracts)),
      claimOperation: mutate(sqliteProfileContracts.claimOperation.bind(sqliteProfileContracts)),
      getOperation: query(sqliteProfileContracts.getOperation.bind(sqliteProfileContracts)),
      findOperations: query(sqliteProfileContracts.findOperations.bind(sqliteProfileContracts)),
      settleOperation: mutate(sqliteProfileContracts.settleOperation.bind(sqliteProfileContracts)),
      recordAudit: mutate(sqliteProfileContracts.recordAudit.bind(sqliteProfileContracts)),
    });

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
      delivery: Object.freeze({
        getCheckpoint: query(sqliteLearningProjectionDelivery.getCheckpoint.bind(sqliteLearningProjectionDelivery)),
        claimNext: mutate(sqliteLearningProjectionDelivery.claimNext.bind(sqliteLearningProjectionDelivery)),
        acknowledge: mutate(sqliteLearningProjectionDelivery.acknowledge.bind(sqliteLearningProjectionDelivery)),
        fail: mutate(sqliteLearningProjectionDelivery.fail.bind(sqliteLearningProjectionDelivery)),
      }),
      effects: Object.freeze({
        get: query(sqliteLearningEffects.get.bind(sqliteLearningEffects)),
        record: mutate(sqliteLearningEffects.record.bind(sqliteLearningEffects)),
      }),
    });

    this.attempts = Object.freeze({
      getAttempt: query(sqliteAttempts.getAttempt.bind(sqliteAttempts)),
      getAttemptForRun: query(sqliteAttempts.getAttemptForRun.bind(sqliteAttempts)),
      getActiveAttempt: query(sqliteAttempts.getActiveAttempt.bind(sqliteAttempts)),
      listAttempts: query(sqliteAttempts.listAttempts.bind(sqliteAttempts)),
      listTransitionAudit: query(sqliteAttempts.listTransitionAudit.bind(sqliteAttempts)),
      acquireExecutionLease: mutate(sqliteAttempts.acquireExecutionLease.bind(sqliteAttempts)),
      renewExecutionLease: mutate(sqliteAttempts.renewExecutionLease.bind(sqliteAttempts)),
      releaseExecutionLease: mutate(sqliteAttempts.releaseExecutionLease.bind(sqliteAttempts)),
      recordCandidateResult: mutate(sqliteAttempts.recordCandidateResult.bind(sqliteAttempts)),
      settleAttempt: mutate(sqliteAttempts.settleAttempt.bind(sqliteAttempts)),
      recoverInterruptedAttempt: mutate(sqliteAttempts.recoverInterruptedAttempt.bind(sqliteAttempts)),
      cancelAttempt: mutate(sqliteAttempts.cancelAttempt.bind(sqliteAttempts)),
    });

    this.runtimeMutations = Object.freeze({
      appendEvent: ((context, type, data) => mutationUnitOfWork.run(() => sqliteRuntimeMutations.appendEvent(context, type, data))) as FencedRuntimeMutationPort["appendEvent"],
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

    this.skills = Object.freeze({
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
      appendEvent: ((runId, type, data) => mutationUnitOfWork.run(() => store.appendEvent(runId, type, data))) as RunEventJournal["appendEvent"],
      listEvents: query(store.listEvents.bind(store)),
    });

    this.transcript = Object.freeze({
      getLastTranscriptSeq: query(store.getLastTranscriptSeq.bind(store)),
      getTranscriptCount: query(store.getTranscriptCount.bind(store)),
      appendTranscript: mutate(store.appendTranscript.bind(store)),
      listTranscriptEntries: query(store.listTranscriptEntries.bind(store)),
      searchTranscriptLiteral: query(store.searchTranscriptLiteral.bind(store)),
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
    this.requestEnvelopes = Object.freeze({
      record: mutate(sqliteRequestEnvelopes.record.bind(sqliteRequestEnvelopes)),
      get: query(sqliteRequestEnvelopes.get.bind(sqliteRequestEnvelopes)),
      listForAttempt: query(sqliteRequestEnvelopes.listForAttempt.bind(sqliteRequestEnvelopes)),
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

    this.semanticLearningJobs = Object.freeze({
      enqueueSemanticLearningJob: mutate(store.enqueueSemanticLearningJob.bind(store)),
      claimSemanticLearningJobs: mutate(store.claimSemanticLearningJobs.bind(store)),
      renewSemanticLearningJob: mutate(store.renewSemanticLearningJob.bind(store)),
      completeSemanticLearningJob: mutate(store.completeSemanticLearningJob.bind(store)),
      failSemanticLearningJob: mutate(store.failSemanticLearningJob.bind(store)),
    });

    const learningLedger: LearningLedgerRepository = Object.freeze({
      updateCommunicationProfile: mutate(learningLedgerRepository.updateCommunicationProfile.bind(learningLedgerRepository)),
      findCommunicationProfile: query(learningLedgerRepository.findCommunicationProfile.bind(learningLedgerRepository)),
      setCommunicationProfileLocked: mutate(learningLedgerRepository.setCommunicationProfileLocked.bind(learningLedgerRepository)),
      listCommunicationProfileIds: query(learningLedgerRepository.listCommunicationProfileIds.bind(learningLedgerRepository)),
      getCommunicationProfile: query(learningLedgerRepository.getCommunicationProfile.bind(learningLedgerRepository)),
      getCommunicationRevision: query(learningLedgerRepository.getCommunicationRevision.bind(learningLedgerRepository)),
      recordCorrection: mutate(learningLedgerRepository.recordCorrection.bind(learningLedgerRepository)),
      listLearningToolAttempts: query(learningLedgerRepository.listLearningToolAttempts.bind(learningLedgerRepository)),
      countRunCorrections: query(learningLedgerRepository.countRunCorrections.bind(learningLedgerRepository)),
      getRunLearningPolicyRecord: query(learningLedgerRepository.getRunLearningPolicyRecord.bind(learningLedgerRepository)),
      recordLearningEvent: mutate(learningLedgerRepository.recordLearningEvent.bind(learningLedgerRepository)),
      correctionReferencesRecord: query(learningLedgerRepository.correctionReferencesRecord.bind(learningLedgerRepository)),
      listCorrectionContents: query(learningLedgerRepository.listCorrectionContents.bind(learningLedgerRepository)),
      recordFeedbackAttributionReceipt: mutate(learningLedgerRepository.recordFeedbackAttributionReceipt.bind(learningLedgerRepository)),
      listFeedbackAttributionWork: query(learningLedgerRepository.listFeedbackAttributionWork.bind(learningLedgerRepository)),
      completeFeedbackAttribution: mutate(learningLedgerRepository.completeFeedbackAttribution.bind(learningLedgerRepository)),
      failFeedbackAttribution: mutate(learningLedgerRepository.failFeedbackAttribution.bind(learningLedgerRepository)),
      getLearningEventRow: query(learningLedgerRepository.getLearningEventRow.bind(learningLedgerRepository)),
      listLearningEventIds: query(learningLedgerRepository.listLearningEventIds.bind(learningLedgerRepository)),
      listCorrectionRows: query(learningLedgerRepository.listCorrectionRows.bind(learningLedgerRepository)),
      listFeedbackAttributionRows: query(learningLedgerRepository.listFeedbackAttributionRows.bind(learningLedgerRepository)),
    });
    this.learning = Object.freeze({
      getRun: this.taskRuns.getRun,
      listMessages: this.sessions.listMessages,
      getContextManifestForAttempt: this.contextManifests.getContextManifestForAttempt,
      ...this.semanticLearningJobs,
      learningLedger,
    });

    const workflowRepository: WorkflowLearningRepository = Object.freeze({
      upsertRunLearningPolicy: mutate(workflowLearning.upsertRunLearningPolicy.bind(workflowLearning)),
      getRunLearningPolicy: query(workflowLearning.getRunLearningPolicy.bind(workflowLearning)),
      recordExperienceObservation: mutate(workflowLearning.recordExperienceObservation.bind(workflowLearning)),
      enqueueDistillationJob: mutate(workflowLearning.enqueueDistillationJob.bind(workflowLearning)),
      claimDistillationJob: mutate(workflowLearning.claimDistillationJob.bind(workflowLearning)),
      renewDistillationLease: mutate(workflowLearning.renewDistillationLease.bind(workflowLearning)),
      checkpointDistillationJob: mutate(workflowLearning.checkpointDistillationJob.bind(workflowLearning)),
      updateDistillationCheckpoint: mutate(workflowLearning.updateDistillationCheckpoint.bind(workflowLearning)),
      getDistillationCheckpoint: query(workflowLearning.getDistillationCheckpoint.bind(workflowLearning)),
      completeDistillationJob: mutate(workflowLearning.completeDistillationJob.bind(workflowLearning)),
      failDistillationJob: mutate(workflowLearning.failDistillationJob.bind(workflowLearning)),
      listExperienceCandidates: query(workflowLearning.listExperienceCandidates.bind(workflowLearning)),
      findDistilledWorkflow: query(workflowLearning.findDistilledWorkflow.bind(workflowLearning)),
      recordDistillationConflict: mutate(workflowLearning.recordDistillationConflict.bind(workflowLearning)),
      createWorkflow: mutate(workflowLearning.createWorkflow.bind(workflowLearning)),
      createWorkflowRevision: mutate(workflowLearning.createWorkflowRevision.bind(workflowLearning)),
      listWorkflowDefinitions: query(workflowLearning.listWorkflowDefinitions.bind(workflowLearning)),
      getWorkflowDefinition: query(workflowLearning.getWorkflowDefinition.bind(workflowLearning)),
      listWorkflowRevisionIds: query(workflowLearning.listWorkflowRevisionIds.bind(workflowLearning)),
      getWorkflowRevision: query(workflowLearning.getWorkflowRevision.bind(workflowLearning)),
      findActiveApprovalByHash: query(workflowLearning.findActiveApprovalByHash.bind(workflowLearning)),
      createApproval: mutate(workflowLearning.createApproval.bind(workflowLearning)),
      getApproval: query(workflowLearning.getApproval.bind(workflowLearning)),
      listApprovals: query(workflowLearning.listApprovals.bind(workflowLearning)),
      listApprovalsPage: query(workflowLearning.listApprovalsPage.bind(workflowLearning)),
      decideApproval: mutate(workflowLearning.decideApproval.bind(workflowLearning)),
      revokeApproval: mutate(workflowLearning.revokeApproval.bind(workflowLearning)),
      expireApprovals: mutate(workflowLearning.expireApprovals.bind(workflowLearning)),
      recordApplication: mutate(workflowLearning.recordApplication.bind(workflowLearning)),
      getApplicationReceipt: query(workflowLearning.getApplicationReceipt.bind(workflowLearning)),
      listRunBindings: query(workflowLearning.listRunBindings.bind(workflowLearning)),
      recordRunApplication: mutate(workflowLearning.recordRunApplication.bind(workflowLearning)),
      recordFeedback: mutate(workflowLearning.recordFeedback.bind(workflowLearning)),
      workflowQuality: query(workflowLearning.workflowQuality.bind(workflowLearning)),
      recordSelectorReceipt: mutate(workflowLearning.recordSelectorReceipt.bind(workflowLearning)),
      getCanaryPromotion: query(workflowLearning.getCanaryPromotion.bind(workflowLearning)),
      recordCanaryAssignment: mutate(workflowLearning.recordCanaryAssignment.bind(workflowLearning)),
      recordWorkflowBinding: mutate(workflowLearning.recordWorkflowBinding.bind(workflowLearning)),
      listBindings: query(workflowLearning.listBindings.bind(workflowLearning)),
      listFeedback: query(workflowLearning.listFeedback.bind(workflowLearning)),
      createProposal: mutate(workflowLearning.createProposal.bind(workflowLearning)),
      listProposals: query(workflowLearning.listProposals.bind(workflowLearning)),
      getProposal: query(workflowLearning.getProposal.bind(workflowLearning)),
      decideProposal: mutate(workflowLearning.decideProposal.bind(workflowLearning)),
      listDistillationJobs: query(workflowLearning.listDistillationJobs.bind(workflowLearning)),
      listRunLearningPolicies: query(workflowLearning.listRunLearningPolicies.bind(workflowLearning)),
      listWorkflowQuality: query(workflowLearning.listWorkflowQuality.bind(workflowLearning)),
      listEvaluations: query(workflowLearning.listEvaluations.bind(workflowLearning)),
      listCanaryBindings: query(workflowLearning.listCanaryBindings.bind(workflowLearning)),
      getDistillationMetrics: query(workflowLearning.getDistillationMetrics.bind(workflowLearning)),
      listAutonomyAudit: query(workflowLearning.listAutonomyAudit.bind(workflowLearning)),
      recordAutonomyAudit: mutate(workflowLearning.recordAutonomyAudit.bind(workflowLearning)),
      getEvaluationReceipt: query(workflowLearning.getEvaluationReceipt.bind(workflowLearning)),
      recordEvaluationReceipt: mutate(workflowLearning.recordEvaluationReceipt.bind(workflowLearning)),
      hasWorkflowBinding: query(workflowLearning.hasWorkflowBinding.bind(workflowLearning)),
      listPassedEvaluations: query(workflowLearning.listPassedEvaluations.bind(workflowLearning)),
      listPendingCanaryBindings: query(workflowLearning.listPendingCanaryBindings.bind(workflowLearning)),
      recordCanaryOutcome: mutate(workflowLearning.recordCanaryOutcome.bind(workflowLearning)),
      retryDistillationJob: mutate(workflowLearning.retryDistillationJob.bind(workflowLearning)),
      listDeadLetterJobs: query(workflowLearning.listDeadLetterJobs.bind(workflowLearning)),
    });
    this.workflow = Object.freeze({
      getRun: this.taskRuns.getRun,
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

export function createGuardedSqlitePersistence(store: Store, writerFenceGuard: WriterFenceGuard): SqlitePersistence {
  return new SqlitePersistence(store, new GuardedSqliteUnitOfWork(writerFenceGuard));
}
