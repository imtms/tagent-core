import type { RunId } from "../domain/task-run.js";
import type { RuntimeMessage } from "./attempt-runtime.js";
import type { StructuredToolError } from "./tool-error.js";

export interface TranscriptEntry {
  message: RuntimeMessage;
  seq: number;
  attempt: number;
  role: string;
  createdAt: number;
}

export interface TranscriptLiteralSearchMatch {
  seq: number;
  attempt: number;
  role: string;
  snippet: string;
  createdAt: number;
}

export interface TranscriptLiteralSearchResult {
  matches: TranscriptLiteralSearchMatch[];
  truncated: boolean;
}

export type TranscriptViewItem =
  | { seq: number; index?: number; attempt: number; kind: "user" | "assistant"; text: string; createdAt: number }
  | { seq: number; index: number; attempt: number; kind: "thinking"; text: string; redacted: boolean; createdAt: number }
  | {
      seq: number;
      index: number;
      attempt: number;
      kind: "tool";
      toolCallId: string;
      toolName: string;
      arguments: unknown;
      result: string;
      isError: boolean;
      error?: StructuredToolError;
      status: "pending" | "completed" | "failed";
      createdAt: number;
    };

export interface TranscriptRepository {
  getLastTranscriptSeq(runId: RunId): number;
  getTranscriptCount(runId: RunId): number;
  appendTranscript(runId: RunId, attempt: number, message: RuntimeMessage): number;
  listTranscriptEntries(runId: RunId, options?: { limit?: number; attempt?: number; after?: number }): TranscriptEntry[];
  /** Case-sensitive literal search over durable message JSON, newest match first. `beforeSeq` is exclusive. */
  searchTranscriptLiteral(
    runId: RunId,
    query: string,
    options?: { limit?: number; snippetChars?: number; beforeSeq?: number },
  ): TranscriptLiteralSearchResult;
  listTranscript(runId: RunId): RuntimeMessage[];
  repairTranscript(
    runId: RunId,
    reason: "cancelled" | "resume" | "continuation",
  ): Array<{ toolCallId: string; toolName: string }>;
  listTranscriptView(runId: RunId, options?: { limit?: number; attempt?: number; after?: number }): TranscriptViewItem[];
}
