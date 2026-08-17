import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  Message,
  ReasoningEffort,
  Session,
  SessionId,
  SessionSettingsUpdate,
} from "@tagent/admission/domain";
import type { RunPhase, RunStatus } from "@tagent/execution/domain";

const now = () => Date.now();
const REASONING_EFFORTS = new Set<ReasoningEffort>(["minimal", "low", "medium", "high", "xhigh", "max"]);

interface OperatorSessionReadRow {
  id: string;
  title: string;
  modelId: string;
  reasoningEffort: ReasoningEffort;
  createdAt: number;
  updatedAt: number;
  latestTaskRunId: string | null;
  latestTaskRunStatus: RunStatus | null;
  latestTaskRunPhase: RunPhase | null;
  latestActivityAt: number;
}

interface OperatorReadPageQuery {
  snapshotRowId?: number;
  after?: { createdAt: number; id: string };
  limit: number;
}

export class SqliteSessionRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly defaultModelId: string,
  ) {}

  createSession(title = "New workspace", requestId?: string): Session {
    return this.db.transaction(() => {
      if (requestId) {
        const existing = this.db.prepare("SELECT session_id as sessionId FROM session_requests WHERE request_id = ?").get(requestId) as { sessionId: string } | undefined;
        if (existing) return this.getSession(existing.sessionId)!;
      }
      const timestamp = now();
      const session: Session = {
        id: randomUUID(),
        title,
        modelId: this.defaultModelId,
        reasoningEffort: "medium",
        createdAt: timestamp,
        updatedAt: timestamp,
        latestRunStatus: null,
        latestRunPhase: null,
      };
      this.db.prepare("INSERT INTO sessions (id, title, model_id, reasoning_effort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(session.id, session.title, session.modelId, session.reasoningEffort, timestamp, timestamp);
      this.initializeProfileRevisions(session.id, timestamp);
      if (requestId) this.db.prepare("INSERT INTO session_requests (request_id,session_id,created_at) VALUES (?,?,?)").run(requestId, session.id, timestamp);
      return session;
    })();
  }

  createSessionIdempotent(input: {
    title: string;
    principalId: string;
    idempotencyKey: string;
    canonicalPayload: string;
    provenance?: Record<string, unknown>;
  }): { session: Session; replayed: boolean } {
    const payloadHash = createHash("sha256").update(input.canonicalPayload).digest("hex");
    const readReceipt = () => this.db.prepare(`SELECT payload_hash as payloadHash,session_id as sessionId
      FROM session_create_receipts WHERE principal_id=? AND idempotency_key=?`)
      .get(input.principalId, input.idempotencyKey) as { payloadHash: string; sessionId: string } | undefined;
    const replay = (existing: { payloadHash: string; sessionId: string }) => {
      if (existing.payloadHash !== payloadHash) throw new Error("Session idempotency conflict: key is bound to a different canonical payload");
      const session = this.getSession(existing.sessionId);
      if (!session) throw new Error("Session idempotency receipt references a missing Session");
      return { session, replayed: true };
    };
    const create = this.db.transaction(() => {
      const existing = readReceipt();
      if (existing) return replay(existing);
      const timestamp = now();
      const session: Session = {
        id: randomUUID(),
        title: input.title,
        modelId: this.defaultModelId,
        reasoningEffort: "medium",
        createdAt: timestamp,
        updatedAt: timestamp,
        latestRunStatus: null,
        latestRunPhase: null,
      };
      this.db.prepare("INSERT INTO sessions (id,title,model_id,reasoning_effort,created_at,updated_at) VALUES (?,?,?,?,?,?)")
        .run(session.id, session.title, session.modelId, session.reasoningEffort, timestamp, timestamp);
      this.initializeProfileRevisions(session.id, timestamp);
      this.db.prepare(`INSERT INTO session_create_receipts
        (principal_id,idempotency_key,payload_hash,canonical_payload_json,session_id,provenance_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        input.principalId,
        input.idempotencyKey,
        payloadHash,
        input.canonicalPayload,
        session.id,
        JSON.stringify(input.provenance ?? {}),
        timestamp,
        timestamp,
      );
      return { session, replayed: false };
    });
    try {
      return create();
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) {
        const existing = readReceipt();
        if (existing) return replay(existing);
      }
      throw error;
    }
  }

  listSessions(): Session[] {
    return this.db.prepare(`
      SELECT sessions.id, sessions.title, sessions.model_id as modelId, sessions.reasoning_effort as reasoningEffort,
        sessions.created_at as createdAt, sessions.updated_at as updatedAt,
        latest.status as latestRunStatus, latest.phase as latestRunPhase
      FROM sessions
      LEFT JOIN runs latest ON latest.id = (
        SELECT runs.id FROM runs WHERE runs.session_id = sessions.id ORDER BY runs.updated_at DESC, runs.id DESC LIMIT 1
      )
      ORDER BY sessions.updated_at DESC
    `).all() as Session[];
  }

  listOperatorSessionsPage(query: OperatorReadPageQuery): { items: OperatorSessionReadRow[]; snapshotRowId: number } {
    const snapshotRowId = query.snapshotRowId ?? Number(this.db.prepare("SELECT COALESCE(MAX(rowid),0) FROM sessions").pluck().get());
    const afterClause = query.after
      ? "AND (sessions.created_at < @afterCreatedAt OR (sessions.created_at = @afterCreatedAt AND sessions.id < @afterId))"
      : "";
    const items = this.db.prepare(`
      SELECT sessions.id,sessions.title,sessions.model_id as modelId,sessions.reasoning_effort as reasoningEffort,
        sessions.created_at as createdAt,sessions.updated_at as updatedAt,
        latest.id as latestTaskRunId,latest.status as latestTaskRunStatus,latest.phase as latestTaskRunPhase,
        CASE WHEN latest.updated_at IS NOT NULL AND latest.updated_at > sessions.updated_at
          THEN latest.updated_at ELSE sessions.updated_at END as latestActivityAt
      FROM sessions
      LEFT JOIN runs latest ON latest.rowid = (
        SELECT candidate.rowid FROM runs candidate WHERE candidate.session_id=sessions.id
        ORDER BY candidate.updated_at DESC,candidate.id DESC LIMIT 1
      )
      WHERE sessions.rowid <= @snapshotRowId ${afterClause}
      ORDER BY sessions.created_at DESC,sessions.id DESC LIMIT @limit
    `).all({
      snapshotRowId,
      limit: query.limit,
      ...(query.after ? { afterCreatedAt: query.after.createdAt, afterId: query.after.id } : {}),
    }) as OperatorSessionReadRow[];
    return { items, snapshotRowId };
  }

  getSession(id: SessionId): Session | undefined {
    return this.db.prepare(`
      SELECT sessions.id, sessions.title, sessions.model_id as modelId, sessions.reasoning_effort as reasoningEffort,
        sessions.created_at as createdAt, sessions.updated_at as updatedAt,
        latest.status as latestRunStatus, latest.phase as latestRunPhase
      FROM sessions
      LEFT JOIN runs latest ON latest.id = (
        SELECT runs.id FROM runs WHERE runs.session_id = sessions.id ORDER BY runs.updated_at DESC, runs.id DESC LIMIT 1
      )
      WHERE sessions.id = ?
    `).get(id) as Session | undefined;
  }

  getSessionPrincipalId(sessionId: SessionId): string | undefined {
    const row = this.db.prepare(`
      SELECT principalId FROM (
        SELECT principal_id AS principalId, 0 AS sourcePriority, created_at AS createdAt
        FROM session_create_receipts WHERE session_id = ?
        UNION ALL
        SELECT principal_id AS principalId, 1 AS sourcePriority, created_at AS createdAt
        FROM submission_audit_receipts WHERE session_id = ?
      )
      ORDER BY sourcePriority ASC, createdAt ASC
      LIMIT 1
    `).get(sessionId, sessionId) as { principalId: string } | undefined;
    return row?.principalId;
  }

  updateSession(id: SessionId, settings: SessionSettingsUpdate): Session | undefined {
    const current = this.getSession(id);
    if (!current) return undefined;
    const title = settings.title === undefined ? current.title : settings.title.trim();
    const modelId = settings.modelId === undefined ? current.modelId : settings.modelId.trim();
    const reasoningEffort = settings.reasoningEffort ?? current.reasoningEffort;
    if (!title || !modelId || !REASONING_EFFORTS.has(reasoningEffort)) return undefined;
    this.db.prepare("UPDATE sessions SET title = ?, model_id = ?, reasoning_effort = ?, revision=revision+1, updated_at = ? WHERE id = ?")
      .run(title, modelId, reasoningEffort, now(), id);
    return this.getSession(id);
  }

  renameSession(id: SessionId, title: string): Session | undefined {
    return this.updateSession(id, { title });
  }

  listMessages(sessionId: SessionId, limit = 200, beforeId?: number): Message[] {
    const boundary = beforeId && Number.isFinite(beforeId) ? Math.max(1, Math.floor(beforeId)) : Number.MAX_SAFE_INTEGER;
    return this.db.prepare(`
      SELECT id, sessionId, role, content, createdAt FROM (
        SELECT id, session_id as sessionId, role, content, created_at as createdAt
        FROM messages WHERE session_id = ? AND id < ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(sessionId, boundary, limit) as Message[];
  }

  listRecentMessages(sessionId: SessionId, limit = 200): Message[] {
    return this.db.prepare(`
      SELECT id, sessionId, role, content, createdAt FROM (
        SELECT id, session_id as sessionId, role, content, created_at as createdAt
        FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?
      ) ORDER BY id ASC
    `).all(sessionId, limit) as Message[];
  }

  appendMessage(sessionId: SessionId, role: Message["role"], content: string): Message {
    const createdAt = now();
    const result = this.db.prepare("INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(sessionId, role, content, createdAt);
    this.touchSession(sessionId);
    return { id: Number(result.lastInsertRowid), sessionId, role, content, createdAt };
  }

  getMessageSource(id: number): Pick<Message, "id" | "role" | "content"> | undefined {
    return this.db.prepare("SELECT id, role, content FROM messages WHERE id = ?").get(id) as
      Pick<Message, "id" | "role" | "content"> | undefined;
  }

  listDurableUserMessagesPage(afterId: number, limit: number): Array<Pick<Message, "id" | "content"> & { sessionId: string; principalId: string | null }> {
    return this.db.prepare(`
      SELECT messages.id, messages.content, messages.session_id AS sessionId,
        COALESCE(
          (SELECT principal_id FROM session_create_receipts WHERE session_id = messages.session_id ORDER BY created_at LIMIT 1),
          (SELECT principal_id FROM submission_audit_receipts WHERE session_id = messages.session_id ORDER BY created_at LIMIT 1)
        ) AS principalId
      FROM messages WHERE role = 'user' AND messages.id > ? ORDER BY messages.id ASC LIMIT ?
    `).all(afterId, limit) as Array<Pick<Message, "id" | "content"> & { sessionId: string; principalId: string | null }>;
  }

  touchSession(id: SessionId): void {
    this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now(), id);
  }

  private initializeProfileRevisions(id: SessionId, timestamp: number): void {
    this.db.prepare("INSERT OR IGNORE INTO workspace_skill_revisions (workspace_id,revision,updated_at) VALUES (?,1,?)")
      .run(id, timestamp);
    this.db.prepare("INSERT OR IGNORE INTO session_inbox_revisions (session_id,revision,updated_at) VALUES (?,1,?)")
      .run(id, timestamp);
  }
}
