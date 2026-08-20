import type { MessageSourceRepository, ProfileContractRepository, SessionRepository, SkillRepository, SubmissionQueue } from "@tagent/admission/ports";
import type {
  AttemptRepository,
  CheckpointRepository,
  ContinuationQueue,
  ControlInbox,
  EventConsumerRepository,
  FencedRuntimeMutationPort,
  GenerationMaintenanceRepository,
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
  WorkspaceGoalRepository,
  WorkspaceGoalOperationRepository,
} from "@tagent/governance/ports";
import type { MemorySourceRepository } from "@tagent/memory/ports";
import type { Store } from "../store.js";
import type { MutationUnitOfWork, SynchronousResult } from "../unit-of-work.js";
import type { WriterFenceGuard } from "./writer-fence-guard.js";
import { SqliteAttemptRepository } from "./attempt-repository.js";
import { SqliteFencedRuntimeMutationRepository } from "./attempt-runtime-mutation-repository.js";
import { SqliteTaskRunTransitionRepository } from "./task-run-transition-repository.js";
import { SqliteWorkspaceGoalRepository } from "./workspace-goal-repository.js";
import { SqliteWorkspaceGoalOperationRepository } from "./workspace-goal-operation-repository.js";
import { SqliteAttemptRequestEnvelopeRepository } from "./attempt-request-envelope-repository.js";
import { SqliteProfileContractRepository } from "./profile-contract-repository.js";
import { createStoreBackedPorts } from "./store-port-bindings.js";

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
  readonly generationMaintenance: GenerationMaintenanceRepository;
  readonly operatorRead: {
    listSessionsPage: Store["listOperatorSessionsPage"];
    listSessionTaskRunsPage: Store["listOperatorSessionTaskRunsPage"];
    getLatestSessionTaskRun: Store["getLatestOperatorSessionTaskRun"];
  };
  readonly profileContracts: ProfileContractRepository;

  constructor(store: Store, mutationUnitOfWork: MutationUnitOfWork) {
    const mutate = <Args extends unknown[], Result>(operation: SynchronousOperation<Args, Result>) =>
      mutation(mutationUnitOfWork, operation);
    const sqliteAttempts = new SqliteAttemptRepository(store.db);
    const sqliteRuntimeMutations = new SqliteFencedRuntimeMutationRepository(store.db, store);
    const sqliteTaskRunTransitions = new SqliteTaskRunTransitionRepository(store.db, store);
    const sqliteWorkspaceGoals = new SqliteWorkspaceGoalRepository(store.db);
    const sqliteWorkspaceGoalOperations = new SqliteWorkspaceGoalOperationRepository(store.db);
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
      reconcileRunState: mutate(sqliteWorkspaceGoals.reconcileRunState.bind(sqliteWorkspaceGoals)),
      linkEvidence: mutate(sqliteWorkspaceGoals.linkEvidence.bind(sqliteWorkspaceGoals)),
      authorizeRunMutation: query(sqliteWorkspaceGoals.authorizeRunMutation.bind(sqliteWorkspaceGoals)),
    });
    this.workspaceGoalOperations = Object.freeze({
      claimWorkspaceGoalOperation: mutate(sqliteWorkspaceGoalOperations.claimWorkspaceGoalOperation.bind(sqliteWorkspaceGoalOperations)),
      getWorkspaceGoalOperation: query(sqliteWorkspaceGoalOperations.getWorkspaceGoalOperation.bind(sqliteWorkspaceGoalOperations)),
      settleWorkspaceGoalOperation: mutate(sqliteWorkspaceGoalOperations.settleWorkspaceGoalOperation.bind(sqliteWorkspaceGoalOperations)),
    });

    this.attempts = Object.freeze({
      getAttempt: query(sqliteAttempts.getAttempt.bind(sqliteAttempts)),
      getAttemptForRun: query(sqliteAttempts.getAttemptForRun.bind(sqliteAttempts)),
      getActiveAttempt: query(sqliteAttempts.getActiveAttempt.bind(sqliteAttempts)),
      listAttempts: query(sqliteAttempts.listAttempts.bind(sqliteAttempts)),
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

    const storePorts = createStoreBackedPorts(store, mutationUnitOfWork, sqliteRequestEnvelopes);
    this.sessions = storePorts.sessions;
    this.skills = storePorts.skills;
    this.operatorRead = storePorts.operatorRead;
    this.taskRunCommands = storePorts.taskRunCommands;
    this.messageSources = storePorts.messageSources;
    this.submissions = storePorts.submissions;
    this.taskRuns = storePorts.taskRuns;
    this.continuations = storePorts.continuations;
    this.controlInbox = storePorts.controlInbox;
    this.events = storePorts.events;
    this.transcript = storePorts.transcript;
    this.checkpoints = storePorts.checkpoints;
    this.eventConsumers = storePorts.eventConsumers;
    this.operations = storePorts.operations;
    this.evidence = storePorts.evidence;
    this.gates = storePorts.gates;
    this.progress = storePorts.progress;
    this.contextManifests = storePorts.contextManifests;
    this.requestEnvelopes = storePorts.requestEnvelopes;
    this.generationMaintenance = storePorts.generationMaintenance;
    this.approvals = storePorts.approvals;
    this.supervisorDecisions = storePorts.supervisorDecisions;
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
      listDurableUserMessagesPage: this.messageSources.listDurableUserMessagesPage,
      getRun: this.taskRuns.getRun,
      listTranscriptView: this.transcript.listTranscriptView,
      appendEvent: this.events.appendEvent,
    });
  }
}

export function createGuardedSqlitePersistence(store: Store, writerFenceGuard: WriterFenceGuard): SqlitePersistence {
  return new SqlitePersistence(store, new GuardedSqliteUnitOfWork(writerFenceGuard));
}
