import type { SessionRepository, SkillRepository, SubmissionQueue } from "@tagent/admission/ports";
import type {
  CheckpointRepository,
  ContinuationQueue,
  ControlInbox,
  AttemptRepository,
  FencedRuntimeMutationPort,
  RunEventJournal,
  RuntimePersistencePort,
  TaskRunRepository,
  TaskRunTransitionPort,
  TranscriptRepository,
  AttemptRequestEnvelopeRepository,
} from "@tagent/execution/ports";
import type {
  ApprovalRepository,
  AcceptedUncertaintyRepository,
  ContextManifestRepository,
  SupervisorDecisionJournal,
  SupervisorPersistencePort,
  WorkspaceGoalOperationRepository,
  WorkspaceGoalRepository,
} from "@tagent/governance/ports";

/** Persistence capabilities required by the Core application, grouped by domain context. */
export interface CoreApplicationPersistencePort {
  /** One synchronous Core-owned transaction; nested adapter mutations reuse it. */
  readonly mutations: { run<T>(work: () => T): T };
  readonly attempts: AttemptRepository;
  readonly runtimeMutations: FencedRuntimeMutationPort;
  readonly sessions: SessionRepository;
  readonly skills: SkillRepository;
  readonly submissions: SubmissionQueue;
  readonly taskRuns: TaskRunRepository;
  readonly taskRunTransitions: TaskRunTransitionPort;
  readonly continuations: ContinuationQueue;
  readonly controlInbox: ControlInbox;
  readonly events: RunEventJournal;
  readonly transcript: TranscriptRepository;
  readonly checkpoints: CheckpointRepository;
  readonly approvals: ApprovalRepository;
  readonly uncertainties: AcceptedUncertaintyRepository;
  readonly contextManifests: ContextManifestRepository;
  readonly requestEnvelopes: AttemptRequestEnvelopeRepository;
  readonly supervisorDecisions: SupervisorDecisionJournal;
  readonly runtime: RuntimePersistencePort;
  readonly supervisor: SupervisorPersistencePort;
  readonly workspaceGoals: WorkspaceGoalRepository;
  readonly workspaceGoalOperations: WorkspaceGoalOperationRepository;
}
