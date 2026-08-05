import type Database from "better-sqlite3";
import { stableJson } from "@tagent/governance";
import {
  canonicalIntegrationEventId,
  canonicalPayloadHash,
  canonicalSha256,
  INTEGRATION_TOPIC,
} from "../sqlite/canonical-integration-event.js";

const MIGRATION_VERSION = 33;

export const LEARNING_INTEGRATION_ISSUES_V33_SQL = `
  CREATE TABLE IF NOT EXISTS migration_issues (
    migration_version INTEGER NOT NULL,
    issue_key TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    code TEXT NOT NULL,
    details_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('open','resolved')),
    detected_at INTEGER NOT NULL,
    resolved_at INTEGER,
    PRIMARY KEY(migration_version,issue_key)
  );
`;

const LEGACY_OUTBOX_V33_TABLE_SQL = `
  CREATE TABLE learning_projection_outbox (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    attempt INTEGER NOT NULL,
    lifecycle TEXT NOT NULL,
    outcome TEXT NOT NULL,
    event_seq INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL DEFAULT '{}',
    snapshot_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','processing','completed','failed')),
    error TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    attempt_id TEXT,
    outbox_sequence INTEGER NOT NULL UNIQUE,
    source_event_id TEXT NOT NULL UNIQUE,
    payload_hash TEXT NOT NULL,
    UNIQUE(run_id, attempt, lifecycle, event_seq)
  )
`;

const LEGACY_OUTBOX_V33_INDEX_SQL = `CREATE INDEX idx_learning_projection_pending
  ON learning_projection_outbox(status, created_at)`;

export const LEARNING_INTEGRATION_SCHEMA_V33_SQL = `
  CREATE TABLE IF NOT EXISTS integration_stream_sequence (
    id INTEGER PRIMARY KEY CHECK(id=1),
    next_sequence INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS integration_outbox (
    outbox_sequence INTEGER PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    source_event_id TEXT NOT NULL UNIQUE,
    topic TEXT NOT NULL,
    aggregate_id TEXT NOT NULL,
    aggregate_version INTEGER NOT NULL,
    run_event_ref TEXT,
    attempt_id TEXT,
    attempt_ordinal INTEGER,
    evidence_snapshot_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS integration_consumer_delivery (
    outbox_sequence INTEGER NOT NULL REFERENCES integration_outbox(outbox_sequence),
    consumer TEXT NOT NULL,
    lease_generation INTEGER NOT NULL,
    lease_owner TEXT,
    lease_token TEXT,
    lease_source TEXT NOT NULL CHECK(lease_source IN ('legacy','integration','shadow')),
    authority_generation INTEGER NOT NULL,
    authority_token TEXT,
    lease_until INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    acked_at INTEGER,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','leased','acked','failed')),
    PRIMARY KEY(outbox_sequence,consumer)
  );
  CREATE TABLE IF NOT EXISTS learning_projection_checkpoint (
    consumer TEXT NOT NULL,
    delivery_role TEXT NOT NULL CHECK(delivery_role IN ('legacy','integration','shadow')),
    watermark INTEGER NOT NULL DEFAULT 0,
    generation INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(consumer,delivery_role)
  );
  CREATE TABLE IF NOT EXISTS learning_projection_authority_state (
    id INTEGER PRIMARY KEY CHECK(id=1),
    active_source TEXT NOT NULL CHECK(active_source IN ('legacy','integration')),
    generation INTEGER NOT NULL,
    owner TEXT,
    token TEXT,
    lease_until INTEGER,
    switch_watermark INTEGER NOT NULL DEFAULT 0,
    legacy_last_acked INTEGER NOT NULL DEFAULT 0,
    legacy_resume_position INTEGER NOT NULL DEFAULT 1,
    integration_checkpoint INTEGER NOT NULL DEFAULT 0,
    rollback_checkpoint INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL
      CHECK(status IN ('legacy_active','switching','integration_active','rollback'))
  );
  CREATE TABLE IF NOT EXISTS integration_reconciliation (
    source_event_id TEXT PRIMARY KEY,
    outbox_sequence INTEGER,
    legacy_hash TEXT,
    integration_hash TEXT,
    legacy_snapshot_hash TEXT,
    integration_snapshot_hash TEXT,
    legacy_digest TEXT,
    integration_digest TEXT,
    status TEXT NOT NULL
      CHECK(status IN ('match','missing','hash_mismatch','snapshot_mismatch','digest_mismatch','blocker')),
    checked_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS effect_receipts (
    logical_consumer TEXT NOT NULL,
    source_event_id TEXT NOT NULL,
    effect_hash TEXT NOT NULL,
    committed_at INTEGER NOT NULL,
    PRIMARY KEY(logical_consumer,source_event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_integration_outbox_topic
    ON integration_outbox(topic,created_at,outbox_sequence);
  CREATE INDEX IF NOT EXISTS idx_integration_consumer_delivery_claim
    ON integration_consumer_delivery(consumer,status,lease_until,outbox_sequence);
  CREATE INDEX IF NOT EXISTS idx_learning_projection_checkpoint_watermark
    ON learning_projection_checkpoint(delivery_role,watermark);
  CREATE INDEX IF NOT EXISTS idx_integration_reconciliation_status
    ON integration_reconciliation(status,source_event_id);
  CREATE TRIGGER IF NOT EXISTS integration_outbox_immutable_update
    BEFORE UPDATE ON integration_outbox
    BEGIN
      SELECT RAISE(ABORT, 'integration_outbox is immutable');
    END;
  CREATE TRIGGER IF NOT EXISTS integration_outbox_immutable_delete
    BEFORE DELETE ON integration_outbox
    BEGIN
      SELECT RAISE(ABORT, 'integration_outbox is immutable');
    END;
  CREATE TRIGGER IF NOT EXISTS learning_projection_outbox_identity_immutable
    BEFORE UPDATE OF outbox_sequence, source_event_id, payload_hash ON learning_projection_outbox
    BEGIN
      SELECT RAISE(ABORT, 'learning_projection_outbox integration identity is immutable');
    END;
`;

interface LegacyOutboxRow {
  id: string;
  runId: string;
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
  attemptId: string | null;
  outboxSequence?: number | null;
  sourceEventId?: string | null;
  payloadHash?: string | null;
}

interface CanonicalOutboxRow {
  legacy: LegacyOutboxRow;
  outboxSequence: number;
  eventId: string;
  sourceEventId: string;
  topic: string;
  aggregateId: string;
  aggregateVersion: number;
  runEventRef: string | null;
  attemptId: string | null;
  attemptOrdinal: number;
  evidenceSnapshotJson: string;
  payloadHash: string;
  payloadJson: string;
  createdAt: number;
  stableInputHash: string;
}

interface MigrationIssue {
  code: string;
  sourceRef: string;
  details: Record<string, unknown>;
}

interface SchemaObjectRow {
  type: string;
  tableName: string;
  sql: string | null;
}

const V33_LEGACY_COLUMNS = ["outbox_sequence", "source_event_id", "payload_hash"] as const;

function fail(message: string): never {
  throw new Error(`Learning integration v33 ${message}`);
}

const sha256 = canonicalSha256;

function normalizeDdl(source: string): string {
  return source
    .toLowerCase()
    .replace(/\bif\s+not\s+exists\b/g, "")
    .replace(/["`]/g, "")
    .replace(/\[([^\]]+)]/g, "$1")
    .replace(/;/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),=<>])\s*/g, "$1")
    .trim();
}

function schemaObject(db: Database.Database, name: string): SchemaObjectRow | undefined {
  return db.prepare("SELECT type,tbl_name as tableName,sql FROM main.sqlite_master WHERE name=?")
    .get(name) as SchemaObjectRow | undefined;
}

function assertSqlObject(
  db: Database.Database,
  expected: { name: string; type: "table" | "index" | "trigger"; table: string; sql: string },
): void {
  const actual = schemaObject(db, expected.name);
  if (!actual?.sql
    || actual.type !== expected.type
    || actual.tableName !== expected.table
    || normalizeDdl(actual.sql) !== normalizeDdl(expected.sql)) {
    fail(`schema has incompatible ${expected.type} ${expected.name}`);
  }
}

function parseJsonObject(value: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError(`${field} is not valid JSON`, { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`${field} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function tableColumns(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>)
    .map((column) => column.name));
}

function hasEveryColumn(db: Database.Database, table: string, columns: readonly string[]): boolean {
  const names = tableColumns(db, table);
  return columns.every((column) => names.has(column));
}

function legacyRows(db: Database.Database): LegacyOutboxRow[] {
  const hasV33Columns = hasEveryColumn(db, "learning_projection_outbox", V33_LEGACY_COLUMNS);
  return db.prepare(`SELECT id,run_id as runId,attempt,lifecycle,outcome,event_seq as eventSeq,
    payload_json as payloadJson,snapshot_json as snapshotJson,status,error,created_at as createdAt,
    updated_at as updatedAt,attempt_id as attemptId,
    ${hasV33Columns ? "outbox_sequence" : "NULL"} as outboxSequence,
    ${hasV33Columns ? "source_event_id" : "NULL"} as sourceEventId,
    ${hasV33Columns ? "payload_hash" : "NULL"} as payloadHash
    FROM learning_projection_outbox`).all() as LegacyOutboxRow[];
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedLegacyRows<T extends LegacyOutboxRow & { stableInputHash: string }>(rows: T[]): T[] {
  return rows.sort((left, right) => left.createdAt - right.createdAt
    || compareText(left.runId, right.runId)
    || left.attempt - right.attempt
    || left.eventSeq - right.eventSeq
    || compareText(left.lifecycle, right.lifecycle)
    || compareText(left.id, right.id)
    || compareText(left.stableInputHash, right.stableInputHash));
}

function readAttemptSnapshot(db: Database.Database, row: LegacyOutboxRow): Record<string, unknown> | null {
  const attempt = db.prepare(`SELECT id,run_id as runId,ordinal,trigger,status,active,version,
    legacy_event_seq as legacyEventSeq,started_at as startedAt,updated_at as updatedAt,
    completed_at as completedAt,reconstruction_state as reconstructionState
    FROM attempts WHERE id=? AND run_id=? AND ordinal=?`).get(
    row.attemptId ?? `attempt:${row.runId}:${row.attempt}`,
    row.runId,
    row.attempt,
  ) as (Record<string, unknown> & { active: number }) | undefined;
  return attempt ? { ...attempt, active: Boolean(attempt.active) } : null;
}

function readCheckpointSnapshot(
  db: Database.Database,
  row: LegacyOutboxRow,
  taskRunSnapshot: Record<string, unknown>,
): Record<string, unknown> | null {
  const embeddedValue = taskRunSnapshot.checkpoint;
  if (embeddedValue !== undefined && embeddedValue !== null
    && (typeof embeddedValue !== "object" || Array.isArray(embeddedValue))) {
    throw new TypeError("snapshot_json.checkpoint must be an object or null");
  }
  const embedded = embeddedValue && typeof embeddedValue === "object"
    ? embeddedValue as Record<string, unknown>
    : null;
  if (embedded && (embedded.runId !== row.runId || Number(embedded.attempt) !== row.attempt)) {
    throw new TypeError("snapshot_json.checkpoint does not match the legacy Attempt");
  }
  const live = db.prepare(`SELECT run_id as runId,attempt,attempt_id as attemptId,active,
    assistant_partial as assistantPartial,current_tool_json as currentToolJson,
    last_event_seq as lastEventSeq,last_transcript_seq as lastTranscriptSeq,updated_at as updatedAt
    FROM run_checkpoints WHERE run_id=?`).get(row.runId) as {
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
  const liveSnapshot = live && live.attempt === row.attempt
    ? {
      runId: live.runId,
      attempt: live.attempt,
      attemptId: live.attemptId,
      active: Boolean(live.active),
      assistantPartial: live.assistantPartial,
      currentTool: live.currentToolJson ? parseJsonObject(live.currentToolJson, "run_checkpoints.current_tool_json") : null,
      lastEventSeq: live.lastEventSeq,
      lastTranscriptSeq: live.lastTranscriptSeq,
      updatedAt: live.updatedAt,
    }
    : null;
  if (embedded && liveSnapshot) {
    const embeddedAttemptId = embedded.attemptId ?? null;
    const embeddedLastEventSeq = Number(embedded.lastEventSeq ?? 0);
    if (embedded.runId !== liveSnapshot.runId
      || Number(embedded.attempt) !== liveSnapshot.attempt
      || embeddedAttemptId !== null && embeddedAttemptId !== liveSnapshot.attemptId
      || !Number.isSafeInteger(embeddedLastEventSeq)
      || embeddedLastEventSeq < 0
      || embeddedLastEventSeq > liveSnapshot.lastEventSeq) {
      throw new TypeError("snapshot_json.checkpoint conflicts with the live same-Attempt checkpoint");
    }
  }
  return embedded ?? liveSnapshot;
}

function readRunEventSnapshot(db: Database.Database, row: LegacyOutboxRow): Record<string, unknown> | null {
  if (row.eventSeq === 0) return null;
  const event = db.prepare(`SELECT run_id as runId,seq,attempt_id as attemptId,type,data,
    created_at as createdAt FROM run_events WHERE run_id=? AND seq=?`).get(row.runId, row.eventSeq) as
    | { runId: string; seq: number; attemptId: string | null; type: string; data: string; createdAt: number }
    | undefined;
  if (!event) return null;
  return { ...event, data: parseJsonObject(event.data, `run_events:${row.runId}:${row.eventSeq}.data`) };
}

function deriveCanonicalRows(
  db: Database.Database,
  previousVersion: number,
): { rows: CanonicalOutboxRow[]; issues: MigrationIssue[] } {
  const issues: MigrationIssue[] = [];
  const prepared: Array<LegacyOutboxRow & {
    payload: Record<string, unknown>;
    snapshot: Record<string, unknown>;
    stableInputHash: string;
  }> = [];
  for (const row of legacyRows(db)) {
    const sourceRef = `learning_projection_outbox:${row.id}`;
    let payload: Record<string, unknown>;
    let snapshot: Record<string, unknown>;
    try {
      payload = parseJsonObject(row.payloadJson, `${sourceRef}.payload_json`);
    } catch (error) {
      issues.push({ code: "malformed_payload", sourceRef, details: { message: String(error) } });
      continue;
    }
    try {
      snapshot = parseJsonObject(row.snapshotJson, `${sourceRef}.snapshot_json`);
    } catch (error) {
      issues.push({ code: "malformed_snapshot", sourceRef, details: { message: String(error) } });
      continue;
    }
    const stableInputHash = sha256(stableJson({
      run_id: row.runId,
      attempt: row.attempt,
      attempt_id: row.attemptId,
      lifecycle: row.lifecycle,
      outcome: row.outcome,
      payload,
      snapshot,
    }));
    prepared.push({ ...row, payload, snapshot, stableInputHash });
  }

  const rows: CanonicalOutboxRow[] = [];
  const identities = new Map<string, string>();
  for (const [index, row] of sortedLegacyRows(prepared).entries()) {
    const sourceRef = `learning_projection_outbox:${row.id}`;
    const attempt = readAttemptSnapshot(db, row);
    if (!attempt) {
      issues.push({ code: "missing_attempt", sourceRef, details: { runId: row.runId, attempt: row.attempt } });
      continue;
    }
    let checkpoint: Record<string, unknown> | null;
    try {
      checkpoint = readCheckpointSnapshot(db, row, row.snapshot);
    } catch (error) {
      issues.push({ code: "checkpoint_mismatch", sourceRef, details: { message: String(error) } });
      continue;
    }
    if (!checkpoint) {
      issues.push({ code: "missing_checkpoint", sourceRef, details: { runId: row.runId, attempt: row.attempt } });
      continue;
    }
    let runEventRef: Record<string, unknown> | null;
    try {
      runEventRef = readRunEventSnapshot(db, row);
    } catch (error) {
      issues.push({ code: "malformed_run_event", sourceRef, details: { message: String(error) } });
      continue;
    }
    if (row.eventSeq > 0 && !runEventRef) {
      issues.push({ code: "missing_event_binding", sourceRef, details: { runId: row.runId, eventSeq: row.eventSeq } });
      continue;
    }
    const sourceEventId = row.eventSeq > 0
      ? `run:${row.runId}:event:${row.eventSeq}`
      : `run:${row.runId}:synthetic:${row.lifecycle}:${row.attemptId ?? ""}:${row.attempt}:${row.stableInputHash}`;
    const duplicate = identities.get(sourceEventId);
    if (duplicate) {
      issues.push({ code: "duplicate_source_event", sourceRef, details: { sourceEventId, duplicate } });
      continue;
    }
    identities.set(sourceEventId, row.id);
    const evidenceSnapshotJson = stableJson({
      taskRun: row.snapshot,
      attempt,
      checkpoint,
      runEventRef,
    });
    const attemptId = row.attemptId ?? String(attempt.id);
    const runEventReference = row.eventSeq > 0 ? sourceEventId : null;
    const payloadJson = stableJson(row.payload);
    const aggregateVersion = row.eventSeq > 0 ? row.eventSeq : row.attempt;
    const payloadHash = canonicalPayloadHash({ topic: INTEGRATION_TOPIC, aggregateId: row.runId,
      aggregateVersion, runEventRef: runEventReference, attemptId, ordinal: row.attempt,
      evidenceSnapshotJson, payload: row.payload });
    const eventId = canonicalIntegrationEventId(sourceEventId, INTEGRATION_TOPIC, payloadHash);
    rows.push({
      legacy: row,
      outboxSequence: previousVersion >= MIGRATION_VERSION
        ? row.outboxSequence ?? index + 1
        : index + 1,
      eventId,
      sourceEventId,
      topic: INTEGRATION_TOPIC,
      aggregateId: row.runId,
      aggregateVersion,
      runEventRef: runEventReference,
      attemptId,
      attemptOrdinal: row.attempt,
      evidenceSnapshotJson,
      payloadHash,
      payloadJson,
      createdAt: row.createdAt,
      stableInputHash: row.stableInputHash,
    });
  }
  return { rows, issues };
}

function issueKey(issue: MigrationIssue): string {
  return sha256(stableJson({ code: issue.code, source_ref: issue.sourceRef }));
}

function refreshIssues(db: Database.Database, issues: MigrationIssue[], timestamp: number): void {
  db.prepare(`UPDATE migration_issues SET status='resolved',resolved_at=?
    WHERE migration_version=? AND status='open'`).run(timestamp, MIGRATION_VERSION);
  const upsert = db.prepare(`INSERT INTO migration_issues
    (migration_version,issue_key,source_ref,code,details_json,status,detected_at,resolved_at)
    VALUES (?,?,?,?,?,'open',?,NULL)
    ON CONFLICT(migration_version,issue_key) DO UPDATE SET
      source_ref=excluded.source_ref,code=excluded.code,details_json=excluded.details_json,
      status='open',detected_at=excluded.detected_at,resolved_at=NULL`);
  for (const issue of issues) {
    upsert.run(
      MIGRATION_VERSION,
      issueKey(issue),
      issue.sourceRef,
      issue.code,
      stableJson(issue.details),
      timestamp,
    );
  }
}

function canonicalConflictIssues(
  db: Database.Database,
  canonical: CanonicalOutboxRow[],
  previousVersion: number,
): MigrationIssue[] {
  const issues: MigrationIssue[] = [];
  const legacyHasV33 = hasEveryColumn(db, "learning_projection_outbox", V33_LEGACY_COLUMNS);
  const integrationHasV33 = schemaObject(db, "integration_outbox")?.type === "table"
    && hasEveryColumn(db, "integration_outbox", [
      "outbox_sequence", "event_id", "source_event_id", "topic", "aggregate_id", "aggregate_version",
      "run_event_ref", "attempt_id", "attempt_ordinal", "evidence_snapshot_json", "payload_hash",
      "payload_json", "created_at",
    ]);
  for (const row of canonical) {
    const sourceRef = `learning_projection_outbox:${row.legacy.id}`;
    if (legacyHasV33 && (row.legacy.outboxSequence !== row.outboxSequence
      || row.legacy.sourceEventId !== row.sourceEventId
      || row.legacy.payloadHash !== row.payloadHash)) {
      issues.push({
        code: "legacy_identity_conflict",
        sourceRef,
        details: {
          expectedSequence: row.outboxSequence,
          actualSequence: row.legacy.outboxSequence,
          expectedSourceEventId: row.sourceEventId,
          actualSourceEventId: row.legacy.sourceEventId,
          expectedPayloadHash: row.payloadHash,
          actualPayloadHash: row.legacy.payloadHash,
        },
      });
    }
    if (!integrationHasV33) continue;
    const stored = db.prepare(`SELECT outbox_sequence as outboxSequence,event_id as eventId,
      source_event_id as sourceEventId,topic,aggregate_id as aggregateId,
      aggregate_version as aggregateVersion,run_event_ref as runEventRef,attempt_id as attemptId,
      attempt_ordinal as attemptOrdinal,evidence_snapshot_json as evidenceSnapshotJson,
      payload_hash as payloadHash,payload_json as payloadJson,created_at as createdAt
      FROM integration_outbox WHERE outbox_sequence=? OR source_event_id=? OR event_id=?`)
      .get(row.outboxSequence, row.sourceEventId, row.eventId) as Omit<CanonicalOutboxRow, "legacy" | "stableInputHash"> | undefined;
    const expected = {
      outboxSequence: row.outboxSequence,
      eventId: row.eventId,
      sourceEventId: row.sourceEventId,
      topic: row.topic,
      aggregateId: row.aggregateId,
      aggregateVersion: row.aggregateVersion,
      runEventRef: row.runEventRef,
      attemptId: row.attemptId,
      attemptOrdinal: row.attemptOrdinal,
      evidenceSnapshotJson: row.evidenceSnapshotJson,
      payloadHash: row.payloadHash,
      payloadJson: row.payloadJson,
      createdAt: row.createdAt,
    };
    if (!stored && previousVersion >= MIGRATION_VERSION) {
      issues.push({ code: "integration_missing", sourceRef, details: { sourceEventId: row.sourceEventId } });
    } else if (stored && stableJson(stored) !== stableJson(expected)) {
      issues.push({ code: "integration_conflict", sourceRef, details: { expected, stored } });
    }
  }
  if (integrationHasV33) {
    const expectedSources = new Set(canonical.map((row) => row.sourceEventId));
    const orphan = (db.prepare("SELECT source_event_id as sourceEventId FROM integration_outbox ORDER BY outbox_sequence")
      .all() as Array<{ sourceEventId: string }>).find((row) => !expectedSources.has(row.sourceEventId));
    if (orphan) {
      issues.push({
        code: "integration_orphan",
        sourceRef: `integration_outbox:${orphan.sourceEventId}`,
        details: { sourceEventId: orphan.sourceEventId },
      });
    }
  }
  return issues;
}

function bootstrapLearningIntegrationV33(db: Database.Database): void {
  db.exec(LEARNING_INTEGRATION_ISSUES_V33_SQL);
  assertSqlObject(db, {
    name: "migration_issues",
    type: "table",
    table: "migration_issues",
    sql: LEARNING_INTEGRATION_ISSUES_V33_SQL,
  });
}

/**
 * Commits the v32-compatible issue ledger and preflight before the main v33 transaction.
 * This function must not be called from an existing transaction: its durability is the
 * contract that lets operators inspect a rejected migration after Store startup closes.
 */
export function prepareLearningIntegrationV33(
  db: Database.Database,
  previousVersion: number,
  timestamp: number,
): void {
  if (db.inTransaction) fail("preflight requires an outermost transaction boundary");
  if (previousVersion < 32 || previousVersion > MIGRATION_VERSION) {
    fail(`preflight requires schema version 32 or 33, found ${previousVersion}`);
  }
  db.transaction(() => bootstrapLearningIntegrationV33(db)).immediate();
  db.transaction(() => {
    const derived = deriveCanonicalRows(db, previousVersion);
    refreshIssues(
      db,
      [...derived.issues, ...canonicalConflictIssues(db, derived.rows, previousVersion)],
      timestamp,
    );
  }).immediate();
  const open = (db.prepare(`SELECT COUNT(*) count FROM migration_issues
    WHERE migration_version=? AND status='open'`).get(MIGRATION_VERSION) as { count: number }).count;
  if (open > 0) fail(`preflight blocked by ${open} open migration issue${open === 1 ? "" : "s"}`);
}

function rebuildLegacyOutbox(db: Database.Database, canonical: CanonicalOutboxRow[]): void {
  const names = tableColumns(db, "learning_projection_outbox");
  const presentV33 = V33_LEGACY_COLUMNS.filter((column) => names.has(column));
  if (presentV33.length === V33_LEGACY_COLUMNS.length) return;
  if (presentV33.length > 0) fail("schema has partially migrated learning_projection_outbox columns");
  db.exec(`
    DROP INDEX IF EXISTS idx_learning_projection_pending;
    ALTER TABLE learning_projection_outbox RENAME TO learning_projection_outbox_v32;
    ${LEGACY_OUTBOX_V33_TABLE_SQL};
    ${LEGACY_OUTBOX_V33_INDEX_SQL};
  `);
  const byId = new Map(canonical.map((row) => [row.legacy.id, row]));
  const sourceRows = db.prepare(`SELECT id,run_id as runId,attempt,lifecycle,outcome,event_seq as eventSeq,
    payload_json as payloadJson,snapshot_json as snapshotJson,status,error,created_at as createdAt,
    updated_at as updatedAt,attempt_id as attemptId FROM learning_projection_outbox_v32 ORDER BY rowid`)
    .all() as LegacyOutboxRow[];
  const insert = db.prepare(`INSERT INTO learning_projection_outbox
    (id,run_id,attempt,lifecycle,outcome,event_seq,payload_json,snapshot_json,status,error,
     created_at,updated_at,attempt_id,outbox_sequence,source_event_id,payload_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const legacy of sourceRows) {
    const expected = byId.get(legacy.id);
    if (!expected) fail(`backfill is missing canonical row for ${legacy.id}`);
    insert.run(
      legacy.id,
      legacy.runId,
      legacy.attempt,
      legacy.lifecycle,
      legacy.outcome,
      legacy.eventSeq,
      legacy.payloadJson,
      legacy.snapshotJson,
      legacy.status,
      legacy.error,
      legacy.createdAt,
      legacy.updatedAt,
      legacy.attemptId,
      expected.outboxSequence,
      expected.sourceEventId,
      expected.payloadHash,
    );
  }
  db.exec("DROP TABLE learning_projection_outbox_v32");
}

function expectedSchemaObjects(): Array<{
  name: string;
  type: "table" | "index" | "trigger";
  table: string;
  sql: string;
}> {
  return [
    { name: "migration_issues", type: "table", table: "migration_issues", sql: LEARNING_INTEGRATION_ISSUES_V33_SQL },
    { name: "learning_projection_outbox", type: "table", table: "learning_projection_outbox", sql: LEGACY_OUTBOX_V33_TABLE_SQL },
    { name: "integration_stream_sequence", type: "table", table: "integration_stream_sequence", sql: `CREATE TABLE integration_stream_sequence (id INTEGER PRIMARY KEY CHECK(id=1),next_sequence INTEGER NOT NULL)` },
    { name: "integration_outbox", type: "table", table: "integration_outbox", sql: `CREATE TABLE integration_outbox (outbox_sequence INTEGER PRIMARY KEY,event_id TEXT NOT NULL UNIQUE,source_event_id TEXT NOT NULL UNIQUE,topic TEXT NOT NULL,aggregate_id TEXT NOT NULL,aggregate_version INTEGER NOT NULL,run_event_ref TEXT,attempt_id TEXT,attempt_ordinal INTEGER,evidence_snapshot_json TEXT NOT NULL,payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL,created_at INTEGER NOT NULL)` },
    { name: "integration_consumer_delivery", type: "table", table: "integration_consumer_delivery", sql: `CREATE TABLE integration_consumer_delivery (outbox_sequence INTEGER NOT NULL REFERENCES integration_outbox(outbox_sequence),consumer TEXT NOT NULL,lease_generation INTEGER NOT NULL,lease_owner TEXT,lease_token TEXT,lease_source TEXT NOT NULL CHECK(lease_source IN ('legacy','integration','shadow')),authority_generation INTEGER NOT NULL,authority_token TEXT,lease_until INTEGER,attempts INTEGER NOT NULL DEFAULT 0,acked_at INTEGER,status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','leased','acked','failed')),PRIMARY KEY(outbox_sequence,consumer))` },
    { name: "learning_projection_checkpoint", type: "table", table: "learning_projection_checkpoint", sql: `CREATE TABLE learning_projection_checkpoint (consumer TEXT NOT NULL,delivery_role TEXT NOT NULL CHECK(delivery_role IN ('legacy','integration','shadow')),watermark INTEGER NOT NULL DEFAULT 0,generation INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,PRIMARY KEY(consumer,delivery_role))` },
    { name: "learning_projection_authority_state", type: "table", table: "learning_projection_authority_state", sql: `CREATE TABLE learning_projection_authority_state (id INTEGER PRIMARY KEY CHECK(id=1),active_source TEXT NOT NULL CHECK(active_source IN ('legacy','integration')),generation INTEGER NOT NULL,owner TEXT,token TEXT,lease_until INTEGER,switch_watermark INTEGER NOT NULL DEFAULT 0,legacy_last_acked INTEGER NOT NULL DEFAULT 0,legacy_resume_position INTEGER NOT NULL DEFAULT 1,integration_checkpoint INTEGER NOT NULL DEFAULT 0,rollback_checkpoint INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL CHECK(status IN ('legacy_active','switching','integration_active','rollback')))` },
    { name: "integration_reconciliation", type: "table", table: "integration_reconciliation", sql: `CREATE TABLE integration_reconciliation (source_event_id TEXT PRIMARY KEY,outbox_sequence INTEGER,legacy_hash TEXT,integration_hash TEXT,legacy_snapshot_hash TEXT,integration_snapshot_hash TEXT,legacy_digest TEXT,integration_digest TEXT,status TEXT NOT NULL CHECK(status IN ('match','missing','hash_mismatch','snapshot_mismatch','digest_mismatch','blocker')),checked_at INTEGER NOT NULL)` },
    { name: "effect_receipts", type: "table", table: "effect_receipts", sql: `CREATE TABLE effect_receipts (logical_consumer TEXT NOT NULL,source_event_id TEXT NOT NULL,effect_hash TEXT NOT NULL,committed_at INTEGER NOT NULL,PRIMARY KEY(logical_consumer,source_event_id))` },
    { name: "idx_learning_projection_pending", type: "index", table: "learning_projection_outbox", sql: LEGACY_OUTBOX_V33_INDEX_SQL },
    { name: "idx_integration_outbox_topic", type: "index", table: "integration_outbox", sql: "CREATE INDEX idx_integration_outbox_topic ON integration_outbox(topic,created_at,outbox_sequence)" },
    { name: "idx_integration_consumer_delivery_claim", type: "index", table: "integration_consumer_delivery", sql: "CREATE INDEX idx_integration_consumer_delivery_claim ON integration_consumer_delivery(consumer,status,lease_until,outbox_sequence)" },
    { name: "idx_learning_projection_checkpoint_watermark", type: "index", table: "learning_projection_checkpoint", sql: "CREATE INDEX idx_learning_projection_checkpoint_watermark ON learning_projection_checkpoint(delivery_role,watermark)" },
    { name: "idx_integration_reconciliation_status", type: "index", table: "integration_reconciliation", sql: "CREATE INDEX idx_integration_reconciliation_status ON integration_reconciliation(status,source_event_id)" },
    { name: "integration_outbox_immutable_update", type: "trigger", table: "integration_outbox", sql: "CREATE TRIGGER integration_outbox_immutable_update BEFORE UPDATE ON integration_outbox BEGIN SELECT RAISE(ABORT,'integration_outbox is immutable'); END" },
    { name: "integration_outbox_immutable_delete", type: "trigger", table: "integration_outbox", sql: "CREATE TRIGGER integration_outbox_immutable_delete BEFORE DELETE ON integration_outbox BEGIN SELECT RAISE(ABORT,'integration_outbox is immutable'); END" },
    { name: "learning_projection_outbox_identity_immutable", type: "trigger", table: "learning_projection_outbox", sql: "CREATE TRIGGER learning_projection_outbox_identity_immutable BEFORE UPDATE OF outbox_sequence,source_event_id,payload_hash ON learning_projection_outbox BEGIN SELECT RAISE(ABORT,'learning_projection_outbox integration identity is immutable'); END" },
  ];
}

export function assertLearningIntegrationV33Schema(db: Database.Database): void {
  for (const expected of expectedSchemaObjects()) assertSqlObject(db, expected);
}

function assertExistingLearningIntegrationObjects(db: Database.Database): void {
  for (const expected of expectedSchemaObjects()) {
    if (schemaObject(db, expected.name)) assertSqlObject(db, expected);
  }
}

function insertOrVerifyIntegrationRows(db: Database.Database, canonical: CanonicalOutboxRow[]): void {
  const insert = db.prepare(`INSERT OR IGNORE INTO integration_outbox
    (outbox_sequence,event_id,source_event_id,topic,aggregate_id,aggregate_version,run_event_ref,
     attempt_id,attempt_ordinal,evidence_snapshot_json,payload_hash,payload_json,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const row of canonical) {
    insert.run(
      row.outboxSequence,
      row.eventId,
      row.sourceEventId,
      row.topic,
      row.aggregateId,
      row.aggregateVersion,
      row.runEventRef,
      row.attemptId,
      row.attemptOrdinal,
      row.evidenceSnapshotJson,
      row.payloadHash,
      row.payloadJson,
      row.createdAt,
    );
  }
  const conflicts = canonicalConflictIssues(db, canonical, MIGRATION_VERSION);
  if (conflicts.length > 0) fail(`backfill conflict for ${conflicts[0]!.sourceRef}`);
}

export function migrateLearningIntegrationV33(
  db: Database.Database,
  previousVersion: number,
  _timestamp: number,
): void {
  if (!db.inTransaction) fail("main migration must run in one transaction");
  if (previousVersion < 32 || previousVersion > MIGRATION_VERSION) {
    fail(`migration requires schema version 32 or 33, found ${previousVersion}`);
  }
  bootstrapLearningIntegrationV33(db);
  const open = (db.prepare(`SELECT COUNT(*) count FROM migration_issues
    WHERE migration_version=? AND status='open'`).get(MIGRATION_VERSION) as { count: number }).count;
  if (open > 0) fail(`migration refused ${open} open preflight issue${open === 1 ? "" : "s"}`);
  const derived = deriveCanonicalRows(db, previousVersion);
  if (derived.issues.length > 0) fail(`migration encountered unprepared issue ${derived.issues[0]!.code}`);
  rebuildLegacyOutbox(db, derived.rows);
  assertExistingLearningIntegrationObjects(db);
  db.exec(LEARNING_INTEGRATION_SCHEMA_V33_SQL);
  assertLearningIntegrationV33Schema(db);
  const canonical = deriveCanonicalRows(db, MIGRATION_VERSION);
  if (canonical.issues.length > 0) fail(`migration encountered backfill issue ${canonical.issues[0]!.code}`);
  insertOrVerifyIntegrationRows(db, canonical.rows);
  const nextSequence = canonical.rows.reduce((maximum, row) => Math.max(maximum, row.outboxSequence), 0) + 1;
  const existingSequence = db.prepare("SELECT next_sequence as nextSequence FROM integration_stream_sequence WHERE id=1")
    .get() as { nextSequence: number } | undefined;
  if (existingSequence && existingSequence.nextSequence !== nextSequence) {
    fail(`backfill conflict for integration_stream_sequence: expected ${nextSequence}, found ${existingSequence.nextSequence}`);
  }
  db.prepare(`INSERT INTO integration_stream_sequence (id,next_sequence) VALUES (1,?)
    ON CONFLICT(id) DO NOTHING`).run(nextSequence);
  db.prepare(`INSERT INTO learning_projection_authority_state
    (id,active_source,generation,owner,token,lease_until,switch_watermark,legacy_last_acked,
     legacy_resume_position,integration_checkpoint,rollback_checkpoint,status)
    VALUES (1,'legacy',0,NULL,NULL,NULL,0,0,1,0,0,'legacy_active') ON CONFLICT(id) DO NOTHING`).run();
  assertLearningIntegrationV33Schema(db);
}
