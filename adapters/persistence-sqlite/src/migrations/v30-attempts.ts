import type Database from "better-sqlite3";
import { attemptIdFor } from "@tagent/execution/domain";

export const ATTEMPT_SCHEMA_V30_SQL = `
  CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id),
    ordinal INTEGER NOT NULL CHECK (ordinal > 0),
    trigger TEXT NOT NULL CHECK (trigger IN ('initial','resume','continuation','retry','input','recovery','legacy_backfill')),
    status TEXT NOT NULL CHECK (status IN ('legacy_unknown','queued','starting','running','settling','waiting_input','blocked','completed','failed','cancelled','interrupted','superseded')),
    active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1))
      CHECK ((active = 1) = (status IN ('queued','starting','running','settling'))),
    version INTEGER NOT NULL CHECK (version > 0),
    legacy_event_seq INTEGER NOT NULL DEFAULT 0 CHECK (legacy_event_seq >= 0),
    started_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    reconstruction_state TEXT NOT NULL DEFAULT 'complete' CHECK (reconstruction_state IN ('complete','legacy_unknown')),
    UNIQUE(run_id, ordinal)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_attempts_one_active ON attempts(run_id)
    WHERE status IN ('queued','starting','running','settling');
  CREATE INDEX IF NOT EXISTS idx_attempts_run ON attempts(run_id, ordinal);
  CREATE TABLE IF NOT EXISTS execution_leases (
    attempt_id TEXT PRIMARY KEY REFERENCES attempts(id),
    owner_id TEXT NOT NULL,
    lease_token TEXT NOT NULL,
    fence INTEGER NOT NULL CHECK (fence > 0),
    attempt_version INTEGER NOT NULL CHECK (attempt_version > 0),
    lease_until INTEGER NOT NULL,
    heartbeat_at INTEGER NOT NULL,
    released_at INTEGER,
    CHECK (lease_until >= heartbeat_at)
  );
  CREATE TABLE IF NOT EXISTS candidate_results (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    attempt_version INTEGER NOT NULL CHECK (attempt_version > 0),
    response TEXT NOT NULL,
    response_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('proposed','accepted','rejected')),
    created_at INTEGER NOT NULL,
    settled_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_candidate_results_attempt ON candidate_results(attempt_id, created_at, id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_results_one_per_attempt ON candidate_results(attempt_id);
  CREATE TABLE IF NOT EXISTS attempt_transition_audit (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    run_id TEXT NOT NULL REFERENCES runs(id),
    ordinal INTEGER NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    trigger TEXT NOT NULL,
    scenario TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL,
    legacy_event_seq INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_attempt_transition_audit_attempt ON attempt_transition_audit(attempt_id, created_at, id);
  CREATE TABLE IF NOT EXISTS attempt_shadow_comparisons (
    id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES attempts(id),
    scenario TEXT NOT NULL,
    legacy_json TEXT NOT NULL,
    projected_json TEXT NOT NULL,
    mismatch INTEGER NOT NULL CHECK (mismatch IN (0,1)),
    gate_sample INTEGER NOT NULL DEFAULT 0 CHECK (gate_sample IN (0,1)),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_attempt_shadow_gate ON attempt_shadow_comparisons(mismatch, scenario, created_at);
  CREATE TABLE IF NOT EXISTS attempt_authority_receipts (
    id TEXT PRIMARY KEY,
    requested_attempt_id TEXT NOT NULL REFERENCES attempts(id),
    decision TEXT NOT NULL CHECK (decision IN ('approved','rejected','rollback')),
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS attempt_authority_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    mode TEXT NOT NULL CHECK (mode IN ('shadow','canary')),
    status TEXT NOT NULL CHECK (status IN ('blocked','approved')),
    approved_attempt_id TEXT REFERENCES attempts(id),
    receipt_id TEXT REFERENCES attempt_authority_receipts(id),
    sample_count INTEGER NOT NULL DEFAULT 0,
    mismatch_count INTEGER NOT NULL DEFAULT 0,
    scenario_coverage_json TEXT NOT NULL DEFAULT '[]',
    comparison_epoch_start INTEGER NOT NULL DEFAULT 0,
    comparison_watermark INTEGER NOT NULL DEFAULT 0,
    last_mismatch_id TEXT,
    updated_at INTEGER NOT NULL
  );
`;

function ensureColumn(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export function migrateAttemptsV30(
  db: Database.Database,
  previousVersion: number | undefined,
  timestamp: number,
): void {
  ensureColumn(db, "run_events", "attempt_id", "TEXT");
  ensureColumn(db, "run_continuations", "source_attempt_id", "TEXT");
  ensureColumn(db, "run_continuations", "scheduled_attempt_id", "TEXT");
  ensureColumn(db, "run_transcript", "attempt_id", "TEXT");
  ensureColumn(db, "control_inbox", "attempt_id", "TEXT");
  ensureColumn(db, "run_checkpoints", "attempt_id", "TEXT");
  ensureColumn(db, "operations", "attempt_id", "TEXT");
  ensureColumn(db, "tool_attempts", "attempt_id", "TEXT");
  ensureColumn(db, "attempts", "reconstruction_state", "TEXT NOT NULL DEFAULT 'complete'");
  ensureColumn(db, "attempt_shadow_comparisons", "gate_sample", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "attempt_authority_state", "comparison_watermark", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "attempt_authority_state", "comparison_epoch_start", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "attempt_authority_state", "last_mismatch_id", "TEXT");
  const tables = db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (names.has("run_id") && names.has("attempt") && !names.has("attempt_id")) {
      ensureColumn(db, name, "attempt_id", "TEXT");
    }
  }
  db.exec(`DROP INDEX IF EXISTS idx_attempts_one_active;
    CREATE UNIQUE INDEX idx_attempts_one_active ON attempts(run_id)
      WHERE status IN ('queued','starting','running','settling');
    CREATE UNIQUE INDEX IF NOT EXISTS idx_candidate_results_one_per_attempt ON candidate_results(attempt_id);`);

  if (previousVersion === undefined || previousVersion < 30) backfillAttempts(db);
  db.prepare(`INSERT INTO attempt_authority_state
    (id,mode,status,approved_attempt_id,receipt_id,sample_count,mismatch_count,scenario_coverage_json,
     comparison_epoch_start,comparison_watermark,last_mismatch_id,updated_at)
    VALUES (1,'shadow','blocked',NULL,NULL,0,0,'[]',0,0,NULL,?) ON CONFLICT(id) DO NOTHING`).run(timestamp);
}

function backfillAttempts(db: Database.Database): void {
  const rows = db.prepare(`SELECT id,attempt,status,last_event_seq as lastEventSeq,
    created_at as createdAt,updated_at as updatedAt,completed_at as completedAt FROM runs ORDER BY rowid`)
    .all() as Array<{
      id: string;
      attempt: number;
      status: string;
      lastEventSeq: number;
      createdAt: number;
      updatedAt: number;
      completedAt: number | null;
    }>;
  const insertAttempt = db.prepare(`INSERT OR IGNORE INTO attempts
    (id,run_id,ordinal,trigger,status,active,version,legacy_event_seq,started_at,updated_at,completed_at,reconstruction_state)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertAudit = db.prepare(`INSERT OR IGNORE INTO attempt_transition_audit
    (id,attempt_id,run_id,ordinal,from_status,to_status,trigger,scenario,reason,version,legacy_event_seq,created_at)
    VALUES (?,?,?,?,NULL,?,?,?,'schema_v30_backfill',1,?,?)`);
  const insertComparison = db.prepare(`INSERT OR IGNORE INTO attempt_shadow_comparisons
    (id,attempt_id,scenario,legacy_json,projected_json,mismatch,gate_sample,created_at)
    VALUES (?,?,?,?,?,0,0,?)`);
  for (const row of rows) {
    for (let ordinal = 1; ordinal <= Math.max(1, row.attempt); ordinal += 1) {
      const id = attemptIdFor(row.id, ordinal);
      const current = ordinal === row.attempt;
      const status = current ? row.status : "legacy_unknown";
      const active = current && row.status === "running" ? 1 : 0;
      const trigger = ordinal === 1 ? "initial" : "legacy_backfill";
      const reconstructionState = current ? "complete" : "legacy_unknown";
      const completedAt = active || !current ? null : row.completedAt ?? row.updatedAt;
      const expected = {
        id, runId: row.id, ordinal, trigger, status, active, version: 1,
        legacyEventSeq: current ? row.lastEventSeq : 0,
        startedAt: row.createdAt, updatedAt: row.updatedAt, completedAt, reconstructionState,
      };
      insertAttempt.run(
        expected.id, expected.runId, expected.ordinal, expected.trigger, expected.status, expected.active,
        expected.version, expected.legacyEventSeq, expected.startedAt, expected.updatedAt, expected.completedAt,
        expected.reconstructionState,
      );
      const stored = db.prepare(`SELECT id,run_id as runId,ordinal,trigger,status,active,version,
        legacy_event_seq as legacyEventSeq,started_at as startedAt,updated_at as updatedAt,
        completed_at as completedAt,reconstruction_state as reconstructionState FROM attempts WHERE id=?`)
        .get(id) as typeof expected | undefined;
      if (!stored || JSON.stringify(stored) !== JSON.stringify(expected)) {
        throw new Error(`Attempt v30 backfill conflict for ${id}`);
      }
      insertAudit.run(
        `backfill:${id}`, id, row.id, ordinal, status, trigger, "recovery",
        current ? row.lastEventSeq : 0, row.updatedAt,
      );
      const snapshot = JSON.stringify({
        runId: row.id, ordinal, status, active: Boolean(active),
        eventSeq: current ? row.lastEventSeq : 0, reconstructionState,
      });
      insertComparison.run(`backfill:${id}`, id, "recovery", snapshot, snapshot, row.updatedAt);
    }
  }
  const attemptTables = db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>;
  for (const { name } of attemptTables) {
    const columns = db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("run_id") || !names.has("attempt") || !names.has("attempt_id")) continue;
    const conflict = db.prepare(`SELECT 1 FROM ${quoteIdentifier(name)} row
      WHERE row.run_id IS NOT NULL AND row.attempt IS NOT NULL AND row.attempt > 0
        AND row.attempt_id IS NOT NULL
        AND row.attempt_id <> 'attempt:' || row.run_id || ':' || row.attempt LIMIT 1`).get();
    if (conflict) throw new Error(`Attempt v30 compatibility backfill conflict in ${name}`);
    const orphan = db.prepare(`SELECT 1 FROM ${quoteIdentifier(name)} row
      WHERE row.run_id IS NOT NULL AND row.attempt IS NOT NULL AND row.attempt > 0 AND NOT EXISTS (
        SELECT 1 FROM attempts attempt
        WHERE attempt.id='attempt:' || row.run_id || ':' || row.attempt
      ) LIMIT 1`).get();
    if (orphan) throw new Error(`Attempt v30 compatibility backfill orphan in ${name}`);
    db.prepare(`UPDATE ${quoteIdentifier(name)} SET attempt_id='attempt:' || run_id || ':' || attempt
        WHERE attempt_id IS NULL AND run_id IS NOT NULL AND attempt > 0`).run();
  }
  db.prepare(`UPDATE run_events SET attempt_id='attempt:' || run_id || ':' ||
    COALESCE(CASE WHEN json_type(data,'$.attempt')='integer' AND json_extract(data,'$.attempt') > 0
      THEN json_extract(data,'$.attempt') END,
      (SELECT attempt FROM runs WHERE runs.id=run_events.run_id))
    WHERE attempt_id IS NULL`).run();
  db.prepare(`UPDATE run_continuations SET scheduled_attempt_id=(
      SELECT 'attempt:' || run_continuations.run_id || ':' || json_extract(event.data,'$.attempt')
      FROM run_events event WHERE event.run_id=run_continuations.run_id
        AND event.type='continuation.started'
        AND json_extract(event.data,'$.continuationId')=run_continuations.id
        AND json_type(event.data,'$.attempt')='integer' LIMIT 1)
    WHERE scheduled_attempt_id IS NULL`).run();
  db.prepare(`UPDATE run_continuations SET source_attempt_id='attempt:' || run_id || ':' ||
      (CAST(substr(scheduled_attempt_id,length('attempt:' || run_id || ':') + 1) AS INTEGER) - 1)
    WHERE source_attempt_id IS NULL AND scheduled_attempt_id IS NOT NULL
      AND CAST(substr(scheduled_attempt_id,length('attempt:' || run_id || ':') + 1) AS INTEGER) > 1`).run();
}
