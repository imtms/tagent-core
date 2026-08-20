import type {
  RunId,
  RunPhase,
  ExecutionSessionRef,
  TaskRun,
  TaskRunReadView,
  TaskRunExecutionState,
  TaskRunSummary,
  UserInputField,
  UserInputRequest,
} from "../domain/task-run.js";
import type { TaskRunContractSnapshot } from "../domain/task-run-launch.js";

export interface ModelUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens: number;
  cost?: number;
}

export interface TaskRunRepository {
  createRun(sessionId: ExecutionSessionRef, goal: string, requestId?: string, contract?: TaskRunContractSnapshot | null): TaskRun;
  getRun(id: RunId): TaskRun | undefined;
  getRunReadView(id: RunId): TaskRunReadView | undefined;
  getRunExecutionState(id: RunId): TaskRunExecutionState | undefined;
  listRuns(sessionId: ExecutionSessionRef, limit?: number): TaskRun[];
  listRunSummaries?(sessionId: ExecutionSessionRef, limit?: number): TaskRunSummary[];
  getActiveRun(sessionId: ExecutionSessionRef): TaskRun | undefined;
  getUserInputRequestById(requestId: string): UserInputRequest | undefined;
  requestUserInput(runId: RunId, prompt: string, fields: UserInputField[]): UserInputRequest;
  submitUserInput(requestId: string, response: Record<string, string>): { request: UserInputRequest; run: TaskRun };
  recordModelUsage(runId: RunId, component: string, model: string, usage: ModelUsage): void;
  setRunPhase(runId: RunId, phase: RunPhase): boolean;
  advanceRunPhase(runId: RunId, phase: Exclude<RunPhase, "done" | "blocked" | "waiting_input">): boolean;
}
