import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  Artifact,
  CompletionGate,
  Message,
  PlanItem,
  RunCheck,
  RunCheckpoint,
  RunEvent,
  RunId,
  RunContinuation,
  RunPhase,
  RunStatus,
  Session,
  SessionId,
  TaskRun,
} from "../core/types.js";

const now = () => Date.now();
const SCHEMA_VERSION = 4;

export class Store {
  readonly db: Database.Database;

  constructor(filename = process.env.TAGENT_DB ?? "./data/tagent.db") {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  getLastTranscriptSeq(runId: RunId) {
    return (this.db.prepare("SELECT COALESCE(MAX(seq), 0) as seq FROM run_transcript WHERE run_id = ?").get(runId) as { seq: number }).seq;
  }

  getCheckpoint(runId: RunId): RunCheckpoint | null {
    const row = this.db.prepare(`SELECT run_id as runId, attempt, active,
      assistant_partial as assistantPartial, current_tool_json as currentToolJson,
      last_event_seq as lastEventSeq, last_transcript_seq as lastTranscriptSeq, updated_at as updatedAt
      FROM run_checkpoints WHERE run_id = ?`).get(runId) as (Omit<RunCheckpoint, "active" | "currentTool"> & { active: number; currentToolJson: string }) | undefined;
    if (!row) return null;
    const { currentToolJson, ...checkpoint } = row;
    return { ...checkpoint, active: Boolean(row.active), currentTool: currentToolJson ? JSON.parse(currentToolJson) as RunCheckpoint["currentTool"] : null };
  }

  upsertCheckpoint(checkpoint: Omit<RunCheckpoint, "updatedAt"> & { updatedAt?: number }) {
    const updatedAt = checkpoint.updatedAt ?? now();
    this.db.prepare(`INSERT INTO run_checkpoints
      (run_id, attempt, active, assistant_partial, current_tool_json, last_event_seq, last_transcript_seq, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET attempt = excluded.attempt, active = excluded.active,
        assistant_partial = excluded.assistant_partial, current_tool_json = excluded.current_tool_json,
        last_event_seq = excluded.last_event_seq, last_transcript_seq = excluded.last_transcript_seq,
        updated_at = excluded.updated_at
      WHERE excluded.attempt > run_checkpoints.attempt OR
        (excluded.attempt = run_checkpoints.attempt AND EXISTS (
          SELECT 1 FROM runs WHERE id = excluded.run_id AND status = 'running' AND attempt = excluded.attempt
        ))`).run(
      checkpoint.runId, checkpoint.attempt, checkpoint.active ? 1 : 0, checkpoint.assistantPartial,
      checkpoint.currentTool ? JSON.stringify(checkpoint.currentTool) : "", checkpoint.lastEventSeq,
      checkpoint.lastTranscriptSeq, updatedAt,
    );
    return this.getCheckpoint(checkpoint.runId)!;
  }

  nextContinuationLeaseExpiry() {
    const row = this.db.prepare(`SELECT MIN(lease_until) as leaseUntil FROM run_continuations
      WHERE status = 'running' AND lease_until IS NOT NULL`).get() as { leaseUntil: number | null };
    return row.leaseUntil;
  }

  ownsContinuationLease(id: string, owner: string) {
    return Boolean(this.db.prepare(`SELECT 1 FROM run_continuations
      WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_until > ?`).get(id, owner, now()));
  }

  listRecentMessages(sessionId: SessionId, limit = 200): Message[] {
    return this.db.prepare(`
      SELECT id, sessionId, role, content, createdAt FROM (
        SELECT id, session_id as sessionId, role, content, created_at as createdAt
        FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(sessionId, limit) as Message[];
  }

  close() {
    this.db.close();
  }

  private migrate() {
    const migration = this.db.transaction(() => {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        request_id TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        phase TEXT NOT NULL,
        goal TEXT NOT NULL,
        gate_required INTEGER NOT NULL DEFAULT 1,
        blocked_reason TEXT NOT NULL DEFAULT '',
        last_event_seq INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        attempt INTEGER NOT NULL DEFAULT 1,
        resumed_at INTEGER,
        usage_input INTEGER NOT NULL DEFAULT 0,
        usage_output INTEGER NOT NULL DEFAULT 0,
        usage_cache_read INTEGER NOT NULL DEFAULT 0,
        usage_cache_write INTEGER NOT NULL DEFAULT 0,
        usage_total_tokens INTEGER NOT NULL DEFAULT 0,
        usage_cost REAL NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id, updated_at);
      CREATE TABLE IF NOT EXISTS run_events (
        run_id TEXT NOT NULL REFERENCES runs(id),
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE TABLE IF NOT EXISTS run_continuations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        ordinal INTEGER NOT NULL,
        status TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        lease_owner TEXT NOT NULL DEFAULT '',
        lease_until INTEGER,
        heartbeat_at INTEGER,
        UNIQUE(run_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS idx_continuations_run ON run_continuations(run_id, ordinal);
      CREATE TABLE IF NOT EXISTS run_transcript (
        run_id TEXT NOT NULL REFERENCES runs(id),
        seq INTEGER NOT NULL,
        attempt INTEGER NOT NULL,
        role TEXT NOT NULL,
        message_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      );
      CREATE INDEX IF NOT EXISTS idx_transcript_run ON run_transcript(run_id, seq);
      CREATE TABLE IF NOT EXISTS run_checkpoints (
        run_id TEXT PRIMARY KEY REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        assistant_partial TEXT NOT NULL DEFAULT '',
        current_tool_json TEXT NOT NULL DEFAULT '',
        last_event_seq INTEGER NOT NULL DEFAULT 0,
        last_transcript_seq INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        operation_type TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        effects_json TEXT NOT NULL DEFAULT '[]',
        result_json TEXT NOT NULL DEFAULT '',
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_operations_run ON operations(run_id, created_at);
      CREATE TABLE IF NOT EXISTS tool_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id),
        attempt INTEGER NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        args_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        UNIQUE(run_id, attempt, tool_call_id)
      );
      CREATE INDEX IF NOT EXISTS idx_tool_attempts_guard ON tool_attempts(run_id, tool_name, args_hash, id);
      CREATE TABLE IF NOT EXISTS plan_items (
        run_id TEXT NOT NULL REFERENCES runs(id),
        item_key TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        required INTEGER NOT NULL DEFAULT 1,
        position INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, item_key)
      );
      CREATE TABLE IF NOT EXISTS run_checks (
        run_id TEXT NOT NULL REFERENCES runs(id),
        check_key TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        required INTEGER NOT NULL DEFAULT 1,
        command TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '',
        stale INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (run_id, check_key)
      );
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        uri TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL
      );
    `);
    const current = this.db.prepare("SELECT version FROM schema_meta WHERE id = 1").get() as { version: number } | undefined;
    if (current && current.version > SCHEMA_VERSION) throw new Error(`Database schema version ${current.version} is newer than supported version ${SCHEMA_VERSION}`);
    this.ensureColumn("runs", "attempt", "INTEGER NOT NULL DEFAULT 1");
    this.ensureColumn("runs", "resumed_at", "INTEGER");
    this.ensureColumn("runs", "usage_input", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "usage_output", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "usage_cache_read", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "usage_cache_write", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "usage_total_tokens", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("runs", "usage_cost", "REAL NOT NULL DEFAULT 0");
    this.ensureColumn("run_continuations", "lease_owner", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("run_continuations", "lease_until", "INTEGER");
    this.ensureColumn("run_continuations", "heartbeat_at", "INTEGER");
    this.db.prepare(`UPDATE run_continuations SET status = 'cancelled',
      error = 'Superseded while enforcing one active continuation per Run', completed_at = ?,
      lease_owner = '', lease_until = NULL, heartbeat_at = NULL
      WHERE status IN ('queued', 'running') AND id NOT IN (
        SELECT id FROM run_continuations active
        WHERE active.run_id = run_continuations.run_id AND active.status IN ('queued', 'running')
        ORDER BY active.ordinal LIMIT 1
      )`).run(now());
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_continuations_one_active
      ON run_continuations(run_id) WHERE status IN ('queued', 'running')`);
    this.db.prepare(`INSERT INTO schema_meta (id, version, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`)
      .run(SCHEMA_VERSION, now());
    });
    migration();
    this.db.prepare("UPDATE operations SET status = 'outcome_unknown', stage = 'service_restart', error = 'Service restarted before operation outcome was recorded', updated_at = ? WHERE status = 'running'").run(now());
  }

  getSchemaVersion() {
    return (this.db.prepare("SELECT version FROM schema_meta WHERE id = 1").get() as { version: number }).version;
  }

  private ensureColumn(table: string, column: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  createSession(title = "New workspace"): Session {
    const session: Session = { id: randomUUID(), title, createdAt: now(), updatedAt: now() };
    this.db.prepare("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
      session.id, session.title, session.createdAt, session.updatedAt,
    );
    return session;
  }

  listSessions(): Session[] {
    return this.db.prepare("SELECT id, title, created_at as createdAt, updated_at as updatedAt FROM sessions ORDER BY updated_at DESC")
      .all() as Session[];
  }

  getSession(id: SessionId): Session | undefined {
    return this.db.prepare("SELECT id, title, created_at as createdAt, updated_at as updatedAt FROM sessions WHERE id = ?")
      .get(id) as Session | undefined;
  }

  touchSession(id: SessionId) {
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now(), id);
  }

  listMessages(sessionId: SessionId, limit = 200): Message[] {
    return this.db.prepare(`
      SELECT id, session_id as sessionId, role, content, created_at as createdAt
      FROM messages WHERE session_id = ? ORDER BY id ASC LIMIT ?
    `).all(sessionId, limit) as Message[];
  }

  appendMessage(sessionId: SessionId, role: Message["role"], content: string): Message {
    const createdAt = now();
    const result = this.db.prepare("INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(sessionId, role, content, createdAt);
    this.touchSession(sessionId);
    return { id: Number(result.lastInsertRowid), sessionId, role, content, createdAt };
  }

  createRun(sessionId: SessionId, goal: string, requestId: string = randomUUID()): TaskRun {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO runs (id, session_id, request_id, status, phase, goal, created_at, updated_at)
      VALUES (?, ?, ?, 'running', 'discover', ?, ?, ?)
    `).run(id, sessionId, requestId, goal, timestamp, timestamp);
    return this.getRun(id)!;
  }

  getRun(id: RunId): TaskRun | undefined {
    type RunRow = Omit<TaskRun, "plan" | "checks" | "artifacts" | "continuations" | "completionGate" | "gateRequired" | "usage" | "transcriptCount" | "checkpoint"> & {
      gateRequired: number;
      usageInput: number;
      usageOutput: number;
      usageCacheRead: number;
      usageCacheWrite: number;
      usageTotalTokens: number;
      usageCost: number;
      transcriptCount: number;
    };
    const row = this.db.prepare(`
      SELECT id, session_id as sessionId, request_id as requestId, status, phase, goal,
             gate_required as gateRequired, blocked_reason as blockedReason,
             last_event_seq as lastEventSeq, created_at as createdAt,
             updated_at as updatedAt, completed_at as completedAt,
             attempt, resumed_at as resumedAt,
             usage_input as usageInput, usage_output as usageOutput,
             usage_cache_read as usageCacheRead, usage_cache_write as usageCacheWrite,
             usage_total_tokens as usageTotalTokens, usage_cost as usageCost,
             (SELECT COUNT(*) FROM run_transcript t WHERE t.run_id = runs.id) as transcriptCount
      FROM runs WHERE id = ?
    `).get(id) as RunRow | undefined;
    if (!row) return undefined;
    const planRows = this.db.prepare(`SELECT item_key as key, title, status, required, position FROM plan_items WHERE run_id = ? ORDER BY position`).all(id) as Array<Omit<PlanItem, "required"> & { required: number }>;
    const checkRows = this.db.prepare(`SELECT check_key as key, title, status, required, command, evidence, stale FROM run_checks WHERE run_id = ? ORDER BY check_key`).all(id) as Array<Omit<RunCheck, "required" | "stale"> & { required: number; stale: number }>;
    const plan = planRows.map((item) => ({ ...item, required: Boolean(item.required) }));
    const checks = checkRows.map((item) => ({ ...item, required: Boolean(item.required), stale: Boolean(item.stale) }));
    const artifacts = this.db.prepare(`SELECT id, run_id as runId, kind, title, content, uri, created_at as createdAt FROM artifacts WHERE run_id = ? ORDER BY created_at`).all(id) as Artifact[];
    const continuations = this.listContinuations(id);
    const { usageInput, usageOutput, usageCacheRead, usageCacheWrite, usageTotalTokens, usageCost, transcriptCount, ...runRow } = row;
    const task: TaskRun = {
      ...runRow,
      gateRequired: Boolean(row.gateRequired),
      usage: { input: usageInput, output: usageOutput, cacheRead: usageCacheRead, cacheWrite: usageCacheWrite, totalTokens: usageTotalTokens, cost: usageCost },
      transcriptCount,
      checkpoint: this.getCheckpoint(id),
      continuations,
      plan,
      checks,
      artifacts,
      completionGate: { passed: true, failures: [] },
    };
    task.completionGate = this.evaluateGate(task);
    return task;
  }

  listRuns(sessionId: SessionId, limit = 50): TaskRun[] {
    const rows = this.db.prepare("SELECT id FROM runs WHERE session_id = ? ORDER BY updated_at DESC LIMIT ?").all(sessionId, limit) as Array<{ id: string }>;
    return rows.map((row) => this.getRun(row.id)!);
  }

  getLatestRun(sessionId: SessionId): TaskRun | undefined {
    const row = this.db.prepare("SELECT id FROM runs WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1").get(sessionId) as { id: string } | undefined;
    return row ? this.getRun(row.id) : undefined;
  }

  getActiveRun(sessionId: SessionId): TaskRun | undefined {
    const row = this.db.prepare("SELECT id FROM runs WHERE session_id = ? AND status = 'running' ORDER BY updated_at DESC LIMIT 1").get(sessionId) as { id: string } | undefined;
    return row ? this.getRun(row.id) : undefined;
  }

  recoverContinuationsAfterRestart(timestamp = now()) {
    const transaction = this.db.transaction(() => {
      const active = this.db.prepare(`SELECT id, run_id as runId, ordinal FROM run_continuations
        WHERE status = 'queued' OR (status = 'running' AND (lease_until IS NULL OR lease_until <= ?))
        ORDER BY created_at`).all(timestamp) as Array<{ id: string; runId: string; ordinal: number }>;
      for (const item of active) {
        this.db.prepare(`UPDATE run_continuations SET status = 'queued', error = 'Recovered after lease expiry',
          started_at = NULL, completed_at = NULL, lease_owner = '', lease_until = NULL, heartbeat_at = NULL WHERE id = ?`).run(item.id);
        this.db.prepare("UPDATE runs SET status = 'blocked', phase = 'blocked', blocked_reason = 'Continuation recovered after service restart', completed_at = NULL, updated_at = ? WHERE id = ? AND status IN ('running', 'interrupted', 'blocked')")
          .run(timestamp, item.runId);
        this.db.prepare("UPDATE run_checkpoints SET active = 0, current_tool_json = '', updated_at = ? WHERE run_id = ?")
          .run(timestamp, item.runId);
      }
      return active;
    });
    return transaction();
  }

  releaseContinuationLeases(owner: string, reason = "Continuation owner stopped") {
    const transaction = this.db.transaction(() => {
      const timestamp = now();
      const active = this.db.prepare(`SELECT id, run_id as runId, ordinal FROM run_continuations
        WHERE status = 'running' AND lease_owner = ? ORDER BY created_at`).all(owner) as Array<{ id: string; runId: string; ordinal: number }>;
      for (const item of active) {
        this.db.prepare(`UPDATE run_continuations SET status = 'queued', error = ?, started_at = NULL,
          completed_at = NULL, lease_owner = '', lease_until = NULL, heartbeat_at = NULL
          WHERE id = ? AND status = 'running' AND lease_owner = ?`).run(reason, item.id, owner);
        this.db.prepare(`UPDATE runs SET status = 'blocked', phase = 'blocked', blocked_reason = ?,
          completed_at = NULL, updated_at = ? WHERE id = ? AND status IN ('running', 'interrupted', 'blocked')`)
          .run(reason, timestamp, item.runId);
        this.db.prepare("UPDATE run_checkpoints SET active = 0, current_tool_json = '', updated_at = ? WHERE run_id = ?")
          .run(timestamp, item.runId);
      }
      return active;
    });
    return transaction();
  }

  renewContinuationLease(id: string, owner: string, leaseMs: number) {
    const timestamp = now();
    const result = this.db.prepare(`UPDATE run_continuations SET lease_until = ?, heartbeat_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_until > ?`).run(timestamp + leaseMs, timestamp, id, owner, timestamp);
    return result.changes === 1;
  }

  listContinuations(runId: RunId): RunContinuation[] {
    return this.db.prepare(`SELECT id, run_id as runId, ordinal, status, reason, error,
      created_at as createdAt, started_at as startedAt, completed_at as completedAt,
      lease_owner as leaseOwner, lease_until as leaseUntil, heartbeat_at as heartbeatAt
      FROM run_continuations WHERE run_id = ? ORDER BY ordinal`).all(runId) as RunContinuation[];
  }

  queueContinuation(runId: RunId, reason: string): RunContinuation {
    const transaction = this.db.transaction(() => {
      const active = this.db.prepare("SELECT id FROM run_continuations WHERE run_id = ? AND status IN ('queued', 'running')").get(runId) as { id: string } | undefined;
      if (active) throw new Error("Run already has an active continuation");
      const timestamp = now();
      const row = this.db.prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 as ordinal FROM run_continuations WHERE run_id = ?").get(runId) as { ordinal: number };
      const continuation: RunContinuation = { id: randomUUID(), runId, ordinal: row.ordinal, status: "queued", reason, error: "", createdAt: timestamp, startedAt: null, completedAt: null, leaseOwner: "", leaseUntil: null, heartbeatAt: null };
      this.db.prepare("INSERT INTO run_continuations (id, run_id, ordinal, status, reason, created_at) VALUES (?, ?, ?, 'queued', ?, ?)")
        .run(continuation.id, runId, continuation.ordinal, reason, timestamp);
      return continuation;
    });
    return transaction();
  }

  claimContinuation(runId: RunId, owner: string, leaseMs: number) {
    const transaction = this.db.transaction(() => {
      const timestamp = now();
      const continuation = this.db.prepare(`SELECT id, ordinal FROM run_continuations
        WHERE run_id = ? AND status = 'queued' ORDER BY ordinal LIMIT 1`).get(runId) as { id: string; ordinal: number } | undefined;
      if (!continuation) return undefined;
      const run = this.db.prepare("SELECT status, last_event_seq as seq FROM runs WHERE id = ?").get(runId) as { status: RunStatus; seq: number } | undefined;
      if (!run || run.status !== "blocked") return undefined;
      const leaseUntil = timestamp + leaseMs;
      const claimed = this.db.prepare(`UPDATE run_continuations SET status = 'running', error = '',
        started_at = COALESCE(started_at, ?), completed_at = NULL, lease_owner = ?, lease_until = ?, heartbeat_at = ?
        WHERE id = ? AND status = 'queued'`).run(timestamp, owner, leaseUntil, timestamp, continuation.id);
      if (claimed.changes !== 1) return undefined;
      const attempt = (this.db.prepare("SELECT attempt FROM runs WHERE id = ?").get(runId) as { attempt: number }).attempt + 1;
      const seq = run.seq + 1;
      const data = { continuationId: continuation.id, ordinal: continuation.ordinal, attempt, leaseOwner: owner, leaseUntil };
      this.db.prepare("INSERT INTO run_events (run_id, seq, type, data, created_at) VALUES (?, ?, 'continuation.started', ?, ?)")
        .run(runId, seq, JSON.stringify(data), timestamp);
      const resumed = this.db.prepare(`UPDATE runs SET status = 'running', phase = CASE WHEN phase = 'blocked' THEN 'implement' ELSE phase END,
        blocked_reason = '', completed_at = NULL, attempt = ?, resumed_at = ?, updated_at = ?, last_event_seq = ?
        WHERE id = ? AND status = 'blocked'`).run(attempt, timestamp, timestamp, seq, runId);
      if (resumed.changes !== 1) throw new Error("Continuation claim lost its Run compare-and-set race");
      return { continuation: this.listContinuations(runId).find((item) => item.id === continuation.id)!, run: this.getRun(runId)!, event: { runId, seq, type: "continuation.started", data, createdAt: timestamp } satisfies RunEvent };
    });
    return transaction();
  }

  updateContinuation(id: string, status: RunContinuation["status"], error = "", owner?: string) {
    const timestamp = now();
    const startedAt = status === "running" ? timestamp : null;
    const completedAt = ["completed", "blocked", "failed", "cancelled"].includes(status) ? timestamp : null;
    const result = this.db.prepare(`UPDATE run_continuations SET status = ?, error = ?,
      started_at = COALESCE(started_at, ?), completed_at = COALESCE(?, completed_at),
      lease_owner = CASE WHEN ? = 'running' THEN lease_owner ELSE '' END,
      lease_until = CASE WHEN ? = 'running' THEN lease_until ELSE NULL END,
      heartbeat_at = CASE WHEN ? = 'running' THEN heartbeat_at ELSE NULL END
      WHERE id = ? AND (? IS NULL OR lease_owner = ?)`)
      .run(status, error, startedAt, completedAt, status, status, status, id, owner ?? null, owner ?? null);
    return result.changes === 1;
  }

  cancelQueuedContinuations(runId: RunId, reason: string) {
    const timestamp = now();
    this.db.prepare("UPDATE run_continuations SET status = 'cancelled', error = ?, completed_at = ? WHERE run_id = ? AND status = 'queued'")
      .run(reason, timestamp, runId);
  }

  appendTranscript(runId: RunId, attempt: number, message: AgentMessage) {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 as seq FROM run_transcript WHERE run_id = ?").get(runId) as { seq: number };
      this.db.prepare("INSERT INTO run_transcript (run_id, seq, attempt, role, message_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(runId, row.seq, attempt, message.role, JSON.stringify(message), now());
      if (message.role === "assistant") {
        this.db.prepare(`UPDATE runs SET
          usage_input = usage_input + ?, usage_output = usage_output + ?,
          usage_cache_read = usage_cache_read + ?, usage_cache_write = usage_cache_write + ?,
          usage_total_tokens = usage_total_tokens + ?, usage_cost = usage_cost + ?, updated_at = ?
          WHERE id = ?`).run(
          message.usage.input, message.usage.output, message.usage.cacheRead, message.usage.cacheWrite,
          message.usage.totalTokens, message.usage.cost.total, now(), runId,
        );
      }
      return row.seq;
    });
    return transaction();
  }

  listTranscriptEntries(runId: RunId) {
    const rows = this.db.prepare("SELECT seq, attempt, role, message_json as messageJson, created_at as createdAt FROM run_transcript WHERE run_id = ? ORDER BY seq").all(runId) as Array<{ seq: number; attempt: number; role: string; messageJson: string; createdAt: number }>;
    return rows.map(({ messageJson, ...row }) => ({ ...row, message: JSON.parse(messageJson) as AgentMessage }));
  }

  listTranscript(runId: RunId): AgentMessage[] {
    return this.listTranscriptEntries(runId).map((entry) => entry.message);
  }

  repairTranscript(runId: RunId, reason: "cancelled" | "resume" | "continuation") {
    const transaction = this.db.transaction(() => {
      const run = this.getRun(runId);
      if (!run) throw new Error(`Unknown run ${runId}`);
      const pending = new Map<string, string>();
      for (const message of this.listTranscript(runId)) {
        if (message.role === "assistant") {
          for (const part of message.content) if (part.type === "toolCall") pending.set(part.id, part.name);
        } else if (message.role === "toolResult") {
          pending.delete(message.toolCallId);
        }
      }
      const repaired: Array<{ toolCallId: string; toolName: string }> = [];
      for (const [toolCallId, toolName] of pending) {
        const message: AgentMessage = {
          role: "toolResult", toolCallId, toolName,
          content: [{ type: "text", text: `Tool result synthesized by TAgent Core because the ${reason} boundary interrupted this call.` }],
          details: { synthetic: true, reason }, isError: true, timestamp: now(),
        };
        this.appendTranscript(runId, run.attempt, message);
        repaired.push({ toolCallId, toolName });
      }
      return repaired;
    });
    return transaction();
  }

  listTranscriptView(runId: RunId) {
    type TranscriptViewItem =
      | { seq: number; index?: number; attempt: number; kind: "user" | "assistant"; text: string; createdAt: number }
      | { seq: number; index: number; attempt: number; kind: "tool"; toolCallId: string; toolName: string; arguments: unknown; result: string; isError: boolean; status: "pending" | "completed" | "failed"; createdAt: number };
    const toolResults = new Map<string, { content: string; isError: boolean; toolName: string }>();
    const entries = this.listTranscriptEntries(runId);
    for (const entry of entries) {
      const message = entry.message;
      if (message.role !== "toolResult") continue;
      const content = message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
      toolResults.set(message.toolCallId, { content, isError: message.isError, toolName: message.toolName });
    }
    const view: TranscriptViewItem[] = [];
    for (const entry of entries) {
      const message = entry.message;
      if (message.role === "user") {
        view.push({ seq: entry.seq, attempt: entry.attempt, kind: "user", text: typeof message.content === "string" ? message.content : "", createdAt: entry.createdAt });
        continue;
      }
      if (message.role !== "assistant") continue;
      for (const [index, part] of message.content.entries()) {
        if (part.type === "text" && part.text) {
          view.push({ seq: entry.seq, index, attempt: entry.attempt, kind: "assistant", text: part.text, createdAt: entry.createdAt });
          continue;
        }
        if (part.type !== "toolCall") continue;
        const result = toolResults.get(part.id);
        view.push({ seq: entry.seq, index, attempt: entry.attempt, kind: "tool", toolCallId: part.id, toolName: part.name, arguments: part.arguments, result: result?.content ?? "", isError: result?.isError ?? false, status: result ? (result.isError ? "failed" : "completed") : "pending", createdAt: entry.createdAt });
      }
    }
    return view;
  }

  private canonicalHash(payload: unknown) {
    const canonicalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonicalize);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalize(item)]));
      return value;
    };
    return createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex");
  }

  claimOperation(id: string, runId: RunId, attempt: number, operationType: string, payload: unknown) {
    const payloadHash = this.canonicalHash(payload);
    const timestamp = now();
    const transaction = this.db.transaction(() => {
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO operations
        (id, run_id, attempt, operation_type, payload_hash, status, stage, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'running', 'executing', ?, ?)`).run(id, runId, attempt, operationType, payloadHash, timestamp, timestamp);
      const receipt = this.getOperation(id)!;
      if (receipt.operationType !== operationType || receipt.payloadHash !== payloadHash || receipt.runId !== runId) throw new Error("Operation ID already exists with a different payload or scope");
      return { ...receipt, claimed: inserted.changes === 1 };
    });
    return transaction();
  }

  updateOperation(id: string, update: { status: string; stage?: string; effects?: unknown[]; result?: unknown; error?: string; expectedStatuses?: string[] }) {
    const timestamp = now();
    const completedAt = ["succeeded", "failed", "cancelled", "outcome_unknown"].includes(update.status) ? timestamp : null;
    const current = this.getOperation(id);
    if (!current) throw new Error(`Unknown operation ${id}`);
    const expected = update.expectedStatuses ?? (completedAt ? ["running"] : [current.status]);
    if (!expected.includes(current.status)) throw new Error(`Operation ${id} cannot transition from ${current.status} to ${update.status}`);
    const placeholders = expected.map(() => "?").join(", ");
    const result = this.db.prepare(`UPDATE operations SET status = ?, stage = ?, effects_json = ?, result_json = ?, error = ?, updated_at = ?, completed_at = ? WHERE id = ? AND status IN (${placeholders})`)
      .run(update.status, update.stage ?? current.stage, JSON.stringify(update.effects ?? current.effects), update.result === undefined ? (current.result === undefined ? "" : JSON.stringify(current.result)) : JSON.stringify(update.result), update.error ?? current.error, timestamp, completedAt, id, ...expected);
    if (result.changes !== 1) throw new Error(`Operation ${id} transition lost its compare-and-set race`);
    return this.getOperation(id)!;
  }

  getOperation(id: string) {
    const row = this.db.prepare(`SELECT id, run_id as runId, attempt, operation_type as operationType, payload_hash as payloadHash,
      status, stage, effects_json as effectsJson, result_json as resultJson, error, created_at as createdAt,
      updated_at as updatedAt, completed_at as completedAt FROM operations WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const { effectsJson, resultJson, ...receipt } = row;
    return { ...receipt, effects: JSON.parse(String(effectsJson || "[]")), result: resultJson ? JSON.parse(String(resultJson)) : undefined } as {
      id: string; runId: string; attempt: number; operationType: string; payloadHash: string; status: string; stage: string; effects: unknown[]; result?: unknown; error: string; createdAt: number; updatedAt: number; completedAt: number | null;
    };
  }

  listOperations(runId: RunId) {
    const rows = this.db.prepare("SELECT id FROM operations WHERE run_id = ? ORDER BY created_at, id").all(runId) as Array<{ id: string }>;
    return rows.map((row) => this.getOperation(row.id)!);
  }

  recordToolAttempt(runId: RunId, attempt: number, toolCallId: string, toolName: string, args: unknown) {
    const argsHash = this.canonicalHash(args);
    const timestamp = now();
    this.db.prepare(`INSERT OR IGNORE INTO tool_attempts
      (run_id, attempt, tool_call_id, tool_name, args_hash, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?)`).run(runId, attempt, toolCallId, toolName, argsHash, timestamp);
    return { argsHash, guard: this.evaluateToolGuard(runId, toolName, argsHash) };
  }

  completeToolAttempt(runId: RunId, attempt: number, toolCallId: string, success: boolean, error = "") {
    this.db.prepare("UPDATE tool_attempts SET status = ?, error = ?, completed_at = ? WHERE run_id = ? AND attempt = ? AND tool_call_id = ?")
      .run(success ? "succeeded" : "failed", error, now(), runId, attempt, toolCallId);
  }

  private evaluateToolGuard(runId: RunId, toolName: string, argsHash: string) {
    const recent = this.db.prepare(`SELECT tool_name as toolName, args_hash as argsHash, status FROM tool_attempts
      WHERE run_id = ? AND status != 'running' ORDER BY id DESC LIMIT 50`).all(runId) as Array<{ toolName: string; argsHash: string; status: string }>;
    let sameArgs = 0;
    let sameArgsFailures = 0;
    let sameToolFailures = 0;
    for (const item of recent) {
      if (item.toolName === toolName && item.argsHash === argsHash) sameArgs += 1;
      else break;
    }
    for (const item of recent) {
      if (item.toolName !== toolName || item.argsHash !== argsHash || item.status !== "failed") break;
      sameArgsFailures += 1;
    }
    for (const item of recent) {
      if (item.toolName !== toolName || item.status !== "failed") break;
      sameToolFailures += 1;
    }
    if (sameArgs >= 5) return { blocked: true, reason: `Tool ${toolName} repeated the same arguments ${sameArgs} times` };
    if (sameArgsFailures >= 3) return { blocked: true, reason: `Tool ${toolName} failed with the same arguments ${sameArgsFailures} times` };
    if (sameToolFailures >= 6) return { blocked: true, reason: `Tool ${toolName} failed consecutively ${sameToolFailures} times` };
    return { blocked: false, reason: "" };
  }

  setRunPhase(runId: RunId, phase: RunPhase) {
    if (phase === "done" || phase === "blocked") return false;
    return this.advanceRunPhase(runId, phase);
  }

  advanceRunPhase(runId: RunId, phase: Exclude<RunPhase, "done" | "blocked">) {
    const rank: Record<Exclude<RunPhase, "done" | "blocked">, number> = { discover: 0, plan: 1, implement: 2, verify: 3, review: 4 };
    return this.db.prepare(`UPDATE runs SET phase = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND CASE phase
        WHEN 'discover' THEN 0 WHEN 'plan' THEN 1 WHEN 'implement' THEN 2
        WHEN 'verify' THEN 3 WHEN 'review' THEN 4 ELSE 99 END < ?`)
      .run(phase, now(), runId, rank[phase]).changes === 1;
  }

  upsertPlanItem(runId: RunId, item: Omit<PlanItem, "runId">) {
    this.db.prepare(`
      INSERT INTO plan_items (run_id, item_key, title, status, required, position) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, item_key) DO UPDATE SET title=excluded.title, status=excluded.status, required=excluded.required, position=excluded.position
    `).run(runId, item.key, item.title, item.status, Number(item.required), item.position);
    this.advanceRunPhase(runId, item.status === "pending" ? "plan" : "implement");
  }

  markChecksStale(runId: RunId) {
    const result = this.db.prepare("UPDATE run_checks SET stale = 1 WHERE run_id = ? AND status = 'passed'").run(runId);
    if (result.changes) this.db.prepare("UPDATE runs SET updated_at = ? WHERE id = ?").run(now(), runId);
    return result.changes;
  }

  upsertCheck(runId: RunId, check: RunCheck) {
    this.db.prepare(`
      INSERT INTO run_checks (run_id, check_key, title, status, required, command, evidence, stale) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, check_key) DO UPDATE SET title=excluded.title, status=excluded.status, required=excluded.required, command=excluded.command, evidence=excluded.evidence, stale=excluded.stale
    `).run(runId, check.key, check.title, check.status, Number(check.required), check.command, check.evidence, Number(check.stale));
    this.advanceRunPhase(runId, check.status === "pending" ? "implement" : "verify");
  }

  addArtifact(runId: RunId, artifact: Omit<Artifact, "runId" | "createdAt">): Artifact {
    const createdAt = now();
    this.db.prepare("INSERT INTO artifacts (id, run_id, kind, title, content, uri, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(artifact.id, runId, artifact.kind, artifact.title, artifact.content, artifact.uri, createdAt);
    return { ...artifact, runId, createdAt };
  }

  appendEvent(runId: RunId, type: string, data: Record<string, unknown>): RunEvent {
    const transaction = this.db.transaction(() => {
      const run = this.db.prepare("SELECT last_event_seq as seq FROM runs WHERE id = ?").get(runId) as { seq: number } | undefined;
      if (!run) throw new Error(`Unknown run ${runId}`);
      const seq = run.seq + 1;
      const createdAt = now();
      this.db.prepare("INSERT INTO run_events (run_id, seq, type, data, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(runId, seq, type, JSON.stringify(data), createdAt);
      this.db.prepare("UPDATE runs SET last_event_seq = ?, updated_at = ? WHERE id = ?").run(seq, createdAt, runId);
      return { runId, seq, type, data, createdAt } satisfies RunEvent;
    });
    return transaction();
  }

  listEvents(runId: RunId, after = 0): RunEvent[] {
    const rows = this.db.prepare(`SELECT run_id as runId, seq, type, data, created_at as createdAt FROM run_events WHERE run_id = ? AND seq > ? ORDER BY seq`).all(runId, after) as Array<Omit<RunEvent, "data"> & { data: string }>;
    return rows.map((row) => ({ ...row, data: JSON.parse(row.data) as Record<string, unknown> }));
  }

  transitionRun(runId: RunId, expected: RunStatus[], nextStatus: RunStatus, type: string, data: Record<string, unknown>, reason = "", expectedAttempt?: number) {
    const transaction = this.db.transaction(() => {
      const row = this.db.prepare("SELECT status, attempt, last_event_seq as seq FROM runs WHERE id = ?").get(runId) as { status: RunStatus; attempt: number; seq: number } | undefined;
      if (!row || !expected.includes(row.status) || (expectedAttempt !== undefined && row.attempt !== expectedAttempt)) return undefined;
      const createdAt = now();
      const seq = row.seq + 1;
      const phase = nextStatus === "completed" ? "done" : nextStatus === "blocked" ? "blocked" : undefined;
      const completedAt = ["completed", "cancelled", "failed"].includes(nextStatus) ? createdAt : null;
      this.db.prepare("INSERT INTO run_events (run_id, seq, type, data, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(runId, seq, type, JSON.stringify(data), createdAt);
      const placeholders = expected.map(() => "?").join(", ");
      const attemptClause = expectedAttempt === undefined ? "" : " AND attempt = ?";
      const result = this.db.prepare(`UPDATE runs SET status = ?, phase = COALESCE(?, phase), blocked_reason = ?,
        last_event_seq = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status IN (${placeholders})${attemptClause}`)
        .run(nextStatus, phase, reason, seq, completedAt, createdAt, runId, ...expected, ...(expectedAttempt === undefined ? [] : [expectedAttempt]));
      if (result.changes !== 1) throw new Error("Run transition lost its compare-and-set race");
      if (nextStatus !== "running") this.db.prepare(`UPDATE run_checkpoints SET active = 0, current_tool_json = '',
        last_event_seq = MAX(last_event_seq, ?), updated_at = ? WHERE run_id = ? AND attempt = ?`)
        .run(seq, createdAt, runId, row.attempt);
      return { runId, seq, type, data, createdAt } satisfies RunEvent;
    });
    return transaction();
  }

  finalizeRun(runId: RunId, status: Exclude<RunStatus, "running" | "interrupted" | "blocked">, reason = "") {
    const timestamp = now();
    const completedAt = status === "completed" || status === "cancelled" || status === "failed" ? timestamp : null;
    const transaction = this.db.transaction(() => {
      this.db.prepare("UPDATE runs SET status = ?, blocked_reason = ?, completed_at = ?, updated_at = ? WHERE id = ?")
        .run(status, reason, completedAt, timestamp, runId);
      this.db.prepare("UPDATE run_checkpoints SET active = 0, current_tool_json = '', updated_at = ? WHERE run_id = ?")
        .run(timestamp, runId);
    });
    transaction();
  }

  blockRun(runId: RunId, reason: string) {
    const timestamp = now();
    const transaction = this.db.transaction(() => {
      this.db.prepare("UPDATE runs SET status = 'blocked', phase = 'blocked', blocked_reason = ?, updated_at = ? WHERE id = ?")
        .run(reason, timestamp, runId);
      this.db.prepare("UPDATE run_checkpoints SET active = 0, current_tool_json = '', updated_at = ? WHERE run_id = ?")
        .run(timestamp, runId);
    });
    transaction();
  }

  markInterrupted() {
    const timestamp = now();
    const transaction = this.db.transaction(() => {
      this.db.prepare("UPDATE run_checkpoints SET active = 0, current_tool_json = '', updated_at = ? WHERE run_id IN (SELECT id FROM runs WHERE status = 'running')")
        .run(timestamp);
      this.db.prepare("UPDATE runs SET status = 'interrupted', blocked_reason = 'Service restarted before the run reached a terminal state', updated_at = ? WHERE status = 'running'")
        .run(timestamp);
    });
    transaction();
  }

  resumeRun(runId: RunId) {
    const run = this.getRun(runId);
    if (!run || !["interrupted", "blocked"].includes(run.status)) throw new Error("Run is not resumable");
    const resumedAt = now();
    this.db.prepare("UPDATE runs SET status = 'running', phase = CASE WHEN phase = 'blocked' THEN 'implement' ELSE phase END, blocked_reason = '', completed_at = NULL, attempt = attempt + 1, resumed_at = ?, updated_at = ? WHERE id = ?")
      .run(resumedAt, resumedAt, runId);
    return this.getRun(runId)!;
  }

  evaluateGate(run: TaskRun): CompletionGate {
    if (!run.gateRequired) return { passed: true, failures: [] };
    const failures: CompletionGate["failures"] = [];
    const requiredPlan = run.plan.filter((item) => item.required);
    if (requiredPlan.length === 0) failures.push({ kind: "plan", key: "plan", reason: "No required plan items" });
    for (const item of requiredPlan) if (item.status !== "done") failures.push({ kind: "plan_item", key: item.key, reason: `Required plan item is ${item.status}` });
    for (const check of run.checks.filter((item) => item.required)) {
      if (check.status !== "passed") failures.push({ kind: "check", key: check.key, reason: `Required check is ${check.status}` });
      else if (check.stale) failures.push({ kind: "check", key: check.key, reason: "Evidence is stale" });
    }
    return { passed: failures.length === 0, failures };
  }

  completeWithGate(runId: RunId, response: string, expectedAttempt?: number) {
    const run = this.getRun(runId);
    if (!run) throw new Error("Run not found");
    const gate = this.evaluateGate(run);
    const reason = gate.failures.map((failure) => `${failure.key}: ${failure.reason}`).join("; ");
    const event = this.transitionRun(runId, ["running"], gate.passed ? "completed" : "blocked", gate.passed ? "run.completed" : "run.blocked", { response, gate }, reason, expectedAttempt);
    if (!event) throw new Error("Run is no longer running");
    return { gate, run: this.getRun(runId)!, event };
  }
}
