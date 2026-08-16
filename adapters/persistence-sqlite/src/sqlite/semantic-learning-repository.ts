import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { RunId } from "@tagent/execution/domain";

const now = () => Date.now();
type SemanticJobKind = "user_message" | "workflow_eligibility" | "feedback_attribution";

export interface SemanticLearningJobRow {
  id: string;
  kind: SemanticJobKind;
  runId?: string;
  attempt?: number;
  idempotencyKey: string;
  payloadJson: string;
  status: string;
  attempts: number;
  nextRetryAt: number;
  error: string;
  createdAt: number;
  updatedAt: number;
  leaseOwner: string;
  leaseToken: string;
  leaseUntil: number;
  fence: number;
}

/** Persistence for the cross-domain semantic learning queue and judgment cache. */
export class SqliteSemanticLearningRepository {
  constructor(private readonly db: Database.Database) {}

  getLearningSettings(): {
    memoryEnabled: boolean;
    learningEnabled: boolean;
    autoExecutionEnabled: boolean;
    updatedAt: number;
    reason: string;
  } | undefined {
    const row = this.db.prepare(`SELECT memory_enabled as memoryEnabled,
      learning_enabled as learningEnabled, auto_execution_enabled as autoExecutionEnabled,
      updated_at as updatedAt, reason FROM learning_feature_settings WHERE id = 1`).get() as {
        memoryEnabled: number;
        learningEnabled: number;
        autoExecutionEnabled: number;
        updatedAt: number;
        reason: string;
      } | undefined;
    return row ? {
      ...row,
      memoryEnabled: Boolean(row.memoryEnabled),
      learningEnabled: Boolean(row.learningEnabled),
      autoExecutionEnabled: Boolean(row.autoExecutionEnabled),
    } : undefined;
  }

  getSemanticCacheEntry(cacheKey: string, timestamp = now()): {
    cacheKey: string;
    task: string;
    inputHash: string;
    model: string;
    result: unknown;
    createdAt: number;
    expiresAt: number;
  } | undefined {
    const row = this.db.prepare(`SELECT cache_key as cacheKey, task, input_hash as inputHash,
      model, result_json as resultJson, created_at as createdAt, expires_at as expiresAt
      FROM semantic_judgment_cache WHERE cache_key = ?`).get(cacheKey) as {
        cacheKey: string;
        task: string;
        inputHash: string;
        model: string;
        resultJson: string;
        createdAt: number;
        expiresAt: number;
      } | undefined;
    if (!row || row.expiresAt <= timestamp) return undefined;
    try {
      const { resultJson, ...entry } = row;
      return { ...entry, result: JSON.parse(resultJson) as unknown };
    } catch {
      return undefined;
    }
  }

  putSemanticCacheEntry(entry: {
    cacheKey: string;
    task: string;
    inputHash: string;
    model: string;
    result: unknown;
    createdAt: number;
    expiresAt: number;
  }): void {
    this.db.prepare(`INSERT INTO semantic_judgment_cache
      (cache_key, task, input_hash, model, result_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET result_json = excluded.result_json,
        created_at = excluded.created_at, expires_at = excluded.expires_at`).run(
      entry.cacheKey, entry.task, entry.inputHash, entry.model, JSON.stringify(entry.result),
      entry.createdAt, entry.expiresAt,
    );
  }

  deleteExpiredSemanticCacheEntries(timestamp = now(), limit = 1_000): number {
    return this.db.prepare(`DELETE FROM semantic_judgment_cache WHERE cache_key IN
      (SELECT cache_key FROM semantic_judgment_cache WHERE expires_at <= ? LIMIT ?)`)
      .run(timestamp, limit).changes;
  }

  enqueueSemanticLearningJob(
    kind: SemanticJobKind,
    payload: Record<string, unknown>,
    idempotencyKey: string,
    runId?: RunId,
    attempt?: number,
  ) {
    const timestamp = now();
    this.db.prepare(`INSERT OR IGNORE INTO semantic_learning_jobs
      (id,kind,run_id,attempt,idempotency_key,payload_json,status,attempts,next_retry_at,error,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'pending',0,0,'',?,?)`).run(
      randomUUID(), kind, runId ?? null, attempt ?? null, idempotencyKey,
      JSON.stringify(payload), timestamp, timestamp,
    );
    return this.db.prepare("SELECT * FROM semantic_learning_jobs WHERE idempotency_key=?").get(idempotencyKey);
  }

  claimSemanticLearningJobs(owner: string, kinds: SemanticJobKind[], limit = 100, leaseMs = 30_000) {
    if (!kinds.length || limit <= 0) return [];
    const timestamp = now();
    const claimed: SemanticLearningJobRow[] = [];
    this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT id FROM semantic_learning_jobs
        WHERE kind IN (${kinds.map(() => "?").join(",")}) AND next_retry_at<=?
          AND (status IN ('pending','failed') OR (status='processing' AND (lease_until IS NULL OR lease_until<=?)))
        ORDER BY created_at LIMIT ?`).all(...kinds, timestamp, timestamp, limit) as Array<{ id: string }>;
      const select = this.db.prepare(`SELECT id,kind,run_id as runId,attempt,idempotency_key as idempotencyKey,
        payload_json as payloadJson,status,attempts,next_retry_at as nextRetryAt,error,created_at as createdAt,
        updated_at as updatedAt,lease_owner as leaseOwner,lease_token as leaseToken,lease_until as leaseUntil,fence
        FROM semantic_learning_jobs WHERE id=?`);
      for (const row of rows) {
        const token = randomUUID();
        const changed = this.db.prepare(`UPDATE semantic_learning_jobs SET status='processing',attempts=attempts+1,
          lease_owner=?,lease_token=?,lease_until=?,fence=fence+1,updated_at=? WHERE id=?
          AND (status IN ('pending','failed') OR (status='processing' AND (lease_until IS NULL OR lease_until<=?)))`)
          .run(owner, token, timestamp + leaseMs, timestamp, row.id, timestamp).changes;
        if (changed) claimed.push(select.get(row.id) as SemanticLearningJobRow);
      }
    })();
    return claimed;
  }

  renewSemanticLearningJob(id: string, owner: string, token: string, fence: number, leaseMs = 30_000): boolean {
    const timestamp = now();
    return this.db.prepare(`UPDATE semantic_learning_jobs SET lease_until=?,updated_at=?
      WHERE id=? AND status='processing' AND lease_owner=? AND lease_token=? AND fence=? AND lease_until>?`)
      .run(timestamp + leaseMs, timestamp, id, owner, token, fence, timestamp).changes === 1;
  }

  completeSemanticLearningJob(id: string, owner: string, token: string, fence: number): boolean {
    const timestamp = now();
    return this.db.prepare(`UPDATE semantic_learning_jobs SET status='completed',error='',completed_at=?,
      lease_owner='',lease_token='',lease_until=NULL,updated_at=?
      WHERE id=? AND status='processing' AND lease_owner=? AND lease_token=? AND fence=?`)
      .run(timestamp, timestamp, id, owner, token, fence).changes === 1;
  }

  failSemanticLearningJob(id: string, owner: string, token: string, fence: number, attempts: number, error: string) {
    const status = attempts >= 5 ? "dead_letter" : "failed";
    const timestamp = now();
    const retryAt = status === "dead_letter" ? 0 : timestamp + Math.min(60 * 60_000, 2 ** attempts * 5_000);
    const changed = this.db.prepare(`UPDATE semantic_learning_jobs SET status=?,next_retry_at=?,error=?,
      lease_owner='',lease_token='',lease_until=NULL,updated_at=?
      WHERE id=? AND status='processing' AND lease_owner=? AND lease_token=? AND fence=?`)
      .run(status, retryAt, error.slice(0, 4_000), timestamp, id, owner, token, fence).changes;
    return { attempts, status, nextRetryAt: retryAt, changed: changed === 1 };
  }
}
