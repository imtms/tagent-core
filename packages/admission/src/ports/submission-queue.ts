import type {
  SessionId,
  SessionInboxItem,
  SessionInputAnalysis,
} from "../domain/index.js";
import type { RunId, TaskRun } from "@tagent/execution/domain";

export type ClaimedSubmission = { item: SessionInboxItem; run: TaskRun };

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

export interface SubmissionQueue {
  enqueueSessionInbox(
    sessionId: SessionId,
    content: string,
    analysis: SessionInputAnalysis,
    requestId?: string,
  ): SessionInboxItem;
  getSessionInboxItem(id: string): SessionInboxItem | undefined;
  getSessionSubmission(sessionId: SessionId, requestId: string): SessionInboxItem | undefined;
  listSessionInbox(sessionId: SessionId, includeTerminal?: boolean): SessionInboxItem[];
  routeSessionInboxItem(
    id: string,
    sessionId: SessionId,
    decision: "steer" | "follow_up" | "discussion",
    runId: RunId | null,
    error?: string,
  ): SessionInboxItem | undefined;
  findMergeCandidate(sessionId: SessionId, analysis: SessionInputAnalysis): SessionInboxItem | undefined;
  markSessionInboxDuplicate(sourceId: string, targetId: string, sessionId: SessionId): SessionInboxItem | undefined;
  updateSessionInboxItem(
    id: string,
    sessionId: SessionId,
    content: string,
    analysis?: SessionInputAnalysis,
  ): SessionInboxItem | undefined;
  reorderSessionInbox(sessionId: SessionId, itemIds: string[]): SessionInboxItem[] | undefined;
  deleteSessionInboxItem(id: string, sessionId: SessionId): boolean;
  /** Compensates a failed pre-launch admission before the Inbox item becomes observable work. */
  discardSessionInboxItem(id: string, sessionId: SessionId): boolean;
  decideSessionInboxItem(id: string, sessionId: SessionId, decision: "pending" | "defer"): boolean;
  mergeSessionInboxItems(sourceId: string, targetId: string, sessionId: SessionId): boolean;
  claimNextSessionInbox(sessionId: SessionId): ClaimedSubmission | undefined;
  claimSessionInboxNow(itemId: string, sessionId: SessionId, allowApprovedParallel?: boolean): SubmissionStartResult;
  recordSessionInboxLaunchFailure(itemId: string, runId: RunId, error: string): void;
  retryInboxLaunch(runId: RunId): SubmissionRetryResult;
  listSessionsWithQueuedInbox(): SessionId[];
}
