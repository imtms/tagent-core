import type {
  RunId,
  RunPhase,
  ExecutionSessionRef,
  TaskRun,
  TaskRunEdge,
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
  hasRun(id: RunId): boolean;
  getRun(id: RunId): TaskRun | undefined;
  getRunByRequestId(requestId: string): TaskRun | undefined;
  listRuns(sessionId: ExecutionSessionRef, limit?: number): TaskRun[];
  listRunSummaries?(sessionId: ExecutionSessionRef, limit?: number): Array<Pick<TaskRun, "id" | "goal" | "status" | "phase" | "contract" | "updatedAt">>;
  getLatestRun(sessionId: ExecutionSessionRef): TaskRun | undefined;
  getActiveRun(sessionId: ExecutionSessionRef): TaskRun | undefined;
  getPendingUserInputRequest(runId: RunId): UserInputRequest | undefined;
  getPendingUserInputRequestById(requestId: string): UserInputRequest | undefined;
  requestUserInput(runId: RunId, prompt: string, fields: UserInputField[]): UserInputRequest;
  submitUserInput(requestId: string, response: Record<string, string>): { request: UserInputRequest; run: TaskRun };
  recordModelUsage(runId: RunId, component: string, model: string, usage: ModelUsage): void;
  setRunPhase(runId: RunId, phase: RunPhase): boolean;
  advanceRunPhase(runId: RunId, phase: Exclude<RunPhase, "done" | "blocked" | "waiting_input">): boolean;
  listTaskRunEdges(runId: RunId): TaskRunEdge[];
  isRunResumable(runId: RunId): boolean;
}
