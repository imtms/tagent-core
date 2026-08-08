import type { SessionRepository, SubmissionQueue } from "@tagent/admission/ports";
import type {
  ControlInbox,
  EventConsumerRepository,
  TaskRunRepository,
  TaskRunCommandReceiptRepository,
  TranscriptRepository,
} from "@tagent/execution/ports";
import type {
  ContextManifestRepository,
  EvidenceRepository,
  OperationRepository,
  SupervisorDecisionJournal,
  WorkspaceGoalRepository,
  WorkspaceGoalOperationRepository,
} from "@tagent/governance/ports";

export interface HttpPersistencePort {
  sessions: Pick<
    SessionRepository,
    "createSession" | "createSessionIdempotent" | "listSessions" | "getSession" | "updateSession" | "renameSession" | "listMessages"
  >;
  submissions: Pick<SubmissionQueue, "getSessionSubmission" | "getSubmissionAudit" | "listSessionInbox">;
  taskRuns: Pick<
    TaskRunRepository,
    "hasRun" | "getRun" | "listRuns" | "getLatestRun" | "listTaskRunEdges"
  >;
  taskRunCommands: TaskRunCommandReceiptRepository;
  supervisorDecisions: Pick<SupervisorDecisionJournal, "listSupervisorDecisions">;
  contextManifests: Pick<ContextManifestRepository, "listContextManifests">;
  controlInbox: Pick<ControlInbox, "listControlInbox">;
  operations: Pick<
    OperationRepository,
    "claimOperation" | "updateOperation" | "getOperation" | "listOperations"
  >;
  transcript: Pick<TranscriptRepository, "listTranscriptEntries" | "listTranscriptView">;
  evidence: Pick<EvidenceRepository, "getArtifact" | "listArtifacts">;
  eventConsumers: EventConsumerRepository;
  workspaceGoals: WorkspaceGoalRepository;
  workspaceGoalOperations: WorkspaceGoalOperationRepository;
}
