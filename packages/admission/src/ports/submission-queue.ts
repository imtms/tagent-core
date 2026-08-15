import type {
  SessionId,
  Submission,
  SessionInputAnalysis,
} from "../domain/index.js";
import type { RunId, TaskRun } from "@tagent/execution/domain";
import type { ProfileInboxItemRecord, ProfileMutationContext, ProfileMutationResult } from "./profile-contract-repository.js";

export type ClaimedSubmission = { item: Submission; run: TaskRun };

export interface SubmissionAuditInput {
  principalId: string;
  canonicalPayload: string;
  provenance?: Record<string, unknown>;
}

export interface SubmissionAuditReceipt extends SubmissionAuditInput {
  sessionId: SessionId;
  idempotencyKey: string;
  submissionId: string;
  payloadHash: string;
  provenance: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export type SubmissionStartResult =
  | { status: "not_queued" }
  | { status: "running"; runId: RunId }
  | { status: "continuation"; continuationId: string }
  | ({ status: "started" } & ClaimedSubmission);

export type SubmissionRetryResult =
  | { status: "not_retryable" }
  | { status: "running"; runId: RunId }
  | { status: "continuation"; continuationId: string }
  | ({ status: "started" } & ClaimedSubmission);

export interface ProfileInboxMutationValue {
  items: ProfileInboxItemRecord[];
  collectionRevision: number;
}

export interface SubmissionQueue {
  updateSessionInboxItemProfile(input: {
    sessionId: SessionId;
    itemId: string;
    content: string;
    analysis: SessionInputAnalysis;
    mutation: ProfileMutationContext;
  }): ProfileMutationResult<ProfileInboxMutationValue>;
  reorderSessionInboxProfile(input: {
    sessionId: SessionId;
    itemIds: string[];
    mutation: ProfileMutationContext;
  }): ProfileMutationResult<ProfileInboxMutationValue>;
  deleteSessionInboxItemProfile(input: {
    sessionId: SessionId;
    itemId: string;
    mutation: ProfileMutationContext;
  }): ProfileMutationResult<ProfileInboxMutationValue>;
  decideSessionInboxItemProfile(input: {
    sessionId: SessionId;
    itemId: string;
    decision: "pending" | "defer";
    mutation: ProfileMutationContext;
  }): ProfileMutationResult<ProfileInboxMutationValue>;
  mergeSessionInboxItemsProfile(input: {
    sessionId: SessionId;
    sourceId: string;
    targetId: string;
    mutation: ProfileMutationContext;
  }): ProfileMutationResult<ProfileInboxMutationValue>;
  enqueueSessionInbox(
    sessionId: SessionId,
    content: string,
    analysis: SessionInputAnalysis,
    requestId?: string,
    audit?: SubmissionAuditInput,
  ): Submission;
  getSessionInboxItem(id: string): Submission | undefined;
  getSessionSubmission(sessionId: SessionId, requestId: string): Submission | undefined;
  recordSubmissionAudit(item: Submission, audit: SubmissionAuditInput): SubmissionAuditReceipt;
  getSubmissionAudit(sessionId: SessionId, requestId: string): SubmissionAuditReceipt | undefined;
  /** Stable owner identity for user-level Memory/Learning; anonymous Sessions may not have one. */
  getSessionPrincipalId(sessionId: SessionId): string | undefined;
  listSessionInbox(sessionId: SessionId, includeTerminal?: boolean): Submission[];
  routeSessionInboxItem(
    id: string,
    sessionId: SessionId,
    decision: "steer" | "follow_up" | "discussion",
    runId: RunId | null,
    error?: string,
  ): Submission | undefined;
  findMergeCandidate(sessionId: SessionId, analysis: SessionInputAnalysis): Submission | undefined;
  markSessionInboxDuplicate(sourceId: string, targetId: string, sessionId: SessionId): Submission | undefined;
  /** Compensates a failed pre-launch admission before the Inbox item becomes observable work. */
  discardSessionInboxItem(id: string, sessionId: SessionId): boolean;
  decideSessionInboxItem(id: string, sessionId: SessionId, decision: "pending" | "defer"): boolean;
  claimNextSessionInbox(sessionId: SessionId): ClaimedSubmission | undefined;
  claimSessionInboxNow(itemId: string, sessionId: SessionId, allowApprovedParallel?: boolean): SubmissionStartResult;
  recordSessionInboxLaunchFailure(itemId: string, runId: RunId, error: string): void;
  retryInboxLaunch(runId: RunId): SubmissionRetryResult;
  listSessionsWithQueuedInbox(): SessionId[];
}
