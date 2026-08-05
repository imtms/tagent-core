import type { RunContinuation, RunEvent, RunId, TaskRun } from "../domain/task-run.js";

export interface ContinuationRecoveryItem {
  id: string;
  runId: RunId;
  ordinal: number;
}

export interface ClaimedContinuation {
  continuation: RunContinuation;
  run: TaskRun;
  event: RunEvent;
}

export interface ContinuationQueue {
  nextContinuationLeaseExpiry(): number | null;
  ownsContinuationLease(id: string, owner: string): boolean;
  recoverContinuationsAfterRestart(timestamp?: number): ContinuationRecoveryItem[];
  releaseContinuationLeases(owner: string, reason?: string): ContinuationRecoveryItem[];
  renewContinuationLease(id: string, owner: string, leaseMs: number): boolean;
  listContinuations(runId: RunId): RunContinuation[];
  queueContinuation(runId: RunId, reason: string): RunContinuation;
  claimContinuation(runId: RunId, owner: string, leaseMs: number): ClaimedContinuation | undefined;
  updateContinuation(id: string, status: RunContinuation["status"], error?: string, owner?: string): boolean;
  cancelQueuedContinuations(runId: RunId, reason: string): void;
}
