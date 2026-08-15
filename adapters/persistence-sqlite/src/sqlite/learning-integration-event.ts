import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { stableJson } from "@tagent/governance";

const LEARNING_INTEGRATION_TOPIC = "learning.projection";
const LEARNING_INTEGRATION_SCHEMA_VERSION = 1;

function sha256(value: unknown): string {
  return createHash("sha256")
    .update(typeof value === "string" ? value : stableJson(value), "utf8")
    .digest("hex");
}

function payloadHash(input: {
  aggregateId: string;
  aggregateVersion: number;
  runEventRef: string;
  attemptId: string;
  ordinal: number;
  evidenceSnapshotJson: string;
  payload: Record<string, unknown>;
}): string {
  return sha256({
    schema_version: LEARNING_INTEGRATION_SCHEMA_VERSION,
    topic: LEARNING_INTEGRATION_TOPIC,
    aggregate_id: input.aggregateId,
    aggregate_version: input.aggregateVersion,
    run_event_ref: input.runEventRef,
    attempt_id: input.attemptId,
    ordinal: input.ordinal,
    evidence_snapshot_json: input.evidenceSnapshotJson,
    payload: input.payload,
  });
}

function integrationEventId(sourceEventId: string, hash: string): string {
  return `integration:${sha256({
    source_event_id: sourceEventId,
    topic: LEARNING_INTEGRATION_TOPIC,
    payload_hash: hash,
  })}`;
}

function reserveSequence(db: Database.Database): number {
  const row = db.prepare(
    "SELECT next_sequence as nextSequence FROM integration_stream_sequence WHERE id=1",
  ).get() as { nextSequence?: number } | undefined;
  const sequence = row?.nextSequence ?? 1;
  db.prepare(`INSERT INTO integration_stream_sequence (id,next_sequence) VALUES (1,?)
    ON CONFLICT(id) DO UPDATE SET next_sequence=excluded.next_sequence`).run(sequence + 1);
  return sequence;
}

export interface AppendLearningProjectionInput {
  runId: string;
  attemptId: string;
  attemptOrdinal: number;
  lifecycle: string;
  outcome: string;
  eventSeq: number;
  payload: Record<string, unknown>;
  taskRunSnapshot: Record<string, unknown>;
  timestamp: number;
  runEventType: string;
}

export interface LearningProjectionIdentity {
  outboxSequence: number;
  eventId: string;
  sourceEventId: string;
  payloadHash: string;
}

export interface FinalizeProjectionCheckpointInput {
  runId: string;
  attemptId: string;
  attemptOrdinal: number;
  eventSeq: number;
  timestamp: number;
}

export function finalizeProjectionCheckpoint(
  db: Database.Database,
  input: FinalizeProjectionCheckpointInput,
): void {
  if (!db.inTransaction) {
    throw new Error("Learning projection checkpoint requires a writer-fenced transaction");
  }
  const result = db.prepare(`INSERT INTO run_checkpoints
    (run_id,attempt,attempt_id,active,assistant_partial,current_tool_json,last_event_seq,
     last_transcript_seq,updated_at)
    VALUES (?,?,?,0,'','',?,COALESCE((SELECT MAX(seq) FROM run_transcript WHERE run_id=?),0),?)
    ON CONFLICT(run_id) DO UPDATE SET
      attempt=excluded.attempt,
      attempt_id=excluded.attempt_id,
      active=0,
      assistant_partial='',
      current_tool_json='',
      last_event_seq=MAX(run_checkpoints.last_event_seq,excluded.last_event_seq),
      last_transcript_seq=MAX(run_checkpoints.last_transcript_seq,excluded.last_transcript_seq),
      updated_at=excluded.updated_at
    WHERE excluded.attempt>=run_checkpoints.attempt`).run(
    input.runId,
    input.attemptOrdinal,
    input.attemptId,
    input.eventSeq,
    input.runId,
    input.timestamp,
  );
  if (result.changes !== 1) {
    throw new Error(`TaskRun checkpoint changed during Learning projection for ${input.attemptId}`);
  }
}

function parseJsonObject(value: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError(`${field} is not valid JSON`, { cause: error });
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new TypeError(`${field} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function readAttemptEvidence(
  db: Database.Database,
  input: AppendLearningProjectionInput,
): Record<string, unknown> {
  const row = db.prepare(`SELECT id,run_id as runId,ordinal,trigger,status,active,version,
    event_sequence as eventSequence,started_at as startedAt,updated_at as updatedAt,
    completed_at as completedAt
    FROM attempts WHERE id=? AND run_id=? AND ordinal=?`).get(
    input.attemptId,
    input.runId,
    input.attemptOrdinal,
  ) as (Record<string, unknown> & { active: number }) | undefined;
  if (!row) throw new Error(`Learning projection Attempt ${input.attemptId} does not exist`);
  if (row.status !== input.outcome || Boolean(row.active)
    || Number(row.eventSequence) !== input.eventSeq) {
    throw new Error(`Learning projection Attempt terminal state mismatch for ${input.attemptId}`);
  }
  return { ...row, active: Boolean(row.active) };
}

function readCheckpointEvidence(
  db: Database.Database,
  input: AppendLearningProjectionInput,
): Record<string, unknown> {
  const row = db.prepare(`SELECT run_id as runId,attempt,attempt_id as attemptId,active,
    assistant_partial as assistantPartial,current_tool_json as currentToolJson,
    last_event_seq as lastEventSeq,last_transcript_seq as lastTranscriptSeq,updated_at as updatedAt
    FROM run_checkpoints WHERE run_id=? AND attempt=?`).get(input.runId, input.attemptOrdinal) as {
      runId: string;
      attempt: number;
      attemptId: string | null;
      active: number;
      assistantPartial: string;
      currentToolJson: string;
      lastEventSeq: number;
      lastTranscriptSeq: number;
      updatedAt: number;
    } | undefined;
  if (!row) {
    throw new Error(
      `Learning projection checkpoint for ${input.runId} Attempt ${input.attemptOrdinal} does not exist`,
    );
  }
  if (row.attemptId !== input.attemptId || row.active || row.lastEventSeq < input.eventSeq) {
    throw new Error(`Learning projection checkpoint mismatch for ${input.runId}`);
  }
  const live = {
    runId: row.runId,
    attempt: row.attempt,
    attemptId: row.attemptId,
    active: Boolean(row.active),
    assistantPartial: row.assistantPartial,
    currentTool: row.currentToolJson
      ? parseJsonObject(row.currentToolJson, "run_checkpoints.current_tool_json")
      : null,
    lastEventSeq: row.lastEventSeq,
    lastTranscriptSeq: row.lastTranscriptSeq,
    updatedAt: row.updatedAt,
  };
  const embeddedValue = input.taskRunSnapshot.checkpoint;
  if (embeddedValue === null || embeddedValue === undefined) return live;
  if (Array.isArray(embeddedValue) || typeof embeddedValue !== "object") {
    throw new TypeError("taskRunSnapshot.checkpoint must be an object or null");
  }
  const embedded = embeddedValue as Record<string, unknown>;
  if (embedded.runId !== input.runId
    || Number(embedded.attempt) !== input.attemptOrdinal
    || Boolean(embedded.active)
    || Number(embedded.lastEventSeq) < input.eventSeq
    || Number(embedded.lastEventSeq) > row.lastEventSeq
    || embedded.attemptId !== undefined && embedded.attemptId !== input.attemptId) {
    throw new Error(`Learning projection embedded checkpoint mismatch for ${input.runId}`);
  }
  return embedded;
}

function readRunEventEvidence(
  db: Database.Database,
  input: AppendLearningProjectionInput,
): Record<string, unknown> {
  const row = db.prepare(`SELECT run_id as runId,seq,attempt_id as attemptId,type,data,
    created_at as createdAt FROM run_events WHERE run_id=? AND seq=?`).get(
    input.runId,
    input.eventSeq,
  ) as {
      runId: string;
      seq: number;
      attemptId: string | null;
      type: string;
      data: string;
      createdAt: number;
    } | undefined;
  if (!row) throw new Error(`Learning projection run event ${input.runId}:${input.eventSeq} does not exist`);
  if (row.attemptId !== input.attemptId || row.type !== input.runEventType) {
    throw new Error(`Learning projection run event binding mismatch for ${input.runId}:${input.eventSeq}`);
  }
  return {
    ...row,
    data: parseJsonObject(row.data, `run_events:${input.runId}:${input.eventSeq}.data`),
  };
}

function assertTaskRunSnapshot(input: AppendLearningProjectionInput): void {
  if (input.taskRunSnapshot.id !== input.runId
    || Number(input.taskRunSnapshot.attempt) !== input.attemptOrdinal
    || input.taskRunSnapshot.status !== input.outcome) {
    throw new Error(`Learning projection TaskRun snapshot mismatch for ${input.runId}`);
  }
}

function readExistingProjection(
  db: Database.Database,
  input: AppendLearningProjectionInput,
  expected: Omit<LearningProjectionIdentity, "outboxSequence"> & {
    payloadJson: string;
    evidenceSnapshotJson: string;
  },
): LearningProjectionIdentity | undefined {
  const rows = db.prepare(`SELECT outbox_sequence as outboxSequence,event_id as eventId,
    source_event_id as sourceEventId,payload_hash as payloadHash,topic,
    aggregate_id as aggregateId,aggregate_version as aggregateVersion,
    run_event_ref as runEventRef,attempt_id as attemptId,attempt_ordinal as attemptOrdinal,
    evidence_snapshot_json as evidenceSnapshotJson,payload_json as payloadJson
    FROM integration_outbox WHERE source_event_id=? OR event_id=?`).all(
    expected.sourceEventId,
    expected.eventId,
  ) as Array<LearningProjectionIdentity & {
      topic: string;
      aggregateId: string;
      aggregateVersion: number;
      runEventRef: string | null;
      attemptId: string | null;
      attemptOrdinal: number | null;
      evidenceSnapshotJson: string;
      payloadJson: string;
    }>;
  if (rows.length === 0) return undefined;
  if (rows.length !== 1) {
    throw new Error(`Learning projection identity is ambiguous for ${expected.sourceEventId}`);
  }
  const row = rows[0]!;
  const matches = row.eventId === expected.eventId
    && row.sourceEventId === expected.sourceEventId
    && row.payloadHash === expected.payloadHash
    && row.topic === LEARNING_INTEGRATION_TOPIC
    && row.aggregateId === input.runId
    && row.aggregateVersion === input.eventSeq
    && row.runEventRef === expected.sourceEventId
    && row.attemptId === input.attemptId
    && row.attemptOrdinal === input.attemptOrdinal
    && row.evidenceSnapshotJson === expected.evidenceSnapshotJson
    && row.payloadJson === expected.payloadJson;
  if (!matches) throw new Error(`Learning projection identity/hash conflict for ${expected.sourceEventId}`);
  return {
    outboxSequence: row.outboxSequence,
    eventId: row.eventId,
    sourceEventId: row.sourceEventId,
    payloadHash: row.payloadHash,
  };
}

/** Appends one immutable Learning event after its RunEvent and terminal snapshots are durable. */
export function appendLearningProjection(
  db: Database.Database,
  input: AppendLearningProjectionInput,
): LearningProjectionIdentity {
  if (!db.inTransaction) {
    throw new Error("Learning projection append requires a writer-fenced transaction");
  }
  if (!Number.isSafeInteger(input.eventSeq) || input.eventSeq <= 0) {
    throw new TypeError("Learning projections require a positive eventSeq");
  }
  assertTaskRunSnapshot(input);
  const attempt = readAttemptEvidence(db, input);
  const checkpoint = readCheckpointEvidence(db, input);
  const runEventRef = readRunEventEvidence(db, input);
  const payloadJson = stableJson(input.payload);
  const evidenceSnapshotJson = stableJson({
    taskRun: input.taskRunSnapshot,
    attempt,
    checkpoint,
    runEventRef,
  });
  const sourceEventId = `run:${input.runId}:event:${input.eventSeq}`;
  const hash = payloadHash({
    aggregateId: input.runId,
    aggregateVersion: input.eventSeq,
    runEventRef: sourceEventId,
    attemptId: input.attemptId,
    ordinal: input.attemptOrdinal,
    evidenceSnapshotJson,
    payload: input.payload,
  });
  const eventId = integrationEventId(sourceEventId, hash);
  const existing = readExistingProjection(db, input, {
    eventId,
    sourceEventId,
    payloadHash: hash,
    payloadJson,
    evidenceSnapshotJson,
  });
  if (existing) return existing;

  const outboxSequence = reserveSequence(db);
  db.prepare(`INSERT INTO integration_outbox
    (outbox_sequence,event_id,source_event_id,topic,aggregate_id,aggregate_version,run_event_ref,
     attempt_id,attempt_ordinal,evidence_snapshot_json,payload_hash,payload_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    outboxSequence,
    eventId,
    sourceEventId,
    LEARNING_INTEGRATION_TOPIC,
    input.runId,
    input.eventSeq,
    sourceEventId,
    input.attemptId,
    input.attemptOrdinal,
    evidenceSnapshotJson,
    hash,
    payloadJson,
    input.timestamp,
  );
  return { outboxSequence, eventId, sourceEventId, payloadHash: hash };
}
