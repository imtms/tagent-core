import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  CoreWriterLease,
  isWriterAuthorityLostError,
  WRITER_AUTHORITY_TRIGGER_ABORT,
  WriterFenceGuard,
} from "@tagent/persistence-sqlite/writer";
import {
  WriterAuthorityLostError,
  WriterAuthorityUnavailableError,
} from "@tagent/persistence-sqlite/writer";
import { Store } from "@tagent/persistence-sqlite";

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];
const nowSql = "(SELECT value FROM writer_test_clock WHERE id = 1)";

function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE core_writer_lease (
      lock_name TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      fence INTEGER NOT NULL,
      pid INTEGER NOT NULL,
      host TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      released_at INTEGER
    );
    CREATE TABLE writer_test_clock (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
    INSERT INTO writer_test_clock (id, value) VALUES (1, 1000);
    CREATE TABLE guarded_writes (id TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const setNow = (value: number) => db.prepare("UPDATE writer_test_clock SET value = ? WHERE id = 1").run(value);
  const claim = (ownerId: string) => CoreWriterLease.claim(db, { ownerId, pid: process.pid, host: "test-host" }, {
    leaseMs: 20_000,
    heartbeatIntervalMs: 5_000,
    skewMarginMs: 2_000,
    nowSql,
  });
  return { db, setNow, claim };
}

function storeFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "tagent-writer-connection-"));
  temporaryDirectories.push(directory);
  const filename = path.join(directory, "core.sqlite");
  const store = new Store(filename, { deferPostMigrationRecovery: true });
  databases.push(store.db);
  store.db.exec(`
    CREATE TABLE writer_test_clock (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
    INSERT INTO writer_test_clock (id, value) VALUES (1, 1000);
  `);
  const setNow = (value: number) => store.db.prepare("UPDATE writer_test_clock SET value = ? WHERE id = 1").run(value);
  const claim = (db: Database.Database, ownerId: string) => CoreWriterLease.claim(db, {
    ownerId,
    pid: process.pid,
    host: "test-host",
  }, {
    leaseMs: 20_000,
    heartbeatIntervalMs: 5_000,
    skewMarginMs: 2_000,
    nowSql,
  });
  return { filename, store, setNow, claim };
}

function expectConnectionGuardRejection(operation: () => unknown) {
  let rejected: unknown;
  try {
    operation();
  } catch (error) {
    rejected = error;
  }
  expect(isWriterAuthorityLostError(rejected)).toBe(true);
  expect(rejected instanceof Error ? rejected.message : String(rejected)).toContain(WRITER_AUTHORITY_TRIGGER_ABORT);
}

afterEach(() => {
  databases.splice(0).reverse().forEach((db) => db.close());
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("Core writer authority", () => {
  it("claims, heartbeats, releases, and advances the fence for the next owner", () => {
    const { setNow, claim } = fixture();
    const first = claim("owner-a")!;
    expect(first.authority).toMatchObject({ ownerId: "owner-a", fence: 1, acquiredAt: 1_000, heartbeatAt: 1_000, expiresAt: 21_000, releasedAt: null });
    expect(claim("owner-b")).toBeNull();

    setNow(6_000);
    expect(first.heartbeat()).toMatchObject({ ownerId: "owner-a", fence: 1, heartbeatAt: 6_000, expiresAt: 26_000 });
    expect(first.isCurrent()).toBe(true);
    expect(first.release()).toBe(true);
    expect(first.release()).toBe(false);

    const second = claim("owner-b")!;
    expect(second.authority).toMatchObject({ ownerId: "owner-b", fence: 2, acquiredAt: 6_000, releasedAt: null });
  });

  it("takes over only after expiry plus skew margin and fences stale heartbeat and release", () => {
    const { setNow, claim } = fixture();
    const first = claim("owner-a")!;

    setNow(23_000);
    expect(claim("owner-b")).toBeNull();
    setNow(23_001);
    const second = claim("owner-b")!;
    expect(second.authority.fence).toBe(first.authority.fence + 1);
    expect(first.isCurrent({ requireUnexpired: false })).toBe(false);
    expect(() => first.heartbeat()).toThrow(WriterAuthorityLostError);
    expect(first.release()).toBe(false);
    expect(second.isCurrent()).toBe(true);
  });

  it("rejects stale-owner mutations without partial writes and rolls back synchronous failures", () => {
    const { db, setNow, claim } = fixture();
    const first = claim("owner-a")!;
    const staleGuard = new WriterFenceGuard(db, first.authority, { skewMarginMs: 2_000, nowSql });
    setNow(23_001);
    const second = claim("owner-b")!;

    let staleCallbackRan = false;
    expect(() => staleGuard.run((transaction: Database.Database) => {
      staleCallbackRan = true;
      transaction.prepare("INSERT INTO guarded_writes VALUES ('stale', 'forbidden')").run();
    })).toThrow(WriterAuthorityLostError);
    expect(staleCallbackRan).toBe(false);
    expect(db.prepare("SELECT COUNT(*) count FROM guarded_writes").get()).toEqual({ count: 0 });

    const currentGuard = new WriterFenceGuard(db, second.authority, { skewMarginMs: 2_000, nowSql });
    expect(() => currentGuard.run((transaction: Database.Database) => {
      transaction.prepare("INSERT INTO guarded_writes VALUES ('rollback', 'partial')").run();
      throw new Error("fault after mutation");
    })).toThrow("fault after mutation");
    expect(db.prepare("SELECT COUNT(*) count FROM guarded_writes").get()).toEqual({ count: 0 });
  });

  it("rejects async callbacks and rolls back their synchronous prefix", () => {
    const { db, claim } = fixture();
    const lease = claim("owner-a")!;
    const guard = new WriterFenceGuard(db, lease.authority, { skewMarginMs: 2_000, nowSql });

    const asynchronousCallback = async (transaction: Database.Database) => {
      transaction.prepare("INSERT INTO guarded_writes VALUES ('async', 'partial')").run();
    };
    const runFromUntypedCaller = guard.run.bind(guard) as unknown as (callback: typeof asynchronousCallback) => unknown;
    expect(() => runFromUntypedCaller(asynchronousCallback)).toThrow("callbacks must be synchronous");
    expect(db.prepare("SELECT COUNT(*) count FROM guarded_writes").get()).toEqual({ count: 0 });
  });

  it("allows current-owner Store and raw writes while excluding lease lifecycle writes from connection triggers", () => {
    const { store, setNow, claim } = storeFixture();
    const first = claim(store.db, "owner-a")!;
    const guard = new WriterFenceGuard(store.db, first.authority, { skewMarginMs: 2_000, nowSql });

    const installed = guard.installConnectionGuard();
    expect(installed).toMatchObject({ installed: true, triggerCount: installed.tables.length * 3 });
    expect(installed.tables).toContain("sessions");
    expect(installed.tables).not.toContain("core_writer_lease");

    const session = store.createSession("Current owner", "current-owner-session");
    expect(store.db.prepare("UPDATE sessions SET title = ? WHERE id = ?").run("Raw current-owner write", session.id).changes).toBe(1);
    expect(store.getSession(session.id)?.title).toBe("Raw current-owner write");

    setNow(6_000);
    expect(first.heartbeat()).toMatchObject({ ownerId: "owner-a", heartbeatAt: 6_000, expiresAt: 26_000 });
    expect(first.release()).toBe(true);
    const second = claim(store.db, "owner-b")!;
    expect(second.authority.fence).toBe(first.authority.fence + 1);
    expect(second.release()).toBe(true);
  });

  it("rejects stale raw Store contracts across domains and rolls back each whole transaction", () => {
    const { filename, store, setNow, claim } = storeFixture();
    const first = claim(store.db, "owner-a")!;
    const staleGuard = new WriterFenceGuard(store.db, first.authority, { skewMarginMs: 2_000, nowSql });
    const installed = staleGuard.installConnectionGuard();
    const session = store.createSession("Seed session", "seed-session");
    const run = store.createRun(session.id, "Seed run", "seed-run");

    setNow(23_001);
    const currentDb = new Database(filename);
    databases.push(currentDb);
    const current = claim(currentDb, "owner-b")!;
    expect(current.authority.fence).toBe(first.authority.fence + 1);

    const state = () => store.db.prepare(`SELECT host,
      (SELECT COUNT(*) FROM sessions) sessions,
      (SELECT COUNT(*) FROM runs) runs,
      (SELECT COUNT(*) FROM approval_requests) approvals,
      (SELECT COUNT(*) FROM artifacts) artifacts,
      (SELECT COUNT(*) FROM semantic_learning_jobs) learningJobs
      FROM core_writer_lease WHERE lock_name = 'core-writer'`).get();
    const baseline = state();
    const contracts: Array<[string, () => unknown]> = [
      ["Session", () => store.createSession("Stale session", "stale-session")],
      ["TaskRun", () => store.createRun(session.id, "Stale run", "stale-run")],
      ["Approval", () => store.ensureApprovalRequest(run.id, "stale-decision", "Stale approval")],
      ["Evidence", () => store.addArtifact(run.id, { id: "stale-artifact", kind: "text", title: "Stale", content: "forbidden", uri: "" })],
      ["Learning job", () => store.enqueueSemanticLearningJob("user_message", { content: "forbidden" }, "stale-learning-job", run.id, run.attempt)],
    ];

    for (const [contract, mutation] of contracts) {
      expectConnectionGuardRejection(() => store.db.transaction(() => {
        store.db.prepare("UPDATE core_writer_lease SET host = ? WHERE lock_name = 'core-writer'").run(`partial-${contract}`);
        mutation();
      }).immediate());
      expect(state(), `${contract} transaction left partial state`).toEqual(baseline);
    }

    expect(() => staleGuard.refreshConnectionGuard()).toThrow(WriterAuthorityLostError);
    expect(() => staleGuard.removeConnectionGuard()).toThrow(WriterAuthorityLostError);
    expect(staleGuard.connectionGuardSnapshot()).toEqual(installed);
    expectConnectionGuardRejection(() => store.renameSession(session.id, "Still stale"));
    expect(store.getSession(session.id)?.title).toBe("Seed session");
    expect(current.release()).toBe(true);
  });

  it("fails closed on schema drift until refresh and removes guards only for the current owner", () => {
    const { store, claim } = storeFixture();
    const lease = claim(store.db, "owner-a")!;
    const guard = new WriterFenceGuard(store.db, lease.authority, { skewMarginMs: 2_000, nowSql });
    const beforeDrift = guard.installConnectionGuard();
    store.db.exec("CREATE TABLE newly_guarded (id TEXT PRIMARY KEY, value TEXT NOT NULL)");

    expect(guard.connectionGuardSnapshot()).toEqual(beforeDrift);
    expect(() => guard.assertConnectionGuardCurrent()).toThrow(WriterAuthorityUnavailableError);
    let guardedCallbackRan = false;
    expect(() => guard.run(() => {
      guardedCallbackRan = true;
      store.db.prepare("INSERT INTO newly_guarded VALUES ('guard-run', 'forbidden')").run();
    })).toThrow("schema changed");
    expect(guardedCallbackRan).toBe(false);
    expectConnectionGuardRejection(() => store.createSession("Blocked by drift", "schema-drift"));

    const refreshed = guard.refreshConnectionGuard();
    expect(refreshed.tables).toContain("newly_guarded");
    expect(refreshed.triggerCount).toBe(refreshed.tables.length * 3);
    expect(store.db.prepare("INSERT INTO newly_guarded VALUES ('current', 'allowed')").run().changes).toBe(1);

    guard.removeConnectionGuard();
    expect(guard.connectionGuardSnapshot()).toEqual({ installed: false, schemaVersion: null, tables: [], triggerCount: 0 });
    expect(store.createSession("Explicitly unguarded", "removed-guard")).toMatchObject({ title: "Explicitly unguarded" });
    expect(lease.release()).toBe(true);
  });
});
