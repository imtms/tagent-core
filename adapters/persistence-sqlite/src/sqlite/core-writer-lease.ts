import type Database from "better-sqlite3";
import {
  CORE_WRITER_LOCK_NAME,
  DEFAULT_WRITER_HEARTBEAT_MS,
  DEFAULT_WRITER_LEASE_MS,
  DEFAULT_WRITER_SKEW_MARGIN_MS,
  WriterAuthorityLostError,
  type WriterAuthority,
  type WriterOwnerIdentity,
} from "../writer-authority.js";

export const SQLITE_DB_TIME_MS = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";

export interface CoreWriterLeaseOptions {
  lockName?: string;
  leaseMs?: number;
  heartbeatIntervalMs?: number;
  skewMarginMs?: number;
  nowSql?: string;
}

interface ResolvedCoreWriterLeaseOptions {
  lockName: string;
  leaseMs: number;
  heartbeatIntervalMs: number;
  skewMarginMs: number;
  nowSql: string;
}

const LEASE_SELECT = `SELECT lock_name as lockName, owner_id as ownerId, fence, pid, host,
  acquired_at as acquiredAt, heartbeat_at as heartbeatAt, expires_at as expiresAt,
  released_at as releasedAt FROM core_writer_lease WHERE lock_name = ?`;

function resolveOptions(options: CoreWriterLeaseOptions = {}): ResolvedCoreWriterLeaseOptions {
  const resolved = {
    lockName: options.lockName ?? CORE_WRITER_LOCK_NAME,
    leaseMs: options.leaseMs ?? DEFAULT_WRITER_LEASE_MS,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_WRITER_HEARTBEAT_MS,
    skewMarginMs: options.skewMarginMs ?? DEFAULT_WRITER_SKEW_MARGIN_MS,
    nowSql: options.nowSql ?? SQLITE_DB_TIME_MS,
  };
  if (!resolved.lockName) throw new TypeError("Writer lease lockName is required");
  for (const [name, value] of Object.entries({
    leaseMs: resolved.leaseMs,
    heartbeatIntervalMs: resolved.heartbeatIntervalMs,
    skewMarginMs: resolved.skewMarginMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 0 || (name !== "skewMarginMs" && value === 0)) {
      throw new TypeError(`${name} must be a ${name === "skewMarginMs" ? "non-negative" : "positive"} safe integer`);
    }
  }
  if (resolved.heartbeatIntervalMs >= resolved.leaseMs) {
    throw new TypeError("Writer heartbeatIntervalMs must be shorter than leaseMs");
  }
  if (!resolved.nowSql.trim()) throw new TypeError("Writer lease nowSql is required");
  return resolved;
}

function readLease(db: Database.Database, lockName: string): WriterAuthority | null {
  return db.prepare(LEASE_SELECT).get(lockName) as WriterAuthority | undefined ?? null;
}

function assertTopLevelTransaction(db: Database.Database, operation: string): void {
  if (db.inTransaction) throw new Error(`Core writer lease ${operation} cannot run inside an unmanaged SQLite transaction`);
}

export class CoreWriterLease {
  readonly heartbeatIntervalMs: number;
  readonly leaseMs: number;
  readonly skewMarginMs: number;
  private current: WriterAuthority;

  private constructor(
    private readonly db: Database.Database,
    authority: WriterAuthority,
    private readonly options: ResolvedCoreWriterLeaseOptions,
  ) {
    this.current = authority;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs;
    this.leaseMs = options.leaseMs;
    this.skewMarginMs = options.skewMarginMs;
  }

  static claim(
    db: Database.Database,
    owner: WriterOwnerIdentity,
    options: CoreWriterLeaseOptions = {},
  ): CoreWriterLease | null {
    if (!owner.ownerId) throw new TypeError("Writer ownerId is required");
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new TypeError("Writer pid must be a positive safe integer");
    if (!owner.host) throw new TypeError("Writer host is required");
    assertTopLevelTransaction(db, "claim");
    const resolved = resolveOptions(options);
    const claim = db.transaction(() => {
      const dbNow = (db.prepare(`SELECT (${resolved.nowSql}) as value`).get() as { value: number }).value;
      const observed = readLease(db, resolved.lockName);
      if (!observed) {
        db.prepare(`INSERT INTO core_writer_lease
          (lock_name, owner_id, fence, pid, host, acquired_at, heartbeat_at, expires_at, released_at)
          VALUES (?, ?, 1, ?, ?, ?, ?, ?, NULL)`)
          .run(resolved.lockName, owner.ownerId, owner.pid, owner.host, dbNow, dbNow, dbNow + resolved.leaseMs);
        return readLease(db, resolved.lockName);
      }
      if (observed.releasedAt === null && observed.expiresAt + resolved.skewMarginMs >= dbNow) return null;
      const changed = db.prepare(`UPDATE core_writer_lease SET
          owner_id = ?, fence = fence + 1, pid = ?, host = ?,
          acquired_at = (${resolved.nowSql}), heartbeat_at = (${resolved.nowSql}),
          expires_at = (${resolved.nowSql}) + ?, released_at = NULL
        WHERE lock_name = ? AND fence = ?
          AND (released_at IS NOT NULL OR expires_at + ? < (${resolved.nowSql}))`)
        .run(owner.ownerId, owner.pid, owner.host, resolved.leaseMs, resolved.lockName, observed.fence, resolved.skewMarginMs);
      return changed.changes === 1 ? readLease(db, resolved.lockName) : null;
    });
    const authority = claim.immediate();
    return authority ? new CoreWriterLease(db, authority, resolved) : null;
  }

  get authority(): WriterAuthority {
    return { ...this.current };
  }

  snapshot(): WriterAuthority | null {
    return readLease(this.db, this.options.lockName);
  }

  isCurrent(options: { requireUnexpired?: boolean } = {}): boolean {
    const requireUnexpired = options.requireUnexpired ?? true;
    const expiryClause = requireUnexpired
      ? `AND expires_at + ? >= (${this.options.nowSql})`
      : "";
    const params = requireUnexpired
      ? [this.options.lockName, this.current.ownerId, this.current.fence, this.options.skewMarginMs]
      : [this.options.lockName, this.current.ownerId, this.current.fence];
    return Boolean(this.db.prepare(`SELECT 1 FROM core_writer_lease
      WHERE lock_name = ? AND owner_id = ? AND fence = ? AND released_at IS NULL ${expiryClause}`).get(...params));
  }

  heartbeat(): WriterAuthority {
    assertTopLevelTransaction(this.db, "heartbeat");
    const heartbeat = this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE core_writer_lease SET
          heartbeat_at = (${this.options.nowSql}), expires_at = (${this.options.nowSql}) + ?
        WHERE lock_name = ? AND owner_id = ? AND fence = ? AND released_at IS NULL
          AND expires_at + ? >= (${this.options.nowSql})`)
        .run(this.options.leaseMs, this.options.lockName, this.current.ownerId, this.current.fence, this.options.skewMarginMs);
      return changed.changes === 1 ? readLease(this.db, this.options.lockName) : null;
    });
    const authority = heartbeat.immediate();
    if (!authority) throw new WriterAuthorityLostError(
      `Core writer lease heartbeat rejected for ${this.current.ownerId} at fence ${this.current.fence}`,
    );
    this.current = authority;
    return this.authority;
  }

  release(): boolean {
    assertTopLevelTransaction(this.db, "release");
    const release = this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE core_writer_lease SET
          heartbeat_at = (${this.options.nowSql}), expires_at = (${this.options.nowSql}),
          released_at = (${this.options.nowSql})
        WHERE lock_name = ? AND owner_id = ? AND fence = ? AND released_at IS NULL`)
        .run(this.options.lockName, this.current.ownerId, this.current.fence);
      if (changed.changes !== 1) return null;
      return readLease(this.db, this.options.lockName);
    });
    const authority = release.immediate();
    if (!authority) return false;
    this.current = authority;
    return true;
  }
}
