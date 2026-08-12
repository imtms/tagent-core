import type { SessionInputAnalysis } from "./session-input.js";
import type { SessionId } from "./session.js";

export const MAX_SUBMISSION_CONTENT_CHARS = 200_000;

export function assertSubmissionContent(content: string): void {
  if (!content.trim()) throw new Error("Submission content is required");
  if (content.length > MAX_SUBMISSION_CONTENT_CHARS) {
    throw new Error(`Submission content cannot exceed ${MAX_SUBMISSION_CONTENT_CHARS} characters`);
  }
}

export interface Submission {
  id: string;
  sessionId: SessionId;
  requestId: string;
  content: string;
  status: "queued" | "claimed" | "started" | "routed" | "deleted" | "failed";
  decision: "pending" | "start_taskrun" | "steer" | "follow_up" | "discussion" | "defer" | "merge" | "delete";
  runId: string | null;
  error: string;
  position: number;
  createdAt: number;
  updatedAt: number;
  claimedAt: number | null;
  startedAt: number | null;
  analysis: SessionInputAnalysis;
  manualOrder: boolean;
}

/** @deprecated Use Submission. */
export type SessionInboxItem = Submission;
