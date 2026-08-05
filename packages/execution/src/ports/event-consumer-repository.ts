import type { EventConsumerCursor, RunId } from "../domain/task-run.js";

export type EventConsumerAckStatus = "missing" | "stale" | "invalid" | "accepted";

export interface EventConsumerRepository {
  claimEventConsumer(runId: RunId, consumerId: string): EventConsumerCursor;
  getEventConsumer(runId: RunId, consumerId: string): EventConsumerCursor | undefined;
  ackEventConsumer(runId: RunId, consumerId: string, generation: number, seq: number): EventConsumerAckStatus;
}
