import type { RunEvent, RunId, TaskRun, UserInputField, UserInputRequest } from "../domain/index.js";

export interface MemoryToolCapabilities {
  search(query: string, kinds?: string[], maxResults?: number): Promise<unknown>;
  getTopic(topicId: string): Promise<{ body: string; revision: number; checksum: string } | undefined>;
  getRecord(id: string): Promise<unknown | undefined>;
  forget(input: { ids?: string[]; topicIds?: string[]; reason?: string; gracePeriodMs?: number }): Promise<unknown>;
}

/** Consumer-owned application capabilities exposed to built-in agent tools. */
export interface ToolCapabilityApplicationPort {
  readonly runId: RunId;
  getRun(): TaskRun | undefined;
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
  listOperations(): unknown[];
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
  }): unknown;
  addArtifact(artifact: { id: string; title: string; kind: string; content: string; uri: string }): unknown;
  requestUserInput(toolCallId: string, prompt: string, fields: UserInputField[]): UserInputRequest;
  publish(type: string, data: Record<string, unknown>): RunEvent | undefined;
  readonly memory?: MemoryToolCapabilities;
}
