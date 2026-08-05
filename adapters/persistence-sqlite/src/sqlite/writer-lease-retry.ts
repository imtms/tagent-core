import type Database from "better-sqlite3";
import {
  CORE_WRITER_LOCK_NAME,
  DEFAULT_WRITER_LEASE_MS,
  DEFAULT_WRITER_SKEW_MARGIN_MS,
  WriterAuthorityUnavailableError,
  type WriterOwnerIdentity,
} from "../writer-authority.js";
import {
  CoreWriterLease,
  SQLITE_DB_TIME_MS,
  type CoreWriterLeaseOptions,
} from "./core-writer-lease.js";
import { WriterFenceGuard } from "./writer-fence-guard.js";

export interface SqliteConnectionProvider {
  readonly db: Database.Database;
}

export interface CoreWriterConnection {
  writerLease: CoreWriterLease;
  writerGuard: WriterFenceGuard;
}

export interface CoreWriterLeaseClaimRetryOptions extends CoreWriterLeaseOptions {
  maxWaitMs?: number;
  retryIntervalMs?: number;
  clock?: () => number;
  sleep?: (delayMs: number) => Promise<void>;
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function claimCoreWriterLeaseWithRetry(
  db: Database.Database,
  owner: WriterOwnerIdentity,
  options: CoreWriterLeaseClaimRetryOptions = {},
): Promise<CoreWriterLease> {
  const {
    maxWaitMs = (options.leaseMs ?? DEFAULT_WRITER_LEASE_MS)
      + (options.skewMarginMs ?? DEFAULT_WRITER_SKEW_MARGIN_MS) + 1_000,
    retryIntervalMs = 250,
    clock = Date.now,
    sleep = delay,
    ...leaseOptions
  } = options;
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0) {
    throw new TypeError("Writer lease maxWaitMs must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(retryIntervalMs) || retryIntervalMs <= 0) {
    throw new TypeError("Writer lease retryIntervalMs must be a positive safe integer");
  }

  const startedAt = clock();
  while (true) {
    const lease = CoreWriterLease.claim(db, owner, leaseOptions);
    if (lease) return lease;

    const elapsed = Math.max(0, clock() - startedAt);
    const remainingBudget = maxWaitMs - elapsed;
    if (remainingBudget <= 0) break;

    const nowSql = leaseOptions.nowSql ?? SQLITE_DB_TIME_MS;
    const lockName = leaseOptions.lockName ?? CORE_WRITER_LOCK_NAME;
    const observed = db.prepare(`SELECT expires_at as expiresAt, (${nowSql}) as dbNow
      FROM core_writer_lease WHERE lock_name = ? AND released_at IS NULL`).get(lockName) as
      { expiresAt: number; dbNow: number } | undefined;
    const remainingLease = observed
      ? Math.max(1, observed.expiresAt + (leaseOptions.skewMarginMs ?? DEFAULT_WRITER_SKEW_MARGIN_MS) - observed.dbNow + 1)
      : 1;
    await sleep(Math.min(retryIntervalMs, remainingLease, remainingBudget));
  }

  throw new WriterAuthorityUnavailableError(
    `Core writer lease remained unavailable after ${maxWaitMs}ms bounded recovery wait`,
  );
}

export async function claimCoreWriterConnectionWithRetry(
  connection: SqliteConnectionProvider,
  owner: WriterOwnerIdentity,
  options: CoreWriterLeaseClaimRetryOptions = {},
): Promise<CoreWriterConnection> {
  const writerLease = await claimCoreWriterLeaseWithRetry(connection.db, owner, options);
  return {
    writerLease,
    writerGuard: new WriterFenceGuard(connection.db, writerLease.authority, {
      skewMarginMs: options.skewMarginMs,
      nowSql: options.nowSql,
    }),
  };
}
