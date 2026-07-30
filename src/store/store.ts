import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  Artifact,
  CompletionGate,
  Message,
  PlanItem,
  RunCheck,
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
const SCHEMA_VERSION = 1;

export class Store {
  readonly db: Database.Database;

  constructor(filename = process.env.TAGENT_DB ?? "./data/tagent.db") {
    this.db = new Database(filename);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
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
    this.db.prepare(`INSERT INTO schema_meta (id, version, updated_at) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET version = excluded.version, updated_at = excluded.updated_at`)
      .run(SCHEMA_VERSION, now());
    });
    migration();
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
    type RunRow = Omit<TaskRun, "plan" | "checks" | "artifacts" | "continuations" | "completionGate" | "gateRequired" | "usage" | "transcriptCount"> & {
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
    const plan = this.db.prepare(`SELECT item_key as key, title, status, required, position FROM plan_items WHERE run_id = ? ORDER BY position`).all(id) as PlanItem[];
    const checks = this.db.prepare(`SELECT check_key as key, title, status, required, command, evidence, stale FROM run_checks WHERE run_id = ? ORDER BY check_key`).all(id) as RunCheck[];
    const artifacts = this.db.prepare(`SELECT id, run_id as runId, kind, title, content, uri, created_at as createdAt FROM artifacts WHERE run_id = ? ORDER BY created_at`).all(id) as Artifact[];
    const continuations = this.listContinuations(id);
    const { usageInput, usageOutput, usageCacheRead, usageCacheWrite, usageTotalTokens, usageCost, transcriptCount, ...runRow } = row;
    const task: TaskRun = {
      ...runRow,
      gateRequired: Boolean(row.gateRequired),
      usage: { input: usageInput, output: usageOutput, cacheRead: usageCacheRead, cacheWrite: usageCacheWrite, totalTokens: usageTotalTokens, cost: usageCost },
      transcriptCount,
      continuations,
      plan,
      checks,
      artifacts,
      completionGate: { passed: true, failures: [] },
    };
    task.completionGate = this.evaluateGate(task);
    return task;
  }

  getLatestRun(sessionId: SessionId): TaskRun | undefined {
    const row = this.db.prepare("SELECT id FROM runs WHERE session_id = ? ORDER BY updated_at DESC LIMIT 1").get(sessionId) as { id: string } | undefined;
    return row ? this.getRun(row.id) : undefined;
  }

  getActiveRun(sessionId: SessionId): TaskRun | undefined {
    const row = this.db.prepare("SELECT id FROM runs WHERE session_id = ? AND status = 'running' ORDER BY updated_at DESC LIMIT 1").get(sessionId) as { id: string } | undefined;
    return row ? this.getRun(row.id) : undefined;
  }

  recoverContinuationsAfterRestart() {
    const transaction = this.db.transaction(() => {
      const active = this.db.prepare("SELECT id, run_id as runId, ordinal FROM run_continuations WHERE status IN ('queued', 'running') ORDER BY created_at").all() as Array<{ id: string; runId: string; ordinal: number }>;
      const timestamp = now();
      for (const item of active) {
        this.db.prepare("UPDATE run_continuations SET status = 'queued', error = 'Recovered after service restart', started_at = NULL, completed_at = NULL WHERE id = ?").run(item.id);
        this.db.prepare("UPDATE runs SET status = 'blocked', phase = 'blocked', blocked_reason = 'Continuation recovered after service restart', completed_at = NULL, updated_at = ? WHERE id = ? AND status IN ('running', 'interrupted', 'blocked')")
          .run(timestamp, item.runId);
      }
      return active;
    });
    return transaction();
  }

  listContinuations(runId: RunId): RunContinuation[] {
    return this.db.prepare(`SELECT id, run_id as runId, ordinal, status, reason, error,
      created_at as createdAt, started_at as startedAt, completed_at as completedAt
      FROM run_continuations WHERE run_id = ? ORDER BY ordinal`).all(runId) as RunContinuation[];
  }

  queueContinuation(runId: RunId, reason: string): RunContinuation {
    const timestamp = now();
    const row = this.db.prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 as ordinal FROM run_continuations WHERE run_id = ?").get(runId) as { ordinal: number };
    const continuation: RunContinuation = { id: randomUUID(), runId, ordinal: row.ordinal, status: "queued", reason, error: "", createdAt: timestamp, startedAt: null, completedAt: null };
    this.db.prepare("INSERT INTO run_continuations (id, run_id, ordinal, status, reason, created_at) VALUES (?, ?, ?, 'queued', ?, ?)")
      .run(continuation.id, runId, continuation.ordinal, reason, timestamp);
    return continuation;
  }

  updateContinuation(id: string, status: RunContinuation["status"], error = "") {
    const timestamp = now();
    const startedAt = status === "running" ? timestamp : null;
    const completedAt = ["completed", "blocked", "failed", "cancelled"].includes(status) ? timestamp : null;
    this.db.prepare(`UPDATE run_continuations SET status = ?, error = ?,
      started_at = COALESCE(started_at, ?), completed_at = COALESCE(?, completed_at) WHERE id = ?`)
      .run(status, error, startedAt, completedAt, id);
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

  setRunPhase(runId: RunId, phase: RunPhase) {
    this.db.prepare("UPDATE runs SET phase = ?, updated_at = ? WHERE id = ?").run(phase, now(), runId);
  }

  upsertPlanItem(runId: RunId, item: Omit<PlanItem, "runId">) {
    this.db.prepare(`
      INSERT INTO plan_items (run_id, item_key, title, status, required, position) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, item_key) DO UPDATE SET title=excluded.title, status=excluded.status, required=excluded.required, position=excluded.position
    `).run(runId, item.key, item.title, item.status, Number(item.required), item.position);
    this.db.prepare("UPDATE runs SET updated_at = ? WHERE id = ?").run(now(), runId);
  }

  upsertCheck(runId: RunId, check: RunCheck) {
    this.db.prepare(`
      INSERT INTO run_checks (run_id, check_key, title, status, required, command, evidence, stale) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, check_key) DO UPDATE SET title=excluded.title, status=excluded.status, required=excluded.required, command=excluded.command, evidence=excluded.evidence, stale=excluded.stale
    `).run(runId, check.key, check.title, check.status, Number(check.required), check.command, check.evidence, Number(check.stale));
    this.db.prepare("UPDATE runs SET updated_at = ? WHERE id = ?").run(now(), runId);
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

  finalizeRun(runId: RunId, status: Exclude<RunStatus, "running" | "interrupted" | "blocked">, reason = "") {
    const completedAt = status === "completed" || status === "cancelled" || status === "failed" ? now() : null;
    this.db.prepare("UPDATE runs SET status = ?, blocked_reason = ?, completed_at = ?, updated_at = ? WHERE id = ?")
      .run(status, reason, completedAt, now(), runId);
  }

  blockRun(runId: RunId, reason: string) {
    this.db.prepare("UPDATE runs SET status = 'blocked', phase = 'blocked', blocked_reason = ?, updated_at = ? WHERE id = ?")
      .run(reason, now(), runId);
  }

  markInterrupted() {
    this.db.prepare("UPDATE runs SET status = 'interrupted', blocked_reason = 'Service restarted before the run reached a terminal state', updated_at = ? WHERE status = 'running'")
      .run(now());
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

  completeWithGate(runId: RunId, response: string) {
    const run = this.getRun(runId);
    if (!run) throw new Error("Run not found");
    const gate = this.evaluateGate(run);
    this.appendEvent(runId, gate.passed ? "run.completed" : "run.blocked", { response, gate });
    if (gate.passed) this.finalizeRun(runId, "completed");
    else this.blockRun(runId, gate.failures.map((failure) => `${failure.key}: ${failure.reason}`).join("; "));
    return { gate, run: this.getRun(runId)! };
  }
}
