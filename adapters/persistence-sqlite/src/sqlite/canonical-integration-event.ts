import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { stableJson } from "@tagent/governance";

export const INTEGRATION_TOPIC = "learning.projection";
export const INTEGRATION_ENVELOPE_SCHEMA_VERSION = 1;

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value), "utf8").digest("hex");
}

export function canonicalPayloadHash(input: {
  topic: string; aggregateId: string; aggregateVersion: number; runEventRef: string | null;
  attemptId: string | null; ordinal: number; evidenceSnapshotJson: string; payload: unknown;
}): string {
  return canonicalSha256({
    schema_version: INTEGRATION_ENVELOPE_SCHEMA_VERSION,
    topic: input.topic, aggregate_id: input.aggregateId, aggregate_version: input.aggregateVersion,
    run_event_ref: input.runEventRef, attempt_id: input.attemptId, ordinal: input.ordinal,
    evidence_snapshot_json: input.evidenceSnapshotJson, payload: input.payload,
  });
}

export function canonicalIntegrationEventId(sourceEventId: string, topic: string, payloadHash: string): string {
  return `integration:${canonicalSha256({ source_event_id: sourceEventId, topic, payload_hash: payloadHash })}`;
}

export function reserveIntegrationSequence(db: Database.Database): number {
  const row = db.prepare("SELECT next_sequence as nextSequence FROM integration_stream_sequence WHERE id=1").get() as { nextSequence?: number } | undefined;
  const sequence = row?.nextSequence ?? 1;
  db.prepare("INSERT INTO integration_stream_sequence (id,next_sequence) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET next_sequence=excluded.next_sequence").run(sequence + 1);
  return sequence;
}

export interface AppendProjectionPairInput {
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

export interface ProjectionPairIdentity {
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
    throw new Error("Learning projection checkpoint requires an existing writer-fenced transaction");
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

interface LegacyProjectionIdentityRow extends ProjectionPairIdentity {
  runId: string;
  attemptOrdinal: number;
  attemptId: string | null;
  lifecycle: string;
  outcome: string;
  eventSeq: number;
  payloadJson: string;
  snapshotJson: string;
}

interface IntegrationProjectionIdentityRow extends ProjectionPairIdentity {
  topic: string;
  aggregateId: string;
  aggregateVersion: number;
  runEventRef: string | null;
  attemptId: string | null;
  attemptOrdinal: number | null;
  evidenceSnapshotJson: string;
  payloadJson: string;
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

function readAttemptEvidence(db: Database.Database, input: AppendProjectionPairInput): Record<string, unknown> {
  const row = db.prepare(`SELECT id,run_id as runId,ordinal,trigger,status,active,version,
    legacy_event_seq as legacyEventSeq,started_at as startedAt,updated_at as updatedAt,
    completed_at as completedAt,reconstruction_state as reconstructionState
    FROM attempts WHERE id=? AND run_id=? AND ordinal=?`).get(
    input.attemptId,
    input.runId,
    input.attemptOrdinal,
  ) as (Record<string, unknown> & { active: number }) | undefined;
  if (!row) throw new Error(`Learning projection Attempt ${input.attemptId} does not exist`);
  if (row.status !== input.outcome || Boolean(row.active) || Number(row.legacyEventSeq) !== input.eventSeq) {
    throw new Error(`Learning projection Attempt terminal state mismatch for ${input.attemptId}`);
  }
  return { ...row, active: Boolean(row.active) };
}

function readCheckpointEvidence(db: Database.Database, input: AppendProjectionPairInput): Record<string, unknown> {
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
  if (!row) throw new Error(`Learning projection checkpoint for ${input.runId} Attempt ${input.attemptOrdinal} does not exist`);
  if (row.attemptId !== input.attemptId) {
    throw new Error(`Learning projection checkpoint Attempt identity mismatch for ${input.runId}`);
  }
  if (row.active || row.lastEventSeq < input.eventSeq) {
    throw new Error(`Learning projection checkpoint is not finalized for ${input.runId}:${input.eventSeq}`);
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

function readRunEventEvidence(db: Database.Database, input: AppendProjectionPairInput): Record<string, unknown> {
  const row = db.prepare(`SELECT run_id as runId,seq,attempt_id as attemptId,type,data,
    created_at as createdAt FROM run_events WHERE run_id=? AND seq=?`).get(input.runId, input.eventSeq) as {
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

function assertTaskRunSnapshot(input: AppendProjectionPairInput): void {
  if (input.taskRunSnapshot.id !== input.runId
    || Number(input.taskRunSnapshot.attempt) !== input.attemptOrdinal
    || input.taskRunSnapshot.status !== input.outcome) {
    throw new Error(`Learning projection TaskRun snapshot mismatch for ${input.runId}`);
  }
}

function readExistingPair(
  db: Database.Database,
  input: AppendProjectionPairInput,
  expected: Omit<ProjectionPairIdentity, "outboxSequence"> & {
    payloadJson: string;
    snapshotJson: string;
    evidenceSnapshotJson: string;
  },
): ProjectionPairIdentity | undefined {
  const legacyRows = db.prepare(`SELECT outbox_sequence as outboxSequence,'' as eventId,
    source_event_id as sourceEventId,payload_hash as payloadHash,run_id as runId,
    attempt as attemptOrdinal,attempt_id as attemptId,lifecycle,outcome,event_seq as eventSeq,
    payload_json as payloadJson,snapshot_json as snapshotJson
    FROM learning_projection_outbox
    WHERE source_event_id=? OR (run_id=? AND attempt=? AND lifecycle=? AND event_seq=?)`).all(
    expected.sourceEventId,
    input.runId,
    input.attemptOrdinal,
    input.lifecycle,
    input.eventSeq,
  ) as LegacyProjectionIdentityRow[];
  const integrationRows = db.prepare(`SELECT outbox_sequence as outboxSequence,event_id as eventId,
    source_event_id as sourceEventId,payload_hash as payloadHash,topic,aggregate_id as aggregateId,
    aggregate_version as aggregateVersion,run_event_ref as runEventRef,attempt_id as attemptId,
    attempt_ordinal as attemptOrdinal,evidence_snapshot_json as evidenceSnapshotJson,
    payload_json as payloadJson FROM integration_outbox WHERE source_event_id=? OR event_id=?`).all(
    expected.sourceEventId,
    expected.eventId,
  ) as IntegrationProjectionIdentityRow[];
  if (legacyRows.length === 0 && integrationRows.length === 0) return undefined;
  if (legacyRows.length !== 1 || integrationRows.length !== 1) {
    throw new Error(`Learning projection pair is partial or ambiguous for ${expected.sourceEventId}`);
  }
  const legacy = legacyRows[0]!;
  const integration = integrationRows[0]!;
  const matches = legacy.outboxSequence === integration.outboxSequence
    && legacy.sourceEventId === expected.sourceEventId
    && integration.sourceEventId === expected.sourceEventId
    && integration.eventId === expected.eventId
    && legacy.payloadHash === expected.payloadHash
    && integration.payloadHash === expected.payloadHash
    && legacy.runId === input.runId
    && legacy.attemptOrdinal === input.attemptOrdinal
    && legacy.attemptId === input.attemptId
    && legacy.lifecycle === input.lifecycle
    && legacy.outcome === input.outcome
    && legacy.eventSeq === input.eventSeq
    && legacy.payloadJson === expected.payloadJson
    && integration.payloadJson === expected.payloadJson
    && legacy.snapshotJson === expected.snapshotJson
    && integration.topic === INTEGRATION_TOPIC
    && integration.aggregateId === input.runId
    && integration.aggregateVersion === input.eventSeq
    && integration.runEventRef === expected.sourceEventId
    && integration.attemptId === input.attemptId
    && integration.attemptOrdinal === input.attemptOrdinal
    && integration.evidenceSnapshotJson === expected.evidenceSnapshotJson;
  if (!matches) throw new Error(`Learning projection identity/hash conflict for ${expected.sourceEventId}`);
  return {
    outboxSequence: legacy.outboxSequence,
    eventId: integration.eventId,
    sourceEventId: expected.sourceEventId,
    payloadHash: expected.payloadHash,
  };
}

/**
 * Appends the legacy and canonical Learning projection rows as one immutable pair.
 * Callers must persist the bound RunEvent and all authoritative side projections first.
 */
export function appendProjectionPair(
  db: Database.Database,
  input: AppendProjectionPairInput,
): ProjectionPairIdentity {
  if (!db.inTransaction) {
    throw new Error("Learning projection pair requires an existing writer-fenced transaction");
  }
  if (!Number.isSafeInteger(input.eventSeq) || input.eventSeq <= 0) {
    throw new TypeError("New Learning projections require a positive eventSeq");
  }
  assertTaskRunSnapshot(input);
  const attempt = readAttemptEvidence(db, input);
  const checkpoint = readCheckpointEvidence(db, input);
  const runEventRef = readRunEventEvidence(db, input);
  const payloadJson = stableJson(input.payload);
  const snapshotJson = stableJson(input.taskRunSnapshot);
  const evidenceSnapshotJson = stableJson({
    taskRun: input.taskRunSnapshot,
    attempt,
    checkpoint,
    runEventRef,
  });
  const sourceEventId = `run:${input.runId}:event:${input.eventSeq}`;
  const payloadHash = canonicalPayloadHash({
    topic: INTEGRATION_TOPIC,
    aggregateId: input.runId,
    aggregateVersion: input.eventSeq,
    runEventRef: sourceEventId,
    attemptId: input.attemptId,
    ordinal: input.attemptOrdinal,
    evidenceSnapshotJson,
    payload: input.payload,
  });
  const eventId = canonicalIntegrationEventId(sourceEventId, INTEGRATION_TOPIC, payloadHash);
  const existing = readExistingPair(db, input, {
    eventId,
    sourceEventId,
    payloadHash,
    payloadJson,
    snapshotJson,
    evidenceSnapshotJson,
  });
  if (existing) return existing;

  const outboxSequence = reserveIntegrationSequence(db);
  db.prepare(`INSERT INTO learning_projection_outbox
    (id,run_id,attempt,attempt_id,lifecycle,outcome,event_seq,payload_json,snapshot_json,
     status,created_at,updated_at,outbox_sequence,source_event_id,payload_hash)
    VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?)`).run(
    randomUUID(),
    input.runId,
    input.attemptOrdinal,
    input.attemptId,
    input.lifecycle,
    input.outcome,
    input.eventSeq,
    payloadJson,
    snapshotJson,
    input.timestamp,
    input.timestamp,
    outboxSequence,
    sourceEventId,
    payloadHash,
  );
  db.prepare(`INSERT INTO integration_outbox
    (outbox_sequence,event_id,source_event_id,topic,aggregate_id,aggregate_version,run_event_ref,
     attempt_id,attempt_ordinal,evidence_snapshot_json,payload_hash,payload_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    outboxSequence,
    eventId,
    sourceEventId,
    INTEGRATION_TOPIC,
    input.runId,
    input.eventSeq,
    sourceEventId,
    input.attemptId,
    input.attemptOrdinal,
    evidenceSnapshotJson,
    payloadHash,
    payloadJson,
    input.timestamp,
  );
  return { outboxSequence, eventId, sourceEventId, payloadHash };
}
