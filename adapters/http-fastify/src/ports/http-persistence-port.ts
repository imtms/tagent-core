import type { ProfileContractRepository, SessionRepository, SubmissionQueue } from "@tagent/admission/ports";
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
} from "@tagent/governance/ports";
import type { ReasoningEffort } from "@tagent/admission/domain";
import type { RunPhase, RunStatus } from "@tagent/execution/domain";

interface HttpOperatorReadPageQuery {
  snapshotRowId?: number;
  after?: { createdAt: number; id: string };
  limit: number;
}

interface HttpOperatorSessionRow {
  id: string; title: string; modelId: string; reasoningEffort: ReasoningEffort;
  createdAt: number; updatedAt: number; latestTaskRunId: string | null;
  latestTaskRunStatus: RunStatus | null; latestTaskRunPhase: RunPhase | null; latestActivityAt: number;
}

interface HttpOperatorTaskRunRow {
  id: string; sessionId: string; status: RunStatus; phase: RunPhase; attempt: number;
  goalSummary: string; blockedReason: string | null; pendingApproval: number; pendingUserInput: number;
  lastEventSequence: number; createdAt: number; updatedAt: number; completedAt: number | null; resumable: number;
}

export interface HttpPersistencePort {
  profileContracts: ProfileContractRepository;
  operatorRead: {
    listSessionsPage(query: HttpOperatorReadPageQuery): { items: HttpOperatorSessionRow[]; snapshotRowId: number };
    listSessionTaskRunsPage(sessionId: string, query: HttpOperatorReadPageQuery): { items: HttpOperatorTaskRunRow[]; snapshotRowId: number };
    getLatestSessionTaskRun(sessionId: string): HttpOperatorTaskRunRow | undefined;
  };
  sessions: Pick<
    SessionRepository,
    "createSession" | "createSessionIdempotent" | "listSessions" | "getSession" | "updateSession" | "renameSession" | "listMessages"
  >;
  submissions: Pick<SubmissionQueue, "getSessionSubmission" | "getSubmissionAudit" | "listSessionInbox">;
  taskRuns: Pick<
    TaskRunRepository,
    "hasRun" | "getRun" | "getRunReadView" | "getRunExecutionState"
    | "listRuns" | "listRunSummaries" | "getLatestRun" | "listTaskRunEdges"
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
}
