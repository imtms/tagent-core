export interface OperationRecord {
  id: string;
  runId: string;
  attempt: number;
  operationType: string;
  payloadHash: string;
  status: string;
  stage: string;
  effects: unknown[];
  result?: unknown;
  error: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface OperationUpdate {
  status: string;
  stage?: string;
  effects?: unknown[];
  result?: unknown;
  error?: string;
  expectedStatuses?: string[];
}

export interface OperationRepository {
  claimOperation(
    id: string,
    runId: string,
    attempt: number,
    operationType: string,
    payload: unknown,
  ): OperationRecord & { claimed: boolean };
  updateOperation(id: string, update: OperationUpdate): OperationRecord;
  getOperation(id: string): OperationRecord | undefined;
  listOperations(runId: string): OperationRecord[];
  recordToolAttempt(
    runId: string,
    attempt: number,
    toolCallId: string,
    toolName: string,
    args: unknown,
  ): { argsHash: string; guard: { blocked: boolean; reason: string } };
  completeToolAttempt(
    runId: string,
    attempt: number,
    toolCallId: string,
    success: boolean,
    error?: string,
  ): void;
}
