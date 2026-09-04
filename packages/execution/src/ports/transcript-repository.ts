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

export type TranscriptRole = RuntimeMessage["role"];
export type TranscriptViewKind = TranscriptViewItem["kind"];

export interface TranscriptFilters {
  attempt?: number;
  role?: TranscriptRole;
  kind?: TranscriptViewKind;
  /** Inclusive durable write-time lower bound. */
  createdAfter?: number;
  /** Exclusive durable write-time upper bound. */
  createdBefore?: number;
}

export interface TranscriptEntryQuery extends TranscriptFilters {
  limit?: number;
  after?: number;
}

export interface TranscriptSearchOptions extends TranscriptFilters {
  limit?: number;
  snippetChars?: number;
  /** Exclusive sequence cursor; search results are newest first. */
  beforeSeq?: number;
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
  listTranscriptEntries(runId: RunId, options?: TranscriptEntryQuery): TranscriptEntry[];
  /** Case-sensitive literal search over durable message JSON, newest match first. `beforeSeq` is exclusive. */
  searchTranscriptLiteral(
    runId: RunId,
    query: string,
    options?: TranscriptSearchOptions,
  ): TranscriptLiteralSearchResult;
  /** Unicode61 FTS term search; all whitespace-delimited terms must match. */
  searchTranscriptTerms(
    runId: RunId,
    query: string,
    options?: TranscriptSearchOptions,
  ): TranscriptLiteralSearchResult;
  listTranscript(runId: RunId): RuntimeMessage[];
  repairTranscript(
    runId: RunId,
    reason: "cancelled" | "resume" | "continuation",
  ): Array<{ toolCallId: string; toolName: string }>;
  listTranscriptView(runId: RunId, options?: TranscriptEntryQuery): TranscriptViewItem[];
}
