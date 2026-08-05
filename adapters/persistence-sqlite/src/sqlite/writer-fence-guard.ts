import type Database from "better-sqlite3";
import type { MutationUnitOfWork, SynchronousResult } from "../unit-of-work.js";
import {
  DEFAULT_WRITER_SKEW_MARGIN_MS,
  WriterAuthorityLostError,
  WriterAuthorityUnavailableError,
  type WriterAuthority,
} from "../writer-authority.js";
import { SQLITE_DB_TIME_MS } from "./core-writer-lease.js";

export const WRITER_AUTHORITY_TRIGGER_ABORT = "TAGENT_WRITER_AUTHORITY_LOST";

export interface WriterFenceGuardOptions {
  skewMarginMs?: number;
  nowSql?: string;
}

export interface WriterConnectionGuardSnapshot {
  installed: boolean;
  schemaVersion: number | null;
  tables: string[];
  triggerCount: number;
}

interface InstalledConnectionGuard {
  schemaVersion: number;
  tables: string[];
  triggerNames: string[];
}

const MANAGED_TRIGGER_PREFIX = "__tagent_writer_guard_";
const GUARDED_OPERATIONS = ["INSERT", "UPDATE", "DELETE"] as const;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isWriterAuthorityLostError(error: unknown): boolean {
  return error instanceof WriterAuthorityLostError || errorMessage(error).includes(WRITER_AUTHORITY_TRIGGER_ABORT);
}

export function normalizeWriterAuthorityError(error: unknown): unknown {
  if (error instanceof WriterAuthorityLostError) return error;
  if (!isWriterAuthorityLostError(error)) return error;
  return new WriterAuthorityLostError("SQLite connection rejected a mutation from a stale or expired writer", { cause: error });
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === "object" && value !== null || typeof value === "function")
    && typeof (value as { then?: unknown }).then === "function";
}

function isAsyncFunction(value: (...args: never[]) => unknown): boolean {
  return value.constructor?.name === "AsyncFunction" || Object.prototype.toString.call(value) === "[object AsyncFunction]";
}

type GuardedCallback<T> = (() => T) | ((db: Database.Database) => T);

export class WriterFenceGuard implements MutationUnitOfWork {
  readonly authority: Readonly<WriterAuthority>;
  private readonly skewMarginMs: number;
  private readonly nowSql: string;
  private depth = 0;
  private installedConnectionGuard: InstalledConnectionGuard | null = null;

  constructor(
    private readonly db: Database.Database,
    authority: WriterAuthority,
    options: WriterFenceGuardOptions = {},
  ) {
    this.authority = Object.freeze({ ...authority });
    this.skewMarginMs = options.skewMarginMs ?? DEFAULT_WRITER_SKEW_MARGIN_MS;
    this.nowSql = options.nowSql ?? SQLITE_DB_TIME_MS;
    if (!Number.isSafeInteger(this.skewMarginMs) || this.skewMarginMs < 0) {
      throw new TypeError("Writer fence skewMarginMs must be a non-negative safe integer");
    }
    if (!this.nowSql.trim() || this.nowSql.includes("\0") || this.nowSql.includes(";")) {
      throw new TypeError("Writer fence nowSql must be a single SQLite expression");
    }
    if (!this.authority.lockName || this.authority.lockName.includes("\0")
      || !this.authority.ownerId || this.authority.ownerId.includes("\0")
      || !Number.isSafeInteger(this.authority.fence) || this.authority.fence <= 0) {
      throw new TypeError("Writer fence authority is invalid");
    }
  }

  assertCurrent(options: { requireUnexpired?: boolean } = {}): void {
    const requireUnexpired = options.requireUnexpired ?? true;
    const expiryClause = requireUnexpired
      ? `AND expires_at + ? >= (${this.nowSql})`
      : "";
    const params = requireUnexpired
      ? [this.authority.lockName, this.authority.ownerId, this.authority.fence, this.skewMarginMs]
      : [this.authority.lockName, this.authority.ownerId, this.authority.fence];
    const current = this.db.prepare(`SELECT 1 FROM core_writer_lease
      WHERE lock_name = ? AND owner_id = ? AND fence = ? AND released_at IS NULL ${expiryClause}`).get(...params);
    if (!current) throw new WriterAuthorityLostError(
      `Core writer authority lost for ${this.authority.ownerId} at fence ${this.authority.fence}`,
    );
  }

  run<T>(callback: () => T & SynchronousResult<T>): T;
  run<T>(callback: (db: Database.Database) => T & SynchronousResult<T>): T;
  run<T>(callback: GuardedCallback<T>): T {
    if (this.depth > 0) return this.invokeSynchronous(callback);
    if (this.db.inTransaction) {
      throw new Error("WriterFenceGuard cannot enter an unmanaged SQLite transaction");
    }
    const guarded = this.db.transaction(() => {
      this.depth += 1;
      try {
        if (this.installedConnectionGuard) this.assertConnectionGuardCurrent();
        this.assertCurrent();
        return this.invokeSynchronous(callback);
      } finally {
        this.depth -= 1;
      }
    });
    try {
      return guarded.immediate();
    } catch (error) {
      throw normalizeWriterAuthorityError(error);
    }
  }

  installConnectionGuard(): WriterConnectionGuardSnapshot {
    this.assertTopLevel("install connection guard");
    if (this.installedConnectionGuard) {
      this.assertConnectionGuardCurrent();
      return this.connectionGuardSnapshot();
    }
    const install = this.db.transaction(() => {
      this.assertCurrent();
      const existing = this.listManagedTriggers();
      if (existing.length) {
        throw new WriterAuthorityUnavailableError("SQLite connection already has an unmanaged writer trigger set");
      }
      return this.createConnectionGuard();
    });
    try {
      this.installedConnectionGuard = install.immediate();
      return this.connectionGuardSnapshot();
    } catch (error) {
      throw normalizeWriterAuthorityError(error);
    }
  }

  refreshConnectionGuard(): WriterConnectionGuardSnapshot {
    this.assertTopLevel("refresh connection guard");
    if (!this.installedConnectionGuard) return this.installConnectionGuard();
    const refresh = this.db.transaction(() => {
      this.assertCurrent();
      this.dropTriggers(this.listManagedTriggers());
      return this.createConnectionGuard();
    });
    try {
      this.installedConnectionGuard = refresh.immediate();
      return this.connectionGuardSnapshot();
    } catch (error) {
      throw normalizeWriterAuthorityError(error);
    }
  }

  removeConnectionGuard(): void {
    this.assertTopLevel("remove connection guard");
    if (!this.installedConnectionGuard) return;
    const remove = this.db.transaction(() => {
      this.assertCurrent();
      this.dropTriggers(this.listManagedTriggers());
    });
    try {
      remove.immediate();
      this.installedConnectionGuard = null;
    } catch (error) {
      throw normalizeWriterAuthorityError(error);
    }
  }

  assertConnectionGuardCurrent(): void {
    const installed = this.installedConnectionGuard;
    if (!installed) throw new WriterAuthorityUnavailableError("SQLite connection writer guard is not installed");
    const schemaVersion = this.schemaVersion();
    if (schemaVersion !== installed.schemaVersion) {
      throw new WriterAuthorityUnavailableError(
        `SQLite main schema changed from ${installed.schemaVersion} to ${schemaVersion}; refreshConnectionGuard() is required`,
      );
    }
    const actual = this.listManagedTriggers();
    if (actual.length !== installed.triggerNames.length
      || actual.some((name, index) => name !== installed.triggerNames[index])) {
      throw new WriterAuthorityUnavailableError("SQLite connection writer trigger set was modified; refusing unguarded mutations");
    }
  }

  connectionGuardSnapshot(): WriterConnectionGuardSnapshot {
    const installed = this.installedConnectionGuard;
    return installed
      ? { installed: true, schemaVersion: installed.schemaVersion, tables: [...installed.tables], triggerCount: installed.triggerNames.length }
      : { installed: false, schemaVersion: null, tables: [], triggerCount: 0 };
  }

  private invokeSynchronous<T>(callback: GuardedCallback<T>): T {
    if (isAsyncFunction(callback)) throw new TypeError("WriterFenceGuard callbacks must be synchronous");
    const result = (callback as (db: Database.Database) => T)(this.db);
    if (isThenable(result)) throw new TypeError("WriterFenceGuard callbacks must be synchronous");
    return result;
  }

  private assertTopLevel(operation: string): void {
    if (this.depth > 0 || this.db.inTransaction) {
      throw new Error(`WriterFenceGuard cannot ${operation} inside an active SQLite transaction`);
    }
  }

  private schemaVersion(): number {
    return this.db.pragma("main.schema_version", { simple: true }) as number;
  }

  private listMainApplicationTables(): string[] {
    return (this.db.prepare(`SELECT name FROM main.sqlite_schema
      WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'core_writer_lease'
      ORDER BY name`).all() as Array<{ name: string }>).map((row) => row.name);
  }

  private listManagedTriggers(): string[] {
    return (this.db.prepare(`SELECT name FROM temp.sqlite_schema
      WHERE type = 'trigger' AND name GLOB ? ORDER BY name`)
      .all(`${MANAGED_TRIGGER_PREFIX}*`) as Array<{ name: string }>).map((row) => row.name);
  }

  private createConnectionGuard(): InstalledConnectionGuard {
    const schemaVersion = this.schemaVersion();
    const tables = this.listMainApplicationTables();
    const triggerNames: string[] = [];
    const lockName = quoteLiteral(this.authority.lockName);
    const ownerId = quoteLiteral(this.authority.ownerId);
    for (const [tableIndex, table] of tables.entries()) {
      for (const operation of GUARDED_OPERATIONS) {
        const triggerName = `${MANAGED_TRIGGER_PREFIX}${String(tableIndex).padStart(4, "0")}_${operation.toLowerCase()}`;
        this.db.exec(`CREATE TEMP TRIGGER ${quoteIdentifier(triggerName)}
          BEFORE ${operation} ON main.${quoteIdentifier(table)}
          BEGIN
            SELECT CASE WHEN NOT EXISTS (
              SELECT 1 FROM main.core_writer_lease
              WHERE lock_name = ${lockName}
                AND owner_id = ${ownerId}
                AND fence = ${this.authority.fence}
                AND released_at IS NULL
                AND expires_at + ${this.skewMarginMs} >= (${this.nowSql})
                AND (SELECT schema_version FROM pragma_schema_version) = ${schemaVersion}
            ) THEN RAISE(ABORT, '${WRITER_AUTHORITY_TRIGGER_ABORT}') END;
          END`);
        triggerNames.push(triggerName);
      }
    }
    return { schemaVersion, tables, triggerNames: triggerNames.sort() };
  }

  private dropTriggers(triggerNames: string[]): void {
    for (const triggerName of triggerNames) {
      this.db.exec(`DROP TRIGGER IF EXISTS temp.${quoteIdentifier(triggerName)}`);
    }
  }
}
