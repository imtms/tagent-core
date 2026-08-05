import type { SessionRepository, SubmissionQueue } from "@tagent/admission/ports";
import type {
  CheckpointRepository,
  ContinuationQueue,
  ControlInbox,
  AttemptAuthorityRepository,
  AttemptRepository,
  FencedRuntimeMutationPort,
  RunEventJournal,
  RuntimePersistencePort,
  TaskRunRepository,
  TaskRunTransitionPort,
  TranscriptRepository,
} from "@tagent/execution/ports";
import type {
  ApprovalRepository,
  ContextManifestRepository,
  SupervisorDecisionJournal,
  SupervisorPersistencePort,
  WorkflowGovernancePersistencePort,
} from "@tagent/governance/ports";
import type {
  LearningServicePersistencePort,
  WorkflowServicePersistencePort,
} from "@tagent/learning/ports";

/** Persistence capabilities owned by AgentService, grouped by domain context. */
export interface AgentServicePersistencePort {
  readonly attempts: AttemptRepository;
  readonly attemptAuthority: AttemptAuthorityRepository;
  readonly runtimeMutations: FencedRuntimeMutationPort;
  readonly sessions: SessionRepository;
  readonly submissions: SubmissionQueue;
  readonly taskRuns: TaskRunRepository;
  readonly taskRunTransitions: TaskRunTransitionPort;
  readonly continuations: ContinuationQueue;
  readonly controlInbox: ControlInbox;
  readonly events: RunEventJournal;
  readonly transcript: TranscriptRepository;
  readonly checkpoints: CheckpointRepository;
  readonly approvals: ApprovalRepository;
  readonly contextManifests: ContextManifestRepository;
  readonly supervisorDecisions: SupervisorDecisionJournal;
  readonly runtime: RuntimePersistencePort;
  readonly supervisor: SupervisorPersistencePort;
  readonly workflowGovernance: WorkflowGovernancePersistencePort;
  readonly learning: LearningServicePersistencePort;
  readonly workflow: WorkflowServicePersistencePort;
}
