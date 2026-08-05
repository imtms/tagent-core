import type { ContextManifestRepository } from "@tagent/governance/ports";
import type { SessionRepository } from "@tagent/admission/ports";
import type { TaskRunRepository } from "@tagent/execution/ports";
import type { SemanticLearningJobQueue } from "./semantic-learning-job-queue.js";

export interface CommunicationProfileRecord {
  id: string;
  subjectId: string;
  scopeType: string;
  scopeId: string;
  status: string;
  activeRevisionId: string | null;
  locked: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface CommunicationRevisionRecord {
  id: string;
  profileId: string;
  revision: number;
  valuesJson: string;
  evidenceJson: string;
  sourceType: string;
  changeSummary: string;
  createdAt: number;
}

export interface CommunicationRevisionWrite {
  valuesJson: string;
  evidenceJson: string;
  sourceType: string;
  changeSummary: string;
}

export interface LearningProjectionLedgerRow {
  runId: string;
  attempt: number;
  lifecycle: string;
  outcome: string;
  eventSeq: number;
  snapshotJson: string;
}

export interface LearningToolAttemptRow {
  toolName: string;
  argsHash: string;
  status: string;
}

export interface FeedbackAttributionWorkItem {
  id: string;
  runId: string;
  actorId: string;
  recordId: string;
  signal: "cited" | "helpful" | "confirmed" | "corrected" | "harmful" | "task_success" | "task_failure";
  basis: string;
  attempts: number;
}

export interface FeedbackAttributionReceiptWrite {
  id: string;
  runId: string;
  attempt: number;
  actorId: string;
  recordId: string;
  signal: FeedbackAttributionWorkItem["signal"];
  weight: number;
  basis: string;
  contextManifestId: string;
  evidenceJson: string;
  idempotencyKey: string;
  createdAt: number;
}

export interface LearningEventWrite {
  id: string;
  runId: string;
  attempt: number;
  lifecycle: string;
  eventSeq: number;
  taskClassificationJson: string;
  strategySelectedJson: string;
  contextUsedJson: string;
  executionTraceJson: string;
  outcomeJson: string;
  attributionJson: string;
  policyJson: string;
  eventHash: string;
  createdAt: number;
  labels: Array<{
    id: string;
    label: string;
    value: string;
    confidence: number;
    evidenceJson: string;
    idempotencyKey: string;
    createdAt: number;
  }>;
}

export interface LearningLedgerRepository {
  updateCommunicationProfile(
    identity: { id: string; subjectId: string; storedSubjectId?: string; scopeType: string; scopeId: string; storedScopeId?: string; timestamp: number },
    update: (profile: { id: string; activeRevisionId: string | null; locked: boolean }, previous: CommunicationRevisionRecord | undefined) => CommunicationRevisionWrite | undefined,
  ): CommunicationProfileRecord;
  findCommunicationProfile(subjectId: string, scopeType: string, scopeId: string): Pick<CommunicationProfileRecord, "id" | "activeRevisionId"> | undefined;
  setCommunicationProfileLocked(profileId: string, locked: boolean, timestamp: number): void;
  listCommunicationProfileIds(subjectId: string): string[];
  getCommunicationProfile(id: string): CommunicationProfileRecord | undefined;
  getCommunicationRevision(id: string): CommunicationRevisionRecord | undefined;
  recordCorrection(input: Record<string, unknown> & { id: string; idempotencyKey: string; createdAt: number }): unknown;
  listUnprojectedLearningRows(limit: number): LearningProjectionLedgerRow[];
  listLearningToolAttempts(runId: string, attempt: number): LearningToolAttemptRow[];
  countRunCorrections(runId: string, attempt: number): number;
  getRunLearningPolicyRecord(runId: string): { policy: string; reason: string } | undefined;
  recordLearningEvent(input: LearningEventWrite): string;
  correctionReferencesRecord(runId: string, recordId: string): boolean;
  listCorrectionContents(runId: string, attempt: number): string[];
  recordFeedbackAttributionReceipt(input: FeedbackAttributionReceiptWrite): void;
  listFeedbackAttributionWork(timestamp: number, limit: number): FeedbackAttributionWorkItem[];
  completeFeedbackAttribution(id: string, timestamp: number): void;
  failFeedbackAttribution(id: string, status: string, attempts: number, retryAt: number, error: string): void;
  getLearningEventRow(id: string): Record<string, unknown> | undefined;
  listLearningEventIds(sessionId: string, limit: number): string[];
  listCorrectionRows(sessionId: string, limit: number): unknown[];
  listFeedbackAttributionRows(sessionId: string, limit: number): unknown[];
}

export type LearningServicePersistencePort =
  & Pick<TaskRunRepository, "getRun">
  & Pick<SessionRepository, "listMessages">
  & Pick<ContextManifestRepository, "getContextManifestForAttempt">
  & SemanticLearningJobQueue
  & { learningLedger: LearningLedgerRepository };
