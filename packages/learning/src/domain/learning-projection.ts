import { createHash } from "node:crypto";
import { stableJson } from "@tagent/governance";

export const LEARNING_PROJECTION_CONSUMER = "learning-projection-v1" as const;
export type LearningProjectionConsumer = typeof LEARNING_PROJECTION_CONSUMER;

export interface IntegrationLearningProjectionRecord {
  outboxSequence: number;
  sourceEventId: string;
  payloadHash: string;
  aggregateId: string;
  aggregateVersion: number;
  runEventRef: string | null;
  attemptId: string;
  attemptOrdinal: number;
  payloadJson: string;
  evidenceSnapshotJson: string;
}

export interface DecodedLearningProjection {
  runId: string;
  attemptOrdinal: number;
  eventSeq: number;
  lifecycle: string;
  outcome: string;
  payload: Record<string, unknown>;
  taskRunSnapshot: Record<string, unknown>;
}

export interface LearningProjectionDeliveryFence {
  outboxSequence: number;
  consumer: LearningProjectionConsumer;
  leaseGeneration: number;
  leaseOwner: string;
  leaseToken: string;
  sourceEventId: string;
}

export interface LearningProjectionDeliveryClaim {
  fence: LearningProjectionDeliveryFence;
  integration: IntegrationLearningProjectionRecord;
}

export interface LearningProjectionCheckpoint {
  consumer: LearningProjectionConsumer;
  watermark: number;
  generation: number;
  updatedAt: number;
}

export interface LearningEffectReceipt {
  logicalConsumer: LearningProjectionConsumer;
  sourceEventId: string;
  effectHash: string;
  committedAt: number;
}

function parseObject(value: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError(`${field} must be valid JSON`, { cause: error });
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new TypeError(`${field} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function decodeIntegrationLearningProjection(
  record: IntegrationLearningProjectionRecord,
): DecodedLearningProjection {
  const evidence = parseObject(record.evidenceSnapshotJson, "integration evidence_snapshot_json");
  const taskRunSnapshot = evidence.taskRun;
  const runEvent = evidence.runEventRef;
  if (!taskRunSnapshot || Array.isArray(taskRunSnapshot) || typeof taskRunSnapshot !== "object") {
    throw new TypeError("integration evidence taskRun must be an object");
  }
  if (!runEvent || Array.isArray(runEvent) || typeof runEvent !== "object"
    || typeof (runEvent as Record<string, unknown>).type !== "string") {
    throw new TypeError("integration evidence runEventRef.type is required");
  }
  const lifecycle = (runEvent as Record<string, unknown>).type as string;
  const outcome = (taskRunSnapshot as Record<string, unknown>).status;
  if (typeof outcome !== "string" || !outcome) {
    throw new TypeError("integration evidence taskRun.status is required");
  }
  return {
    runId: record.aggregateId,
    attemptOrdinal: record.attemptOrdinal,
    eventSeq: record.aggregateVersion,
    lifecycle: lifecycle === "run.waiting_for_input" ? "run.waiting_input" : lifecycle,
    outcome,
    payload: parseObject(record.payloadJson, "integration payload_json"),
    taskRunSnapshot: taskRunSnapshot as Record<string, unknown>,
  };
}

const VOLATILE_KEY = /(^id$|(?:^|_)?(?:id|uuid)$|Id$|Uuid$|(?:At|_at)$|timestamp|^now$|policy)/i;

function stableProjectionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableProjectionValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !VOLATILE_KEY.test(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stableProjectionValue(child)]));
}

export function canonicalLearningProjectionDigest(projection: DecodedLearningProjection): string {
  return createHash("sha256").update(stableJson({
    run_id: projection.runId,
    attempt_ordinal: projection.attemptOrdinal,
    event_seq: projection.eventSeq,
    lifecycle: projection.lifecycle,
    outcome: projection.outcome,
    payload: stableProjectionValue(projection.payload),
    task_run: stableProjectionValue(projection.taskRunSnapshot),
  })).digest("hex");
}
