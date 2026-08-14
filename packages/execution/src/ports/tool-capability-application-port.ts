import type { RunEvent, RunId, TaskRun, TaskRunExecutionState, UserInputField, UserInputRequest } from "../domain/index.js";
import type { ArtifactSinkPort } from "./artifact-sink-port.js";
import type { WorkspaceEditPort } from "./workspace-edit-port.js";
import type { TaskRunStateMutation } from "./attempt-repository.js";
import type { OperationRecord } from "@tagent/governance/ports";
import type { TranscriptLiteralSearchResult } from "./transcript-repository.js";

export interface MemoryToolCapabilities {
  search(query: string, kinds: string[] | undefined, maxResults: number | undefined, signal: AbortSignal): Promise<unknown>;
  getTopic(topicId: string, signal: AbortSignal): Promise<{ body: string; revision: number; checksum: string } | undefined>;
  getRecord(id: string, signal: AbortSignal): Promise<unknown | undefined>;
  forget(input: { ids?: string[]; topicIds?: string[]; reason?: string; gracePeriodMs?: number }, signal: AbortSignal): Promise<unknown>;
}

export interface HistoryToolCapabilities {
  search(query: string, signal: AbortSignal): Promise<TranscriptLiteralSearchResult & { beforeSeq: number }>;
}

/** Consumer-owned application capabilities exposed to built-in agent tools. */
export interface ToolCapabilityApplicationPort {
  readonly runId: RunId;
  readonly artifactSink?: ArtifactSinkPort;
  readonly workspaceEdit?: WorkspaceEditPort;
  getRun(): TaskRun | undefined;
  getRunExecutionState?(): TaskRunExecutionState | undefined;
  isCurrentAttempt(): boolean;
  authorizeWorkspaceMutation(): { allowed: boolean; reason: string };
  authorizeExternalAction(): { allowed: boolean; reason: string };
  advanceRunPhase(phase: "implement"): boolean;
  setRunPhase(phase: "discover" | "plan" | "implement" | "verify" | "review"): boolean;
  claimOperation(id: string, operationType: string, payload: unknown): {
    claimed: boolean;
    status: string;
    result?: unknown;
  };
  updateOperation(id: string, update: {
    status: string;
    stage?: string;
    effects?: unknown[];
    result?: unknown;
    error?: string;
  }): unknown;
  listOperations(options?: { limit?: number; ids?: string[] }): OperationRecord[];
  upsertPlanItem(item: {
    key: string;
    title: string;
    status: "pending" | "in_progress" | "done" | "blocked" | "skipped";
    required: boolean;
    position: number;
  }): unknown;
  markChecksStale(): number;
  upsertCheck(check: {
    key: string;
    title: string;
    status: "pending" | "running" | "passed" | "failed" | "blocked" | "skipped";
    required: boolean;
    command: string;
    evidence: string;
    stale: boolean;
    sourceOperationId?: string | null;
    observedAt?: number | null;
  }): unknown;
  applyTaskRunBatch(mutations: TaskRunStateMutation[]): void;
  addArtifact(artifact: { id: string; title: string; kind: string; content: string; uri: string }): unknown;
  requestUserInput(toolCallId: string, prompt: string, fields: UserInputField[]): UserInputRequest;
  recordToolAttempt(toolCallId: string, toolName: string, args: unknown): {
    created: boolean;
    status: "running" | "succeeded" | "failed";
    guard: { blocked: boolean; reason: string };
  };
  completeToolAttempt(toolCallId: string, success: boolean, error?: string): boolean;
  consumeAtomicallySettledToolCall(toolCallId: string): boolean;
  publish<TType extends import("../domain/task-run.js").RunEventType>(type: TType, data: import("../domain/task-run.js").RunEventMap[TType]): RunEvent<TType> | undefined;
  readonly memory?: MemoryToolCapabilities;
  readonly history?: HistoryToolCapabilities;
}
