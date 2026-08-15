import { createServer, type Server } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "@tagent/http-fastify";
import { loadConfig, type AppConfig } from "@tagent/core-service/config";
import { CoreApplicationCoordinator, createCoreApplication } from "@tagent/core-service/application";
import {
  CoreHeartbeatDeadlineError,
  CoreLifecycle,
  type CoreEventLoopDelayMonitor,
  type CoreLifecycleResources,
} from "@tagent/core-service/composition";
import { DistillationWorker } from "@tagent/learning";
import { acquireCoreInstanceLock, CoreInstanceLock, CoreWriterLease, WriterFenceGuard, claimCoreWriterLeaseWithRetry } from "@tagent/persistence-sqlite/writer";
import {
  bootstrapCore,
  type BootstrappedCore,
  type CoreBackgroundWorkerStarter,
} from "@tagent/core-service";
import { Store } from "@tagent/persistence-sqlite/store";
import { corePersistence, httpPersistence } from "./support/test-persistence.js";
import { credentialReference } from "@tagent/execution/ports";

const temporaryDirectories: string[] = [];
const cores: BootstrappedCore[] = [];
const databases: Database.Database[] = [];
const stores: Store[] = [];
const occupiedServers: Server[] = [];
const nowSql = "(SELECT value FROM writer_test_clock WHERE id = 1)";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function temporaryConfig(overrides: Partial<AppConfig> = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "tagent-core-lifecycle-"));
  temporaryDirectories.push(directory);
  const defaults = loadConfig({});
  return {
    ...defaults,
    host: "127.0.0.1",
    port: 0,
    database: path.join(directory, "core.sqlite"),
    workspace: path.join(directory, "workspace"),
    apiCredentialReference: credentialReference("PATH"),
    apiCredentialConfigured: true,
    memory: { enabled: false },
    learning: {
      ...defaults.learning,
      enabledByDefault: false,
      semanticJudgeEnabled: false,
    },
    ...overrides,
  } satisfies AppConfig;
}

async function occupyLocalPort() {
  const server = createServer();
  occupiedServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP port");
  return address.port;
}

async function closeServer(server: Server) {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function assertInstanceLockReleased(databasePath: string) {
  const lock = await acquireCoreInstanceLock(databasePath, {
    instanceId: "cleanup-probe",
    pid: process.pid,
    host: "test-host",
    processStart: "test-process-start",
    filesystemProbe: async () => "local",
  });
  await lock.release();
}

function readLease(databasePath: string) {
  const db = new Database(databasePath, { readonly: true });
  try {
    return db.prepare("SELECT owner_id as ownerId, fence, released_at as releasedAt FROM core_writer_lease WHERE lock_name = 'core-writer'").get() as
      { ownerId: string; fence: number; releasedAt: number | null } | undefined;
  } finally {
    db.close();
  }
}

type AuthorityCheck = "lock" | "lease" | "guard";

function lifecycleHarness() {
  const events: string[] = [];
  const counts = new Map<string, number>();
  let failedCheck: AuthorityCheck | undefined;
  let lifecycle: CoreLifecycle;
  const step = (name: string) => {
    events.push(name);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  };
  const fail = (check: AuthorityCheck) => {
    if (failedCheck === check) throw new Error(`${check} authority lost`);
  };
  const resources: CoreLifecycleResources = {
    instanceLock: {
      assertHeld: async () => { step("lock.assert"); fail("lock"); },
      release: async () => { step("lock.release"); },
    },
    writerLease: {
      heartbeat: () => { step("lease.heartbeat"); fail("lease"); },
      release: () => { step("lease.release"); return true; },
    },
    writerGuard: {
      assertConnectionGuardCurrent: () => { step("guard.assert"); fail("guard"); },
      removeConnectionGuard: () => { step("guard.remove"); },
    },
    stopBackground: async () => { step("background.stop"); },
    closeRuntimes: async () => { step("runtime.join"); },
    closeStore: () => { step("store.close"); },
    requestServerClose: async () => {
      step("server.close.request");
      await lifecycle.close();
    },
    onFailure: () => { step("failure.report"); },
  };
  lifecycle = new CoreLifecycle(resources, { heartbeatIntervalMs: 60_000, maxHeartbeatAgeMs: 120_000 });
  return {
    lifecycle,
    events,
    counts,
    failAt: (check: AuthorityCheck) => { failedCheck = check; },
  };
}

afterEach(async () => {
  await Promise.allSettled(cores.splice(0).reverse().map((core) => core.close()));
  await Promise.allSettled(occupiedServers.splice(0).map(closeServer));
  databases.splice(0).reverse().forEach((db) => { if (db.open) db.close(); });
  stores.splice(0).reverse().forEach((store) => { if (store.db.open) store.close(); });
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Core lifecycle", () => {
  it("orders normal shutdown from not-ready through workers, runtimes, guard, lease, DB, and OS lock", async () => {
    const { lifecycle, events, counts } = lifecycleHarness();
    await lifecycle.start();
    lifecycle.markReady();
    expect(lifecycle.snapshot()).toEqual({ phase: "ready", writerReady: true, lastFailure: null });
    events.length = 0;

    await lifecycle.close();

    expect(lifecycle.snapshot()).toEqual({ phase: "closed", writerReady: false, lastFailure: null });
    expect(events).toEqual([
      "runtime.join",
      "background.stop",
      "guard.remove",
      "lease.release",
      "store.close",
      "lock.release",
    ]);
    await lifecycle.close();
    for (const resource of events) expect(counts.get(resource)).toBe(1);
  });

  it("retains persistence and writer authority when runtime quiescence fails", async () => {
    const events: string[] = [];
    const lifecycle = new CoreLifecycle({
      instanceLock: {
        assertHeld: async () => undefined,
        release: async () => { events.push("lock.release"); },
      },
      writerLease: {
        heartbeat: () => undefined,
        release: () => { events.push("lease.release"); return true; },
      },
      writerGuard: {
        assertConnectionGuardCurrent: () => undefined,
        removeConnectionGuard: () => { events.push("guard.remove"); },
      },
      closeRuntimes: async () => { events.push("runtime.join"); throw new Error("runtime still active"); },
      stopBackground: async () => { events.push("background.stop"); },
      closeStore: () => { events.push("store.close"); },
    }, { heartbeatIntervalMs: 60_000, maxHeartbeatAgeMs: 120_000 });
    await lifecycle.start();
    lifecycle.markReady();

    await expect(lifecycle.close()).rejects.toThrow("runtime still active");

    expect(events).toEqual(["runtime.join"]);
    expect(lifecycle.snapshot()).toMatchObject({ phase: "closing", writerReady: false });
  });

  it.each(["lock", "lease", "guard"] as const)(
    "drops readiness and closes every resource exactly once after %s loss",
    async (check) => {
      const { lifecycle, events, counts, failAt } = lifecycleHarness();
      await lifecycle.start();
      lifecycle.markReady();
      events.length = 0;
      failAt(check);

      await expect(lifecycle.heartbeatNow()).rejects.toThrow(`${check} authority lost`);
      expect(lifecycle.isWriterReady()).toBe(false);
      await lifecycle.close();
      await lifecycle.close();

      expect(events.filter((event) => [
        "background.stop",
        "runtime.join",
        "guard.remove",
        "lease.release",
        "store.close",
        "lock.release",
      ].includes(event))).toEqual([
        "runtime.join",
        "background.stop",
        "guard.remove",
        "lease.release",
        "store.close",
        "lock.release",
      ]);
      for (const resource of ["background.stop", "runtime.join", "guard.remove", "lease.release", "store.close", "lock.release", "server.close.request"]) {
        expect(counts.get(resource), `${resource} executed more than once`).toBe(1);
      }
    },
  );

  it("fails closed at the monotonic heartbeat deadline while an authority check remains pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const store = new Store(":memory:");
    stores.push(store);
    const probeEntered = deferred<void>();
    const releaseProbe = deferred<void>();
    const events: string[] = [];
    const counts = new Map<string, number>();
    let observedFailure: unknown;
    const step = (name: string) => {
      events.push(name);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    };
    let lockChecks = 0;
    let lifecycle: CoreLifecycle;
    const resources: CoreLifecycleResources = {
      instanceLock: {
        assertHeld: async () => {
          step("lock.assert");
          lockChecks += 1;
          if (lockChecks === 2) {
            probeEntered.resolve(undefined);
            await releaseProbe.promise;
          }
        },
        release: async () => { step("lock.release"); },
      },
      writerLease: {
        heartbeat: () => { step("lease.heartbeat"); },
        release: () => { step("lease.release"); return true; },
      },
      writerGuard: {
        assertConnectionGuardCurrent: () => { step("guard.assert"); },
        removeConnectionGuard: () => { step("guard.remove"); },
      },
      stopBackground: async () => { step("background.stop"); },
      closeRuntimes: async () => { step("runtime.join"); },
      closeStore: () => { step("store.close"); store.close(); },
      requestServerClose: async () => {
        step("server.close.request");
        await lifecycle.close();
      },
      onFailure: (failure) => { observedFailure = failure; step("failure.report"); },
    };
    const eventLoopDelayMonitor: CoreEventLoopDelayMonitor = {
      enable: vi.fn(),
      disable: vi.fn(),
      reset: vi.fn(),
      maxMs: () => 2_500,
      percentileMs: () => 1_250,
    };
    lifecycle = new CoreLifecycle(resources, {
      heartbeatIntervalMs: 5_000,
      maxHeartbeatAgeMs: 10_000,
      clock: () => Date.now(),
      eventLoopDelayMonitor,
    });
    const app = createApp({
      persistence: httpPersistence(store),
      service: { closeRuntimes: async () => undefined } as unknown as CoreApplicationCoordinator,
      logger: false,
      writerReadiness: lifecycle,
      onClose: () => lifecycle.close(),
    });

    try {
      await lifecycle.start();
      lifecycle.markReady();
      await vi.advanceTimersByTimeAsync(5_000);
      await probeEntered.promise;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(lifecycle.isWriterReady()).toBe(false);
      expect(["closing", "closed"]).toContain(lifecycle.snapshot().phase);
      expect(lifecycle.snapshot()).toMatchObject({
        writerReady: false,
        lastFailure: "Core writer heartbeat exceeded 10000ms maximum age",
      });
      expect(observedFailure).toBeInstanceOf(CoreHeartbeatDeadlineError);
      expect((observedFailure as CoreHeartbeatDeadlineError).diagnostics).toEqual({
        maximumAgeMs: 10_000,
        heartbeatAgeMs: 10_000,
        activeStage: "instance_lock",
        activeStageElapsedMs: 5_000,
        stageDurationsMs: {
          instanceLockMs: null,
          writerLeaseMs: null,
          connectionGuardMs: null,
        },
        eventLoopDelayMaxMs: 2_500,
        eventLoopDelayP99Ms: 1_250,
      });
      expect(counts.get("server.close.request")).toBe(1);
      const rejected = await app.inject({ method: "POST", url: "/api/v1/sessions", payload: { title: "too late" } });
      expect(rejected.statusCode).toBe(503);
      const health = await app.inject({ method: "GET", url: "/api/v1/health" });
      expect(health.statusCode).toBe(503);
      expect(health.json().data.writer).toEqual({ ready: false });

      await lifecycle.close();
      expect(lifecycle.snapshot().phase).toBe("closed");
      releaseProbe.resolve(undefined);
      await app.close();
      expect(lifecycle.snapshot().writerReady).toBe(false);
      expect(events.filter((event) => [
        "background.stop",
        "runtime.join",
        "guard.remove",
        "lease.release",
        "store.close",
        "lock.release",
      ].includes(event))).toEqual([
        "runtime.join",
        "background.stop",
        "guard.remove",
        "lease.release",
        "store.close",
        "lock.release",
      ]);
      for (const resource of ["server.close.request", "background.stop", "runtime.join", "guard.remove", "lease.release", "store.close", "lock.release"]) {
        expect(counts.get(resource), `${resource} executed more than once`).toBe(1);
      }
    } finally {
      releaseProbe.resolve(undefined);
      await Promise.resolve();
      vi.useRealTimers();
    }
  });

  it("rejects a heartbeat that completes after a synchronous stage already exceeded the deadline", async () => {
    let now = 0;
    let leaseHeartbeats = 0;
    let observedFailure: unknown;
    let lifecycle: CoreLifecycle;
    const eventLoopDelayMonitor: CoreEventLoopDelayMonitor = {
      enable: vi.fn(),
      disable: vi.fn(),
      reset: vi.fn(),
      maxMs: () => 10_250,
      percentileMs: () => 9_900,
    };
    const resources: CoreLifecycleResources = {
      instanceLock: { assertHeld: async () => undefined, release: async () => undefined },
      writerLease: {
        heartbeat: () => {
          leaseHeartbeats += 1;
          if (leaseHeartbeats === 2) now = 10_001;
        },
        release: () => true,
      },
      writerGuard: { assertConnectionGuardCurrent: () => undefined, removeConnectionGuard: () => undefined },
      closeStore: () => undefined,
      requestServerClose: async (failure) => lifecycle.close(failure),
      onFailure: (failure) => { observedFailure = failure; },
    };
    lifecycle = new CoreLifecycle(resources, {
      heartbeatIntervalMs: 5_000,
      maxHeartbeatAgeMs: 10_000,
      clock: () => now,
      eventLoopDelayMonitor,
    });

    await lifecycle.start();
    lifecycle.markReady();
    await expect(lifecycle.heartbeatNow()).rejects.toThrow("Core writer heartbeat exceeded 10000ms maximum age");
    await lifecycle.close();

    expect(observedFailure).toBeInstanceOf(CoreHeartbeatDeadlineError);
    expect((observedFailure as CoreHeartbeatDeadlineError).diagnostics).toMatchObject({
      heartbeatAgeMs: 10_001,
      activeStage: null,
      stageDurationsMs: { instanceLockMs: 0, writerLeaseMs: 10_001, connectionGuardMs: 0 },
      eventLoopDelayMaxMs: 10_250,
      eventLoopDelayP99Ms: 9_900,
    });
    expect(lifecycle.snapshot()).toMatchObject({ phase: "closed", writerReady: false });
  });

  it("applies the same deadline to synchronous stages during the initial heartbeat", async () => {
    let now = 0;
    let observedFailure: unknown;
    const eventLoopDelayMonitor: CoreEventLoopDelayMonitor = {
      enable: vi.fn(),
      disable: vi.fn(),
      reset: vi.fn(),
      maxMs: () => 10_500,
      percentileMs: () => 10_100,
    };
    const resources: CoreLifecycleResources = {
      instanceLock: { assertHeld: async () => undefined, release: async () => undefined },
      writerLease: {
        heartbeat: () => { now = 10_001; },
        release: () => true,
      },
      writerGuard: { assertConnectionGuardCurrent: () => undefined, removeConnectionGuard: () => undefined },
      closeStore: () => undefined,
      onFailure: (failure) => { observedFailure = failure; },
    };
    const lifecycle = new CoreLifecycle(resources, {
      heartbeatIntervalMs: 5_000,
      maxHeartbeatAgeMs: 10_000,
      clock: () => now,
      eventLoopDelayMonitor,
    });

    await expect(lifecycle.start()).rejects.toThrow("Core writer heartbeat exceeded 10000ms maximum age");
    await lifecycle.close();

    expect(observedFailure).toBeInstanceOf(CoreHeartbeatDeadlineError);
    expect((observedFailure as CoreHeartbeatDeadlineError).diagnostics).toMatchObject({
      heartbeatAgeMs: 10_001,
      stageDurationsMs: { instanceLockMs: 0, writerLeaseMs: 10_001, connectionGuardMs: 0 },
      eventLoopDelayMaxMs: 10_500,
      eventLoopDelayP99Ms: 10_100,
    });
    expect(lifecycle.snapshot()).toMatchObject({ phase: "closed", writerReady: false });
  });

  it("returns mutation 503 after authority loss and does not double-close through app onClose", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const serviceClose = vi.fn(async () => undefined);
    const service = { closeRuntimes: serviceClose } as unknown as CoreApplicationCoordinator;
    const { lifecycle, counts, failAt } = lifecycleHarness();
    await lifecycle.start();
    lifecycle.markReady();
    const app = createApp({
      persistence: httpPersistence(store),
      service,
      logger: false,
      writerReadiness: lifecycle,
      onClose: () => lifecycle.close(),
    });

    const healthy = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(healthy.statusCode).toBe(200);
    const healthyBody = healthy.json().data;
    expect(healthyBody).toMatchObject({ ok: true });
    expect(healthyBody.writer).toEqual({ ready: true });
    expect(healthyBody.writer).not.toHaveProperty("ownerId");
    expect(healthyBody.writer).not.toHaveProperty("owner");
    expect(healthyBody.writer).not.toHaveProperty("fence");

    failAt("lease");
    await expect(lifecycle.heartbeatNow()).rejects.toThrow("lease authority lost");
    const rejected = await app.inject({ method: "POST", url: "/api/v1/sessions", payload: { title: "forbidden" } });
    expect(rejected.statusCode).toBe(503);
    expect(rejected.json()).toMatchObject({ error: { code: "writer.not_ready", retryable: true } });
    expect(store.listSessions()).toEqual([]);
    const unhealthy = await app.inject({ method: "GET", url: "/api/v1/health" });
    expect(unhealthy.statusCode).toBe(503);
    const unhealthyBody = unhealthy.json().data;
    expect(unhealthyBody).toMatchObject({ ok: false });
    expect(unhealthyBody.writer).toEqual({ ready: false });
    expect(unhealthyBody.writer).not.toHaveProperty("ownerId");
    expect(unhealthyBody.writer).not.toHaveProperty("owner");
    expect(unhealthyBody.writer).not.toHaveProperty("fence");

    await app.close();
    expect(serviceClose).not.toHaveBeenCalled();
    expect(counts.get("runtime.join")).toBe(1);
  });

  it("bounds an active-lease crash window without real sleeps or reaching listen", async () => {
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
      INSERT INTO writer_test_clock VALUES (1, 1000);
    `);
    const first = CoreWriterLease.claim(db, { ownerId: "owner-a", pid: process.pid, host: "test-host" }, {
      leaseMs: 20_000,
      heartbeatIntervalMs: 5_000,
      skewMarginMs: 2_000,
      nowSql,
    })!;
    let wallClock = 0;
    const sleeps: number[] = [];
    let listened = false;

    await expect((async () => {
      await claimCoreWriterLeaseWithRetry(db, { ownerId: "owner-b", pid: process.pid, host: "test-host" }, {
        leaseMs: 20_000,
        heartbeatIntervalMs: 5_000,
        skewMarginMs: 2_000,
        nowSql,
        maxWaitMs: 1_000,
        retryIntervalMs: 250,
        clock: () => wallClock,
        sleep: async (delayMs) => { sleeps.push(delayMs); wallClock += delayMs; },
      });
      listened = true;
    })()).rejects.toThrow("remained unavailable after 1000ms bounded recovery wait");
    expect(sleeps).toEqual([250, 250, 250, 250]);
    expect({ wallClock, listened }).toEqual({ wallClock: 1_000, listened: false });

    expect(first.release()).toBe(true);
    const restarted = await claimCoreWriterLeaseWithRetry(db, { ownerId: "owner-b", pid: process.pid, host: "test-host" }, {
      leaseMs: 20_000,
      heartbeatIntervalMs: 5_000,
      skewMarginMs: 2_000,
      nowSql,
      maxWaitMs: 0,
    });
    expect(restarted.authority.fence).toBe(first.authority.fence + 1);
  });

  it("allows exactly one concurrent bootstrap and orders lock before Store, lease, listen, and readiness", async () => {
    const config = await temporaryConfig();
    const [left, right] = await Promise.allSettled([bootstrapCore(config), bootstrapCore(config)]);
    const successes = [left, right].filter((result): result is PromiseFulfilledResult<BootstrappedCore> => result.status === "fulfilled");
    const failures = [left, right].filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    cores.push(successes[0].value);
    expect(successes[0].value.lifecycle.snapshot()).toMatchObject({ phase: "ready", writerReady: true });
    expect(String(failures[0].reason)).toMatch(/Core instance lock/);

    const serverSource = await readFile(path.join(process.cwd(), "apps/core-service/src/server.ts"), "utf8");
    const milestones = [
      "instanceLock = await acquireCoreInstanceLock",
      "store = new Store",
      "writerConnection = await claimCoreWriterConnectionWithRetry",
      "await app.listen",
      "lifecycle.markReady()",
    ].map((source) => serverSource.indexOf(source));
    expect(milestones.every((offset) => offset >= 0)).toBe(true);
    expect(milestones).toEqual([...milestones].sort((leftOffset, rightOffset) => leftOffset - rightOffset));
  });

  it("cleans up current-schema validation failure before any writer lease is claimed", async () => {
    const config = await temporaryConfig();
    const seed = new Store(config.database);
    seed.db.exec("DROP TABLE core_schema");
    seed.close();

    await expect(bootstrapCore(config)).rejects.toThrow("accepts only an empty database");
    await assertInstanceLockReleased(config.database);
    expect(readLease(config.database)).toBeUndefined();
  });

  it("cleans up assembly failure in reverse lifecycle order", async () => {
    const base = await temporaryConfig();
    const config: AppConfig = {
      ...base,
      routerModel: { ...base.routerModel, api: "anthropic-messages" },
    };

    await expect(bootstrapCore(config)).rejects.toThrow("Router supports only openai-completions");
    await assertInstanceLockReleased(config.database);
    expect(readLease(config.database)?.releasedAt).not.toBeNull();
  });

  it("cleans up recovery failure without becoming ready", async () => {
    const config = await temporaryConfig();
    const seed = new Store(config.database);
    const session = seed.createSession();
    const run = seed.createRun(session.id, "Recovery failure seed");
    const attemptId = `attempt:${run.id}:${run.attempt}`;
    seed.db.prepare(`INSERT INTO operations
      (id,run_id,attempt,attempt_id,operation_type,payload_hash,status,stage,created_at,updated_at)
      VALUES ('running-operation',?,?,?,?,?,'running','invalid-recovery-stage',1,1)`)
      .run(run.id, run.attempt, attemptId, "test", "recovery-payload");
    seed.db.prepare(`INSERT INTO approval_receipts
      (id,approval_source,approval_id,operation_id,operation_digest,outcome,actor_id,details_json,created_at)
      VALUES ('recovery-allow','run','recovery-approval','running-operation','recovery-digest','allow','test','{}',1)`).run();
    seed.close();

    await expect(bootstrapCore(config)).rejects.toThrow("running-operation has invalid restart state");
    await assertInstanceLockReleased(config.database);
    expect(readLease(config.database)?.releasedAt).not.toBeNull();
  });

  it("cleans up listen failure without retaining writer ownership", async () => {
    const port = await occupyLocalPort();
    const config = await temporaryConfig({ port });

    await expect(bootstrapCore(config)).rejects.toMatchObject({ code: "EADDRINUSE" });
    await assertInstanceLockReleased(config.database);
    expect(readLease(config.database)?.releasedAt).not.toBeNull();
  });

  it.each(["memory", "distillation"] as const)(
    "never becomes ready and reverses every production resource after %s worker start failure",
    async (failedWorker) => {
      const base = await temporaryConfig();
      const memory = loadConfig({
        TAGENT_MEMORY_ENABLED: "true",
        TAGENT_MEMORY_BACKEND: "memory",
        TAGENT_MEMORY_COLD_BACKEND: "local",
        TAGENT_MEMORY_COLD_PATH: path.join(path.dirname(base.database), "memory-cold"),
      }).memory;
      const config: AppConfig = {
        ...base,
        memory,
        learning: {
          ...base.learning,
          enabledByDefault: failedWorker === "distillation",
        },
      };
      const events: string[] = [];
      const originalDistillationClose = DistillationWorker.prototype.close;
      const originalGuardRemove = WriterFenceGuard.prototype.removeConnectionGuard;
      const originalLeaseRelease = CoreWriterLease.prototype.release;
      const originalStoreClose = Store.prototype.close;
      const originalLockRelease = CoreInstanceLock.prototype.release;
      const distillationClose = vi.spyOn(DistillationWorker.prototype, "close").mockImplementation(async function (this: DistillationWorker) {
        events.push("worker.distillation.close");
        await originalDistillationClose.call(this);
      });
      const runtimeClose = vi.spyOn(CoreApplicationCoordinator.prototype, "closeRuntimes").mockImplementation(async () => {
        events.push("runtime.close");
        return [];
      });
      const guardRemove = vi.spyOn(WriterFenceGuard.prototype, "removeConnectionGuard").mockImplementation(function (this: WriterFenceGuard) {
        events.push("guard.remove");
        return originalGuardRemove.call(this);
      });
      const leaseRelease = vi.spyOn(CoreWriterLease.prototype, "release").mockImplementation(function (this: CoreWriterLease) {
        events.push("lease.release");
        return originalLeaseRelease.call(this);
      });
      const storeClose = vi.spyOn(Store.prototype, "close").mockImplementation(function (this: Store) {
        events.push("store.close");
        return originalStoreClose.call(this);
      });
      const lockRelease = vi.spyOn(CoreInstanceLock.prototype, "release").mockImplementation(async function (this: CoreInstanceLock) {
        events.push("lock.release");
        await originalLockRelease.call(this);
      });
      const markReady = vi.spyOn(CoreLifecycle.prototype, "markReady");
      let memoryClose: ReturnType<typeof vi.spyOn> | undefined;
      const starter: CoreBackgroundWorkerStarter = {
        startMemory: vi.fn(async (runtime) => {
          const originalMemoryClose = runtime.close.bind(runtime);
          memoryClose = vi.spyOn(runtime, "close").mockImplementation(async () => {
            events.push("worker.memory.close");
            await originalMemoryClose();
          });
          if (failedWorker === "memory") throw new Error("simulated memory worker start failure");
          runtime.start();
        }),
        startDistillation: vi.fn(async (worker) => {
          if (failedWorker === "distillation") throw new Error("simulated distillation worker start failure");
          worker.start();
        }),
      };

      try {
        await expect(bootstrapCore(config, { backgroundWorkerStarter: starter }))
          .rejects.toThrow(`simulated ${failedWorker} worker start failure`);
        expect(markReady).not.toHaveBeenCalled();
        expect(events).toEqual(failedWorker === "memory" ? [
          "runtime.close",
          "worker.distillation.close",
          "worker.memory.close",
          "guard.remove",
          "lease.release",
          "store.close",
          "lock.release",
        ] : [
          "runtime.close",
          "worker.distillation.close",
          "worker.memory.close",
          "guard.remove",
          "lease.release",
          "store.close",
          "lock.release",
        ]);
        for (const event of new Set(events)) {
          expect(events.filter((observed) => observed === event), `${event} executed more than once`).toHaveLength(1);
        }
        expect(readLease(config.database)?.releasedAt).not.toBeNull();
      } finally {
        memoryClose?.mockRestore();
        markReady.mockRestore();
        lockRelease.mockRestore();
        storeClose.mockRestore();
        leaseRelease.mockRestore();
        guardRemove.mockRestore();
        runtimeClose.mockRestore();
        distillationClose.mockRestore();
      }

      await assertInstanceLockReleased(config.database);
    },
  );

  it("increments the fence on restart and exposes only boolean writer health", async () => {
    const config = await temporaryConfig();
    const first = await bootstrapCore(config);
    cores.push(first);
    const firstFence = readLease(config.database)!.fence;
    const firstHealth = await first.app.inject({ method: "GET", url: "/api/v1/health" });
    expect(firstHealth.json().data.writer).toEqual({ ready: true });
    expect(firstHealth.json().data.writer).not.toHaveProperty("ownerId");
    expect(firstHealth.json().data.writer).not.toHaveProperty("owner");
    expect(firstHealth.json().data.writer).not.toHaveProperty("fence");
    await first.close();

    const second = await bootstrapCore(config);
    cores.push(second);
    expect(readLease(config.database)!.fence).toBe(firstFence + 1);
    const secondHealth = await second.app.inject({ method: "GET", url: "/api/v1/health" });
    expect(secondHealth.json().data.writer).toEqual({ ready: true });
    expect(secondHealth.json().data.writer).not.toHaveProperty("ownerId");
    expect(secondHealth.json().data.writer).not.toHaveProperty("owner");
    expect(secondHealth.json().data.writer).not.toHaveProperty("fence");
  });

  it("supports explicit deferred Core application initialization without a writer-specific test bypass", async () => {
    const store = new Store(":memory:");
    stores.push(store);
    const interrupted = vi.spyOn(store, "markInterrupted");
    const reviewer = { reviewSettled: vi.fn(async () => ({ action: "accept" })) };
    const service = createCoreApplication(
      corePersistence(store),
      process.cwd(),
      undefined,
      { supervisorReviewer: reviewer as never },
      undefined,
      "default",
      undefined,
      undefined,
      { startupMode: "deferred" },
    );

    expect(interrupted).not.toHaveBeenCalled();
    service.initialize();
    service.initialize();
    expect(interrupted).toHaveBeenCalledOnce();

    const [lifecycleSource, serverSource, applicationSource] = await Promise.all([
      readFile(path.join(process.cwd(), "apps/core-service/src/composition/core-lifecycle.ts"), "utf8"),
      readFile(path.join(process.cwd(), "apps/core-service/src/server.ts"), "utf8"),
      readFile(path.join(process.cwd(), "apps/core-service/src/application/core-application-factory.ts"), "utf8"),
    ]);
    expect(lifecycleSource).not.toContain("VITEST");
    expect(serverSource).not.toContain("VITEST");
    expect(applicationSource.match(/process\.env\.VITEST/g) ?? []).toHaveLength(0);
    await service.closeRuntimes();
  });
});
