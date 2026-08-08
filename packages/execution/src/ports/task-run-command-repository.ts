import type { TaskRunCommandReceipt, TaskRunCommandReceiptState } from "../domain/task-run.js";

export interface TaskRunCommandReceiptRepository {
  claimTaskRunCommand(input: {
    principalId: string;
    taskRunId: string;
    commandId: string;
    commandType: string;
    canonicalPayload: string;
    targetAttemptId: string | null;
    provenance?: Record<string, unknown>;
    requestId: string;
  }): { receipt: TaskRunCommandReceipt; claimed: boolean };
  getTaskRunCommand(principalId: string, taskRunId: string, commandId: string): TaskRunCommandReceipt | undefined;
  settleTaskRunCommand(
    principalId: string,
    taskRunId: string,
    commandId: string,
    state: Exclude<TaskRunCommandReceiptState, "started">,
    result?: Record<string, unknown>,
    error?: Record<string, unknown>,
  ): TaskRunCommandReceipt;
}
