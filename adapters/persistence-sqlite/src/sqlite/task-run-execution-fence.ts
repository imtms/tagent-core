import type Database from "better-sqlite3";
import { SQLITE_DB_TIME_MS } from "./core-writer-lease.js";

export interface TaskRunExecutionFence {
  attemptId: string;
  expectedVersion: number;
  leaseToken: string;
  executionFence: number;
}

export interface TaskRunExecutionScope {
  attemptId: string;
  runId: string;
  ordinal: number;
  sessionId: string;
  attemptVersion: number;
  timestamp: number;
}

export interface TaskRunExecutionFenceValidatorOptions {
  nowSql?: string;
}

interface AttemptRow {
  runId: string;
  ordinal: number;
  status: string;
  active: number;
  version: number;
}

interface ExecutionLeaseRow {
  token: string;
  fence: number;
  attemptVersion: number;
  leaseUntil: number;
  releasedAt: number | null;
}

interface TaskRunRow {
  sessionId: string;
  status: string;
  attempt: number;
}

function assertNonEmpty(value: string, name: string): void {
  if (!value || value.includes("\0")) {
    throw new TypeError(`${name} must be a non-empty string without NUL bytes`);
  }
}

/**
 * Validates the complete runtime execution authority tuple from SQLite state.
 *
 * Callers must invoke this validator inside the exact transaction that performs
 * the protected mutation. The returned TaskRun identity and ordinal are derived
 * from the authoritative Attempt row and must replace any caller supplied scope.
 */
export class TaskRunExecutionFenceValidator {
  private readonly nowSql: string;

  constructor(
    private readonly db: Database.Database,
    options: TaskRunExecutionFenceValidatorOptions = {},
  ) {
    this.nowSql = options.nowSql ?? SQLITE_DB_TIME_MS;
    if (!this.nowSql.trim() || this.nowSql.includes("\0") || this.nowSql.includes(";")) {
      throw new TypeError("TaskRun execution fence nowSql must be a single SQLite expression");
    }
  }

  validate(fence: TaskRunExecutionFence): TaskRunExecutionScope {
    this.validateInput(fence);
    if (!this.db.inTransaction) {
      throw new Error("TaskRun execution fence must be validated inside the protected SQLite transaction");
    }

    const timestamp = (this.db.prepare(`SELECT (${this.nowSql}) value`).get() as { value: number }).value;
    if (!Number.isSafeInteger(timestamp)) throw new Error("TaskRun execution fence database clock is invalid");

    const attempt = this.db.prepare(`SELECT run_id as runId,ordinal,status,active,version
      FROM attempts WHERE id=?`).get(fence.attemptId) as AttemptRow | undefined;
    if (!attempt) throw new Error(`Attempt ${fence.attemptId} does not exist`);
    if (attempt.version !== fence.expectedVersion) {
      throw new Error(`Attempt version mismatch for ${fence.attemptId}`);
    }
    if (attempt.active !== 1 || attempt.status !== "running") {
      throw new Error(`Attempt ${fence.attemptId} is not active and running`);
    }

    const lease = this.db.prepare(`SELECT lease_token as token,fence,attempt_version as attemptVersion,
      lease_until as leaseUntil,released_at as releasedAt FROM execution_leases WHERE attempt_id=?`)
      .get(fence.attemptId) as ExecutionLeaseRow | undefined;
    if (!lease) throw new Error(`Execution lease for Attempt ${fence.attemptId} does not exist`);
    if (lease.token !== fence.leaseToken) {
      throw new Error(`Execution lease token mismatch for Attempt ${fence.attemptId}`);
    }
    if (lease.fence !== fence.executionFence) {
      throw new Error(`Execution lease fence mismatch for Attempt ${fence.attemptId}`);
    }
    if (lease.attemptVersion !== attempt.version) {
      throw new Error(`Execution lease Attempt version mismatch for ${fence.attemptId}`);
    }
    if (lease.releasedAt !== null || lease.leaseUntil <= timestamp) {
      throw new Error(`Execution lease for Attempt ${fence.attemptId} is released or expired`);
    }

    const run = this.db.prepare("SELECT session_id as sessionId,status,attempt FROM runs WHERE id=?")
      .get(attempt.runId) as TaskRunRow | undefined;
    if (!run || run.status !== "running" || run.attempt !== attempt.ordinal) {
      throw new Error(`TaskRun projection is stale for Attempt ${fence.attemptId}`);
    }

    return {
      attemptId: fence.attemptId,
      runId: attempt.runId,
      ordinal: attempt.ordinal,
      sessionId: run.sessionId,
      attemptVersion: attempt.version,
      timestamp,
    };
  }

  private validateInput(fence: TaskRunExecutionFence): void {
    assertNonEmpty(fence.attemptId, "attemptId");
    assertNonEmpty(fence.leaseToken, "leaseToken");
    if (!Number.isSafeInteger(fence.expectedVersion) || fence.expectedVersion <= 0) {
      throw new TypeError("expectedVersion must be a positive safe integer");
    }
    if (!Number.isSafeInteger(fence.executionFence) || fence.executionFence <= 0) {
      throw new TypeError("executionFence must be a positive safe integer");
    }
  }
}
