import type { SessionRepository, SubmissionQueue } from "@tagent/admission/ports";
import type {
  ControlInbox,
  EventConsumerRepository,
  TaskRunRepository,
  TranscriptRepository,
} from "@tagent/execution/ports";
import type {
  ContextManifestRepository,
  EvidenceRepository,
  OperationRepository,
  SupervisorDecisionJournal,
} from "@tagent/governance/ports";

export interface HttpPersistencePort {
  sessions: Pick<
    SessionRepository,
    "createSession" | "listSessions" | "getSession" | "updateSession" | "renameSession" | "listMessages"
  >;
  submissions: Pick<SubmissionQueue, "getSessionSubmission" | "listSessionInbox">;
  taskRuns: Pick<
    TaskRunRepository,
    "getRun" | "listRuns" | "getLatestRun" | "listTaskRunEdges"
  >;
  supervisorDecisions: Pick<SupervisorDecisionJournal, "listSupervisorDecisions">;
  contextManifests: Pick<ContextManifestRepository, "listContextManifests">;
  controlInbox: Pick<ControlInbox, "listControlInbox">;
  operations: Pick<
    OperationRepository,
    "claimOperation" | "updateOperation" | "getOperation" | "listOperations"
  >;
  transcript: Pick<TranscriptRepository, "listTranscriptEntries" | "listTranscriptView">;
  evidence: Pick<EvidenceRepository, "getArtifact">;
  eventConsumers: EventConsumerRepository;
}
