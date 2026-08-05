import type { RunId } from "@tagent/execution/domain";

export interface LearningProjectionJob {
  id: string;
  runId: RunId;
  attempt: number;
  lifecycle: string;
  outcome: string;
  eventSeq: number;
  payloadJson: string;
  snapshotJson: string;
  status: string;
  error: string;
  createdAt: number;
  updatedAt: number;
}

export interface LearningProjectionQueue {
  listPendingLearningProjections(limit?: number): LearningProjectionJob[];
  completeLearningProjection(id: string): void;
  failLearningProjection(id: string, error: string): void;
}
