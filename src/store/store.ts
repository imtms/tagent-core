import Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  Artifact,
  CompletionGate,
  ControlInboxItem,
  GateEvaluation,
  ProgressSnapshot,
  SpawnProposal,
  SupervisorDecision,
  TaskRunEdge,
  Message,
  PlanItem,
  RunCheck,
  RunCheckpoint,
  RunEvent,
  RunId,
  RunContinuation,
  EventConsumerCursor,
  RunPhase,
  RunStatus,
  Session,
  SessionInboxItem,
  SessionId,
  TaskRun,
} from "../core/types.js";

const now = () => Date.now();
const SCHEMA_VERSION = 8;

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
      CREATE TABLE IF NOT EXISTS session_supervisor_inbox (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        request_id TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        decision TEXT NOT NULL DEFAULT 'pending',
        run_id TEXT REFERENCES runs(id),
        error TEXT NOT NULL DEFAULT '',
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        claimed_at INTEGER,
        started_at INTEGER,
        UNIQUE(session_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS idx_session_supervisor_inbox_queue ON session_supervisor_inbox(session_id,status,position,created_at);
      CREATE TABLE IF NOT EXISTS supervisor_decisions (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), attempt INTEGER NOT NULL,
        checkpoint_seq INTEGER NOT NULL, trigger TEXT NOT NULL, action TEXT NOT NULL, reason_code TEXT NOT NULL,
        rationale TEXT NOT NULL, confidence REAL NOT NULL, instruction TEXT NOT NULL DEFAULT '',
        candidate_response_hash TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL, executed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_supervisor_decisions_run ON supervisor_decisions(run_id, attempt, created_at);
      CREATE TABLE IF NOT EXISTS gate_evaluations (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), attempt INTEGER NOT NULL,
        checkpoint_seq INTEGER NOT NULL, gate_type TEXT NOT NULL, passed INTEGER NOT NULL,
        failures_json TEXT NOT NULL, input_manifest_hash TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gate_evaluations_run ON gate_evaluations(run_id, attempt, created_at);
      CREATE TABLE IF NOT EXISTS progress_snapshots (
        run_id TEXT PRIMARY KEY REFERENCES runs(id), attempt INTEGER NOT NULL, checkpoint_seq INTEGER NOT NULL,
        meaningful_changes INTEGER NOT NULL DEFAULT 0, consecutive_failures INTEGER NOT NULL DEFAULT 0,
        repeated_operations INTEGER NOT NULL DEFAULT 0, last_progress_at INTEGER NOT NULL,
        last_decision_id TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS spawn_proposals (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), goal TEXT NOT NULL,
        acceptance_json TEXT NOT NULL, relation TEXT NOT NULL, status TEXT NOT NULL,
        spawned_run_id TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS taskrun_edges (
        from_run_id TEXT NOT NULL REFERENCES runs(id), to_run_id TEXT NOT NULL REFERENCES runs(id),
        relation TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL,
        PRIMARY KEY(from_run_id, to_run_id, relation)
      );
      CREATE TABLE IF NOT EXISTS control_inbox (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        request_id TEXT NOT NULL,
        attempt INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('steer', 'follow_up')),
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL,
        claimed_at INTEGER,
        completed_at INTEGER,
        UNIQUE(run_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS idx_control_inbox_delivery ON control_inbox(run_id, attempt, status, created_at);
      CREATE TABLE IF NOT EXISTS event_consumers (
        run_id TEXT NOT NULL REFERENCES runs(id),
        consumer_id TEXT NOT NULL,
        generation INTEGER NOT NULL DEFAULT 0,
        acked_seq INTEGER NOT NULL DEFAULT 0,
        terminal_acked_seq INTEGER,
        claimed_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, consumer_id)
      );
      CREATE INDEX IF NOT EXISTS idx_event_consumers_updated ON event_consumers(updated_at);
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
    this.db.prepare("UPDATE control_inbox SET status = 'outcome_unknown', error = 'Service restarted while Pi delivery outcome was unknown', completed_at = ? WHERE status = 'delivering'").run(now());
  }

  getSchemaVersion() {
    return (this.db.prepare("SELECT version FROM schema_meta WHERE id = 1").get() as { version: number }).version;
  }

  private ensureColumn(table: string, column: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  createSession(title = "New workspace"): Session {
    const session: Session = { id: randomUUID(), title, createdAt: now(), updatedAt: now(), latestRunStatus: null, latestRunPhase: null };
    this.db.prepare("INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
      session.id, session.title, session.createdAt, session.updatedAt,
    );
    return session;
  }

  listSessions(): Session[] {
    return this.db.prepare(`
      SELECT sessions.id, sessions.title, sessions.created_at as createdAt, sessions.updated_at as updatedAt,
        latest.status as latestRunStatus, latest.phase as latestRunPhase
      FROM sessions
      LEFT JOIN runs latest ON latest.id = (
        SELECT runs.id FROM runs WHERE runs.session_id = sessions.id ORDER BY runs.updated_at DESC, runs.rowid DESC LIMIT 1
      )
      ORDER BY sessions.updated_at DESC
    `).all() as Session[];
  }

  getSession(id: SessionId): Session | undefined {
    return this.db.prepare(`
      SELECT sessions.id, sessions.title, sessions.created_at as createdAt, sessions.updated_at as updatedAt,
        latest.status as latestRunStatus, latest.phase as latestRunPhase
      FROM sessions
      LEFT JOIN runs latest ON latest.id = (
        SELECT runs.id FROM runs WHERE runs.session_id = sessions.id ORDER BY runs.updated_at DESC, runs.rowid DESC LIMIT 1
      )
      WHERE sessions.id = ?
    `).get(id) as Session | undefined;
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

  enqueueSessionInbox(sessionId: SessionId, content: string, requestId: string = randomUUID()): SessionInboxItem {
    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM session_supervisor_inbox WHERE session_id = ? AND request_id = ?").get(sessionId, requestId) as { id: string } | undefined;
      if (existing) return this.getSessionInboxItem(existing.id)!;
      const timestamp = now();
      const position = (this.db.prepare("SELECT COALESCE(MAX(position),0)+1 as position FROM session_supervisor_inbox WHERE session_id = ? AND status = 'queued'").get(sessionId) as { position: number }).position;
      const id = randomUUID();
      this.db.prepare(`INSERT INTO session_supervisor_inbox (id,session_id,request_id,content,status,decision,position,created_at,updated_at)
        VALUES (?,?,?,?,'queued','pending',?,?,?)`).run(id, sessionId, requestId, content, position, timestamp, timestamp);
      return this.getSessionInboxItem(id)!;
    });
    return transaction();
  }

  getSessionInboxItem(id: string): SessionInboxItem | undefined {
    return this.db.prepare(`SELECT id,session_id as sessionId,request_id as requestId,content,status,decision,run_id as runId,error,position,
      created_at as createdAt,updated_at as updatedAt,claimed_at as claimedAt,started_at as startedAt FROM session_supervisor_inbox WHERE id = ?`).get(id) as SessionInboxItem | undefined;
  }

  listSessionInbox(sessionId: SessionId, includeTerminal = false): SessionInboxItem[] {
    return this.db.prepare(`SELECT id,session_id as sessionId,request_id as requestId,content,status,decision,run_id as runId,error,position,
      created_at as createdAt,updated_at as updatedAt,claimed_at as claimedAt,started_at as startedAt FROM session_supervisor_inbox
      WHERE session_id = ? ${includeTerminal ? "" : "AND status IN ('queued','claimed')"} ORDER BY position,created_at,id`).all(sessionId) as SessionInboxItem[];
  }

  deleteSessionInboxItem(id: string, sessionId: SessionId) {
    const timestamp = now();
    return this.db.prepare(`UPDATE session_supervisor_inbox SET status='deleted',decision='delete',updated_at=?
      WHERE id=? AND session_id=? AND status='queued'`).run(timestamp, id, sessionId).changes === 1;
  }

  decideSessionInboxItem(id: string, sessionId: SessionId, decision: "pending" | "defer") {
    return this.db.prepare("UPDATE session_supervisor_inbox SET decision=?,updated_at=? WHERE id=? AND session_id=? AND status='queued'").run(decision,now(),id,sessionId).changes === 1;
  }

  mergeSessionInboxItems(sourceId: string, targetId: string, sessionId: SessionId) {
    if (sourceId === targetId) return false;
    const transaction = this.db.transaction(() => {
      const source = this.getSessionInboxItem(sourceId); const target = this.getSessionInboxItem(targetId);
      if (!source || !target || source.sessionId !== sessionId || target.sessionId !== sessionId || source.status !== "queued" || target.status !== "queued") return false;
      const content = `${target.content}

Additional queued instruction:
${source.content}`;
      const timestamp = now();
      this.db.prepare("UPDATE session_supervisor_inbox SET content=?,decision='pending',updated_at=? WHERE id=? AND status='queued'").run(content,timestamp,targetId);
      this.db.prepare("UPDATE session_supervisor_inbox SET status='deleted',decision='merge',error=?,updated_at=? WHERE id=? AND status='queued'").run(`Merged into ${targetId}`,timestamp,sourceId);
      return true;
    });
    return transaction();
  }

  claimNextSessionInbox(sessionId: SessionId) {
    const transaction = this.db.transaction(() => {
      const active = this.db.prepare(`SELECT 1 FROM runs
        WHERE session_id = ? AND (
          status = 'running' OR (
            status IN ('blocked','interrupted') AND id = (
              SELECT latest.id FROM runs latest WHERE latest.session_id = ? ORDER BY latest.rowid DESC LIMIT 1
            )
          )
        ) LIMIT 1`).get(sessionId, sessionId);
      if (active) return undefined;
      const item = this.db.prepare("SELECT id FROM session_supervisor_inbox WHERE session_id = ? AND status = 'queued' AND decision = 'pending' ORDER BY position,created_at,id LIMIT 1").get(sessionId) as { id: string } | undefined;
      if (!item) return undefined;
      return this.claimSessionInboxItem(item.id, sessionId);
    });
    return transaction();
  }

  claimSessionInboxNow(itemId: string, sessionId: SessionId) {
    const transaction = this.db.transaction(() => {
      const item = this.db.prepare("SELECT status FROM session_supervisor_inbox WHERE id = ? AND session_id = ?").get(itemId, sessionId) as { status: SessionInboxItem["status"] } | undefined;
      if (!item || item.status !== "queued") return { status: "not_queued" as const };
      const running = this.db.prepare("SELECT id FROM runs WHERE session_id = ? AND status = 'running' LIMIT 1").get(sessionId) as { id: string } | undefined;
      if (running) return { status: "running" as const, runId: running.id };
      const continuation = this.db.prepare(`SELECT c.id FROM run_continuations c
        JOIN runs r ON r.id = c.run_id
        WHERE r.session_id = ? AND r.status IN ('blocked','interrupted') AND c.status IN ('queued','running') LIMIT 1`).get(sessionId) as { id: string } | undefined;
      if (continuation) return { status: "continuation" as const, continuationId: continuation.id };
      const claimed = this.claimSessionInboxItem(itemId, sessionId);
      return claimed ? { status: "started" as const, ...claimed } : { status: "not_queued" as const };
    });
    return transaction();
  }

  private claimSessionInboxItem(itemId: string, sessionId: SessionId) {
    const timestamp = now();
    const claimed = this.db.prepare("UPDATE session_supervisor_inbox SET status='claimed',decision='start_taskrun',claimed_at=?,updated_at=? WHERE id=? AND session_id=? AND status='queued'").run(timestamp,timestamp,itemId,sessionId);
    if (claimed.changes !== 1) return undefined;
    const inbox = this.getSessionInboxItem(itemId)!;
    const run = this.createRun(sessionId, inbox.content, `inbox:${inbox.id}`);
    this.db.prepare("UPDATE session_supervisor_inbox SET status='started',run_id=?,started_at=?,updated_at=? WHERE id=? AND status='claimed'").run(run.id,timestamp,timestamp,inbox.id);
    return { item: this.getSessionInboxItem(inbox.id)!, run };
  }

  recordSessionInboxLaunchFailure(itemId: string, runId: RunId, error: string) {
    const timestamp = now();
    this.db.prepare("UPDATE session_supervisor_inbox SET status='started',error=?,updated_at=? WHERE id=? AND run_id=?").run(error,timestamp,itemId,runId);
  }

  private isInboxLaunchRetryable(runId: RunId) {
    return Boolean(this.db.prepare(`SELECT 1 FROM session_supervisor_inbox i
      JOIN runs r ON r.id = i.run_id
      JOIN run_events e ON e.run_id = i.run_id
      WHERE i.run_id = ? AND i.status = 'started' AND r.status = 'failed' AND e.type = 'run.failed'
        AND json_extract(e.data, '$.reason') = 'runtime_initialization_failed'
        AND json_extract(e.data, '$.retryable') = 1
        AND NOT EXISTS (SELECT 1 FROM run_events newer WHERE newer.run_id = e.run_id AND newer.type = 'run.failed' AND newer.seq > e.seq)
      ORDER BY e.seq DESC LIMIT 1`).get(runId));
  }

  retryInboxLaunch(runId: RunId) {
    const transaction = this.db.transaction(() => {
      const target = this.db.prepare(`SELECT r.id, r.session_id as sessionId, r.status, r.attempt, i.id as inboxItemId, i.content
        FROM runs r JOIN session_supervisor_inbox i ON i.run_id = r.id
        WHERE r.id = ? AND i.status = 'started'`).get(runId) as { id: RunId; sessionId: SessionId; status: RunStatus; attempt: number; inboxItemId: string; content: string } | undefined;
      if (!target) return { status: "not_retryable" as const };
      if (target.status !== "failed" || !this.isInboxLaunchRetryable(runId)) return { status: "not_retryable" as const };
      const running = this.db.prepare("SELECT id FROM runs WHERE session_id = ? AND status = 'running' AND id <> ? LIMIT 1").get(target.sessionId, runId) as { id: string } | undefined;
      if (running) return { status: "running" as const, runId: running.id };
      const continuation = this.db.prepare(`SELECT c.id FROM run_continuations c
        JOIN runs r ON r.id = c.run_id
        WHERE r.session_id = ? AND c.run_id <> ? AND r.status IN ('blocked','interrupted') AND c.status IN ('queued','running') LIMIT 1`).get(target.sessionId, runId) as { id: string } | undefined;
      if (continuation) return { status: "continuation" as const, continuationId: continuation.id };
      const resumedAt = now();
      const nextAttempt = target.attempt + 1;
      const updated = this.db.prepare(`UPDATE runs SET status='running', phase='discover', blocked_reason='', completed_at=NULL,
        attempt=?, resumed_at=?, updated_at=? WHERE id=? AND status='failed' AND attempt=?`).run(nextAttempt,resumedAt,resumedAt,runId,target.attempt);
      if (updated.changes !== 1) return { status: "not_retryable" as const };
      this.db.prepare("UPDATE session_supervisor_inbox SET error='',updated_at=? WHERE id=? AND run_id=? AND status='started'").run(resumedAt,target.inboxItemId,runId);
      return { status: "started" as const, item: this.getSessionInboxItem(target.inboxItemId)!, run: this.getRun(runId)! };
    });
    return transaction();
  }

  listSessionsWithQueuedInbox() {
    return (this.db.prepare("SELECT DISTINCT session_id as sessionId FROM session_supervisor_inbox WHERE status='queued'").all() as Array<{sessionId:string}>).map((row)=>row.sessionId);
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
    type RunRow = Omit<TaskRun, "plan" | "checks" | "artifacts" | "continuations" | "completionGate" | "gateRequired" | "usage" | "transcriptCount" | "checkpoint" | "supervision"> & {
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
      supervision: { latestDecision: this.listSupervisorDecisions(id).at(-1) ?? null, latestGates: this.listLatestGateEvaluations(id), progress: this.getProgressSnapshot(id) ?? null, spawnProposals: this.listSpawnProposals(id) },
      launchRetryable: this.isInboxLaunchRetryable(id),
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

  listSupervisorContinuationsNeedingReconcile() {
    return this.db.prepare(`SELECT d.run_id as runId, d.id as decisionId FROM supervisor_decisions d
      JOIN runs r ON r.id = d.run_id
      WHERE d.action = 'start_continuation' AND d.status = 'executed' AND r.status = 'blocked'
        AND d.attempt = r.attempt
        AND NOT EXISTS (SELECT 1 FROM run_continuations c WHERE c.run_id = d.run_id AND c.status IN ('queued','running'))
        AND NOT EXISTS (SELECT 1 FROM run_events e WHERE e.run_id = d.run_id AND e.type = 'continuation.exhausted' AND e.created_at >= d.created_at)
      ORDER BY d.created_at`).all() as Array<{ runId: string; decisionId: string }>;
  }

  reconcileSupervisorDecisionStatuses() {
    const transaction = this.db.transaction(() => {
      const proposed = this.db.prepare("SELECT id, run_id as runId, attempt FROM supervisor_decisions WHERE status = 'proposed'").all() as Array<{ id: string; runId: string; attempt: number }>;
      let executed = 0;
      let superseded = 0;
      for (const decision of proposed) {
        const event = this.db.prepare(`SELECT 1 FROM run_events WHERE run_id = ? AND type IN ('run.completed','run.blocked')
          AND json_extract(data, '$.supervisionDecisionId') = ? LIMIT 1`).get(decision.runId, decision.id);
        if (event) {
          this.db.prepare("UPDATE supervisor_decisions SET status = 'executed', executed_at = COALESCE(executed_at, ?) WHERE id = ? AND status = 'proposed'").run(now(), decision.id);
          executed += 1;
        } else {
          this.db.prepare("UPDATE supervisor_decisions SET status = 'superseded', error = 'Service restarted before decision execution completed' WHERE id = ? AND status = 'proposed'").run(decision.id);
          superseded += 1;
        }
      }
      return { executed, superseded };
    });
    return transaction();
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
      const run = this.db.prepare("SELECT session_id as sessionId, status, last_event_seq as seq FROM runs WHERE id = ?").get(runId) as { sessionId: SessionId; status: RunStatus; seq: number } | undefined;
      if (!run || run.status !== "blocked") return undefined;
      const otherRunning = this.db.prepare("SELECT 1 FROM runs WHERE session_id = ? AND id <> ? AND status = 'running' LIMIT 1").get(run.sessionId, runId);
      if (otherRunning) return undefined;
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

  claimEventConsumer(runId: RunId, consumerId: string): EventConsumerCursor {
    const transaction = this.db.transaction(() => {
      if (!this.db.prepare("SELECT 1 FROM runs WHERE id = ?").get(runId)) throw new Error(`Unknown run ${runId}`);
      const timestamp = now();
      this.db.prepare(`INSERT INTO event_consumers
        (run_id, consumer_id, generation, acked_seq, terminal_acked_seq, claimed_at, updated_at)
        VALUES (?, ?, 1, 0, NULL, ?, ?)
        ON CONFLICT(run_id, consumer_id) DO UPDATE SET generation = event_consumers.generation + 1,
          claimed_at = excluded.claimed_at, updated_at = excluded.updated_at`).run(runId, consumerId, timestamp, timestamp);
      return this.getEventConsumer(runId, consumerId)!;
    });
    return transaction();
  }

  getEventConsumer(runId: RunId, consumerId: string): EventConsumerCursor | undefined {
    return this.db.prepare(`SELECT run_id as runId, consumer_id as consumerId, generation,
      acked_seq as ackedSeq, terminal_acked_seq as terminalAckedSeq,
      claimed_at as claimedAt, updated_at as updatedAt FROM event_consumers
      WHERE run_id = ? AND consumer_id = ?`).get(runId, consumerId) as EventConsumerCursor | undefined;
  }

  ackEventConsumer(runId: RunId, consumerId: string, generation: number, seq: number) {
    const transaction = this.db.transaction(() => {
      const run = this.db.prepare("SELECT last_event_seq as lastEventSeq FROM runs WHERE id = ?").get(runId) as { lastEventSeq: number } | undefined;
      if (!run) return "missing" as const;
      const cursor = this.getEventConsumer(runId, consumerId);
      if (!cursor || cursor.generation !== generation) return "stale" as const;
      if (!Number.isSafeInteger(seq) || seq < cursor.ackedSeq || seq > run.lastEventSeq) return "invalid" as const;
      const terminal = this.db.prepare(`SELECT seq FROM run_events WHERE run_id = ? AND seq <= ?
        AND type IN ('run.completed','run.blocked','run.failed','run.cancelled') ORDER BY seq DESC LIMIT 1`).get(runId, seq) as { seq: number } | undefined;
      this.db.prepare(`UPDATE event_consumers SET acked_seq = ?, terminal_acked_seq = COALESCE(?, terminal_acked_seq), updated_at = ?
        WHERE run_id = ? AND consumer_id = ? AND generation = ?`).run(seq, terminal?.seq ?? null, now(), runId, consumerId, generation);
      return "accepted" as const;
    });
    return transaction();
  }

  enqueueControl(runId: RunId, requestId: string, kind: ControlInboxItem["kind"], content: string, capacity: number) {
    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM control_inbox WHERE run_id = ? AND request_id = ?").get(runId, requestId) as { id: string } | undefined;
      if (existing) return { status: "duplicate" as const, item: this.getControlItem(existing.id)! };
      const run = this.db.prepare("SELECT status, attempt FROM runs WHERE id = ?").get(runId) as { status: RunStatus; attempt: number } | undefined;
      if (!run || run.status !== "running") return { status: "inactive" as const };
      const active = (this.db.prepare("SELECT COUNT(*) as count FROM control_inbox WHERE run_id = ? AND attempt = ? AND status IN ('queued','delivering')").get(runId, run.attempt) as { count: number }).count;
      if (active >= capacity) return { status: "full" as const };
      const item: ControlInboxItem = { id: randomUUID(), runId, requestId, attempt: run.attempt, kind, content, status: "queued", error: "", createdAt: now(), claimedAt: null, completedAt: null };
      this.db.prepare(`INSERT INTO control_inbox (id, run_id, request_id, attempt, kind, content, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'queued', ?)`).run(item.id, runId, requestId, item.attempt, kind, content, item.createdAt);
      return { status: "accepted" as const, item };
    });
    return transaction();
  }

  getControlItem(id: string): ControlInboxItem | undefined {
    return this.db.prepare(`SELECT id, run_id as runId, request_id as requestId, attempt, kind, content, status, error,
      created_at as createdAt, claimed_at as claimedAt, completed_at as completedAt FROM control_inbox WHERE id = ?`).get(id) as ControlInboxItem | undefined;
  }

  listControlInbox(runId: RunId): ControlInboxItem[] {
    return this.db.prepare(`SELECT id, run_id as runId, request_id as requestId, attempt, kind, content, status, error,
      created_at as createdAt, claimed_at as claimedAt, completed_at as completedAt FROM control_inbox WHERE run_id = ? ORDER BY created_at, id`).all(runId) as ControlInboxItem[];
  }

  claimControlItem(runId: RunId, attempt: number) {
    const transaction = this.db.transaction(() => {
      this.db.prepare(`UPDATE control_inbox SET status = 'superseded', error = 'Run attempt advanced before delivery', completed_at = ?
        WHERE run_id = ? AND status = 'queued' AND attempt <> ?`).run(now(), runId, attempt);
      const row = this.db.prepare(`SELECT id FROM control_inbox WHERE run_id = ? AND attempt = ? AND status = 'queued'
        ORDER BY created_at, id LIMIT 1`).get(runId, attempt) as { id: string } | undefined;
      if (!row) return undefined;
      const claimedAt = now();
      const result = this.db.prepare("UPDATE control_inbox SET status = 'delivering', claimed_at = ? WHERE id = ? AND status = 'queued'").run(claimedAt, row.id);
      return result.changes === 1 ? this.getControlItem(row.id) : undefined;
    });
    return transaction();
  }

  completeControlItem(id: string, status: "delivered" | "rejected" | "superseded", error = "") {
    return this.db.prepare(`UPDATE control_inbox SET status = ?, error = ?, completed_at = ? WHERE id = ? AND status = 'delivering'`)
      .run(status, error, now(), id).changes === 1;
  }

  recordSupervisorDecision(decision: SupervisorDecision) {
    this.db.prepare(`INSERT INTO supervisor_decisions
      (id,run_id,attempt,checkpoint_seq,trigger,action,reason_code,rationale,confidence,instruction,candidate_response_hash,status,error,created_at,executed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(decision.id, decision.runId, decision.attempt, decision.checkpointSeq, decision.trigger, decision.action, decision.reasonCode, decision.rationale, decision.confidence, decision.instruction, decision.candidateResponseHash, decision.status, decision.error, decision.createdAt, decision.executedAt);
    return decision;
  }

  listSupervisorDecisions(runId: RunId, attempt?: number): SupervisorDecision[] {
    const rows = this.db.prepare(`SELECT id,run_id as runId,attempt,checkpoint_seq as checkpointSeq,trigger,action,reason_code as reasonCode,
      rationale,confidence,instruction,candidate_response_hash as candidateResponseHash,status,error,created_at as createdAt,executed_at as executedAt
      FROM supervisor_decisions WHERE run_id = ? ${attempt === undefined ? "" : "AND attempt = ?"} ORDER BY created_at,id`).all(runId, ...(attempt === undefined ? [] : [attempt])) as SupervisorDecision[];
    return rows;
  }

  updateSupervisorDecision(id: string, status: SupervisorDecision["status"], error = "") {
    const executedAt = status === "executed" || status === "failed" ? now() : null;
    this.db.prepare("UPDATE supervisor_decisions SET status = ?, error = ?, executed_at = COALESCE(?, executed_at) WHERE id = ?").run(status, error, executedAt, id);
    return this.db.prepare("SELECT run_id as runId FROM supervisor_decisions WHERE id = ?").get(id) as { runId: string } | undefined;
  }

  recordGateEvaluation(gate: GateEvaluation) {
    this.db.prepare(`INSERT INTO gate_evaluations (id,run_id,attempt,checkpoint_seq,gate_type,passed,failures_json,input_manifest_hash,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(gate.id, gate.runId, gate.attempt, gate.checkpointSeq, gate.gateType, Number(gate.passed), JSON.stringify(gate.failures), gate.inputManifestHash, gate.createdAt);
    return gate;
  }

  listLatestGateEvaluations(runId: RunId): GateEvaluation[] {
    const rows = this.db.prepare(`SELECT id,run_id as runId,attempt,checkpoint_seq as checkpointSeq,gate_type as gateType,passed,
      failures_json as failuresJson,input_manifest_hash as inputManifestHash,created_at as createdAt FROM gate_evaluations
      WHERE run_id = ? AND (attempt,checkpoint_seq) = (SELECT attempt,checkpoint_seq FROM gate_evaluations WHERE run_id = ? ORDER BY attempt DESC,checkpoint_seq DESC,created_at DESC LIMIT 1) ORDER BY gate_type`).all(runId, runId) as Array<Omit<GateEvaluation,"passed"|"failures"> & {passed:number;failuresJson:string}>;
    return rows.map(({ failuresJson, ...row }) => ({ ...row, passed: Boolean(row.passed), failures: JSON.parse(failuresJson) as GateEvaluation["failures"] }));
  }

  getProgressSnapshot(runId: RunId): ProgressSnapshot | undefined {
    return this.db.prepare(`SELECT run_id as runId,attempt,checkpoint_seq as checkpointSeq,meaningful_changes as meaningfulChanges,
      consecutive_failures as consecutiveFailures,repeated_operations as repeatedOperations,last_progress_at as lastProgressAt,
      last_decision_id as lastDecisionId,updated_at as updatedAt FROM progress_snapshots WHERE run_id = ?`).get(runId) as ProgressSnapshot | undefined;
  }

  updateProgressSnapshot(run: TaskRun, event: RunEvent): ProgressSnapshot {
    const previous = this.getProgressSnapshot(run.id);
    const toolName = String(event.data.toolName ?? "");
    const progressEvent = event.type === "run.updated" || event.type === "tool.completed" && !event.data.isError && ["write", "edit", "task_run"].includes(toolName);
    const failureEvent = event.type === "tool.completed" && Boolean(event.data.isError) || event.type === "tool.guard.blocked";
    const snapshot: ProgressSnapshot = { runId: run.id, attempt: run.attempt, checkpointSeq: event.seq,
      meaningfulChanges: (previous?.attempt === run.attempt ? previous.meaningfulChanges : 0) + (progressEvent ? 1 : 0),
      consecutiveFailures: failureEvent ? (previous?.attempt === run.attempt ? previous.consecutiveFailures : 0) + 1 : progressEvent ? 0 : previous?.consecutiveFailures ?? 0,
      repeatedOperations: previous?.attempt === run.attempt ? previous.repeatedOperations : 0,
      lastProgressAt: progressEvent ? event.createdAt : previous?.lastProgressAt ?? event.createdAt,
      lastDecisionId: previous?.lastDecisionId ?? "", updatedAt: event.createdAt };
    this.db.prepare(`INSERT INTO progress_snapshots (run_id,attempt,checkpoint_seq,meaningful_changes,consecutive_failures,repeated_operations,last_progress_at,last_decision_id,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET attempt=excluded.attempt,checkpoint_seq=excluded.checkpoint_seq,
      meaningful_changes=excluded.meaningful_changes,consecutive_failures=excluded.consecutive_failures,repeated_operations=excluded.repeated_operations,
      last_progress_at=excluded.last_progress_at,last_decision_id=excluded.last_decision_id,updated_at=excluded.updated_at`).run(snapshot.runId,snapshot.attempt,snapshot.checkpointSeq,snapshot.meaningfulChanges,snapshot.consecutiveFailures,snapshot.repeatedOperations,snapshot.lastProgressAt,snapshot.lastDecisionId,snapshot.updatedAt);
    return snapshot;
  }

  createSpawnProposal(runId: RunId, goal: string, acceptanceCriteria: string[], relation: SpawnProposal["relation"]): SpawnProposal {
    const timestamp = now(); const proposal: SpawnProposal = { id: randomUUID(), runId, goal, acceptanceCriteria, relation, status: "proposed", spawnedRunId: "", createdAt: timestamp, updatedAt: timestamp };
    this.db.prepare("INSERT INTO spawn_proposals (id,run_id,goal,acceptance_json,relation,status,created_at,updated_at) VALUES (?,?,?,?,?,'proposed',?,?)").run(proposal.id,runId,goal,JSON.stringify(acceptanceCriteria),relation,timestamp,timestamp); return proposal;
  }

  listSpawnProposals(runId: RunId, status?: SpawnProposal["status"]): SpawnProposal[] {
    const rows = this.db.prepare(`SELECT id,run_id as runId,goal,acceptance_json as acceptanceJson,relation,status,spawned_run_id as spawnedRunId,created_at as createdAt,updated_at as updatedAt FROM spawn_proposals WHERE run_id = ? ${status ? "AND status = ?" : ""} ORDER BY created_at`).all(runId,...(status?[status]:[])) as Array<Omit<SpawnProposal,"acceptanceCriteria"> & {acceptanceJson:string}>;
    return rows.map(({acceptanceJson,...row})=>({...row,acceptanceCriteria:JSON.parse(acceptanceJson) as string[]}));
  }

  spawnFromProposal(proposalId: string) {
    const transaction = this.db.transaction(() => { const proposal = this.db.prepare("SELECT * FROM spawn_proposals WHERE id = ? AND status IN ('proposed','approved')").get(proposalId) as {id:string;run_id:string;goal:string;relation:SpawnProposal["relation"]}|undefined; if(!proposal) return undefined; const parent=this.getRun(proposal.run_id); if(!parent || (proposal.relation !== "parallel" && parent.status !== "completed")) return undefined; const child=this.createRun(parent.sessionId,proposal.goal,`spawn:${proposal.id}`); const timestamp=now(); this.db.prepare("UPDATE spawn_proposals SET status='spawned',spawned_run_id=?,updated_at=? WHERE id=?").run(child.id,timestamp,proposal.id); this.db.prepare("INSERT INTO taskrun_edges (from_run_id,to_run_id,relation,reason,created_at) VALUES (?,?,?,?,?)").run(parent.id,child.id,proposal.relation,`Spawn proposal ${proposal.id}`,timestamp); return child; }); return transaction();
  }

  listTaskRunEdges(runId: RunId): TaskRunEdge[] { return this.db.prepare(`SELECT from_run_id as fromRunId,to_run_id as toRunId,relation,reason,created_at as createdAt FROM taskrun_edges WHERE from_run_id=? OR to_run_id=? ORDER BY created_at`).all(runId,runId) as TaskRunEdge[]; }

  failSpawnedRun(proposalId: string, runId: RunId, error: string) {
    const transaction = this.db.transaction(() => {
      const timestamp = now();
      const run = this.db.prepare("SELECT last_event_seq as seq FROM runs WHERE id = ? AND status = 'running'").get(runId) as { seq: number } | undefined;
      if (run) {
        const seq = run.seq + 1;
        const data = { error, reason: "spawn_launch_failed", proposalId };
        this.db.prepare("INSERT INTO run_events (run_id,seq,type,data,created_at) VALUES (?,?,'run.failed',?,?)").run(runId, seq, JSON.stringify(data), timestamp);
        this.db.prepare("UPDATE runs SET status = 'failed', phase = 'blocked', blocked_reason = ?, last_event_seq = ?, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(`Spawn launch failed: ${error}`, seq, timestamp, timestamp, runId);
      }
      this.db.prepare("UPDATE spawn_proposals SET status = 'rejected', updated_at = ? WHERE id = ? AND spawned_run_id = ?").run(timestamp, proposalId, runId);
      this.db.prepare("UPDATE taskrun_edges SET reason = reason || ? WHERE to_run_id = ?").run(`; launch failed: ${error}`, runId);
    });
    transaction();
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
