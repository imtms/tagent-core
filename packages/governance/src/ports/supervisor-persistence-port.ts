import type { GovernanceContextManifestView, GovernanceControlInboxItemView, GovernanceTaskRunView } from "./governance-views.js";
import type { OperationRepository } from "./operation-repository.js";
import type { ProgressRepository } from "./progress-repository.js";
import type { GateEvaluationRepository } from "./gate-evaluation-repository.js";
import type { SupervisorDecisionJournal } from "./supervisor-decision-journal.js";
import type { EvidenceSourceRepository } from "./evidence-source-repository.js";
import type { AcceptedUncertaintyRepository } from "./accepted-uncertainty-repository.js";

export interface SupervisorTaskRunReader {
  getRun(runId: string): GovernanceTaskRunView | undefined;
}

export interface SupervisorControlInboxReader {
  listControlInbox(runId: string): GovernanceControlInboxItemView[];
}

export interface SupervisorContextManifestReader {
  getLatestContextManifest(runId: string): GovernanceContextManifestView | undefined;
}

export type SupervisorPersistencePort =
  & SupervisorTaskRunReader
  & SupervisorControlInboxReader
  & Pick<OperationRepository, "listOperations">
  & Pick<EvidenceSourceRepository, "resolveEvidenceSources">
  & Pick<AcceptedUncertaintyRepository, "listAcceptedUncertainties">
  & Pick<ProgressRepository, "getProgressSnapshot" | "updateProgressSnapshot">
  & SupervisorContextManifestReader
  & Pick<GateEvaluationRepository, "recordGateEvaluation">
  & Pick<
    SupervisorDecisionJournal,
    "recordSupervisorDecision" | "listSupervisorDecisions" | "updateSupervisorDecision"
  >;
