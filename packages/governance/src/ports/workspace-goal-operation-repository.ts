export type WorkspaceGoalOperationState = "started" | "succeeded" | "failed" | "outcome_unknown";
export interface WorkspaceGoalOperationReceipt {
  goalId: string;
  requestId: string;
  operationType: string;
  payloadHash: string;
  payload: Record<string, unknown>;
  state: WorkspaceGoalOperationState;
  result: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface WorkspaceGoalOperationRepository {
  claimWorkspaceGoalOperation(input: {
    goalId: string; requestId: string; operationType: string; canonicalPayload: string;
  }): { receipt: WorkspaceGoalOperationReceipt; claimed: boolean };
  getWorkspaceGoalOperation(goalId: string, requestId: string): WorkspaceGoalOperationReceipt | undefined;
  settleWorkspaceGoalOperation(
    goalId: string, requestId: string,
    state: Exclude<WorkspaceGoalOperationState, "started">,
    result?: Record<string, unknown>, error?: Record<string, unknown>,
  ): WorkspaceGoalOperationReceipt;
}
