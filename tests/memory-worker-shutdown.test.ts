import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalMemoryWorker } from "../packages/memory/src/runtime-worker.js";
import { PostgresMemoryAdapter } from "../packages/memory/src/postgres/postgres-adapter.js";

const scope = { type: "workspace" as const, id: "shutdown-race" };
const access = { subjectId: "test", scopes: [scope], purpose: "capture" as const };

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function createWorker(options: {
  capture?: () => Promise<boolean>;
  promote?: () => Promise<void>;
  heartbeat?: () => Promise<void>;
  reindex?: { runOnce: () => Promise<boolean> };
  core?: { generate: () => Promise<unknown> };
  operations?: {
    recordMetric: () => Promise<void>;
    recordDegraded: () => Promise<void>;
  };
  captureIntervalMs?: number;
  maintenanceIntervalMs?: number;
} = {}) {
  return new LocalMemoryWorker(
    { runOnce: options.capture ?? (async () => false) } as never,
    {
      promote: options.promote ?? (async () => undefined),
      topicCandidates: async () => [],
    } as never,
    { consolidate: async () => undefined } as never,
    { verify: async () => undefined, cleanupStaged: async () => undefined } as never,
    access,
    options.captureIntervalMs ?? 10,
    options.maintenanceIntervalMs ?? 10,
    options.heartbeat,
    undefined,
    options.reindex as never,
    options.core as never,
    options.operations as never,
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Local Memory worker shutdown barrier", () => {
  it("does not rescan Core Memory merely because a capture job was claimed", async () => {
    let captureCalls = 0;
    let coreRefreshes = 0;
    const worker = createWorker({
      capture: async () => ++captureCalls === 1,
      core: { generate: async () => { coreRefreshes += 1; } },
    });

    await expect(worker.captureTick()).resolves.toBe(true);
    expect(captureCalls).toBe(2);
    expect(coreRefreshes).toBe(0);
    await worker.stop();
  });

  it("does not overwrite an in-flight capture task when its interval overlaps", async () => {
    vi.useFakeTimers();
    const releaseCapture = deferred<boolean>();
    let captureCalls = 0;
    const worker = createWorker({
      capture: async () => {
        captureCalls += 1;
        return releaseCapture.promise;
      },
      maintenanceIntervalMs: 1_000,
    });

    worker.start();
    await Promise.resolve();
    expect(captureCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(captureCalls).toBe(1);

    let stopped = false;
    const stop = worker.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseCapture.resolve(false);
    await stop;
    await vi.advanceTimersByTimeAsync(100);
    expect(captureCalls).toBe(1);
  });

  it("does not overwrite an in-flight maintenance task when its interval overlaps", async () => {
    vi.useFakeTimers();
    const releaseMaintenance = deferred<void>();
    let maintenanceCalls = 0;
    const worker = createWorker({
      promote: async () => {
        maintenanceCalls += 1;
        await releaseMaintenance.promise;
      },
      captureIntervalMs: 1_000,
    });

    worker.start();
    await Promise.resolve();
    expect(maintenanceCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(maintenanceCalls).toBe(1);

    let stopped = false;
    const stop = worker.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseMaintenance.resolve(undefined);
    await stop;
    await vi.advanceTimersByTimeAsync(100);
    expect(maintenanceCalls).toBe(1);
  });

  it("waits for capture, maintenance, and heartbeat work and shares concurrent stop calls", async () => {
    const releaseCapture = deferred<boolean>();
    const releaseMaintenance = deferred<void>();
    const releaseHeartbeat = deferred<void>();
    const worker = createWorker({
      capture: () => releaseCapture.promise,
      promote: () => releaseMaintenance.promise,
      heartbeat: () => releaseHeartbeat.promise,
    });

    worker.start();
    const firstStop = worker.stop();
    const secondStop = worker.stop();
    expect(secondStop).toBe(firstStop);

    let stopped = false;
    void firstStop.then(() => { stopped = true; });
    releaseCapture.resolve(false);
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseMaintenance.resolve(undefined);
    await Promise.resolve();
    expect(stopped).toBe(false);
    releaseHeartbeat.resolve(undefined);
    await firstStop;
    expect(stopped).toBe(true);
    await expect(worker.stop()).resolves.toBeUndefined();
  });

  it("waits for pending metric and reindex work before closing", async () => {
    const releaseMetric = deferred<void>();
    const releaseReindex = deferred<boolean>();
    let metricCalls = 0;
    let reindexCalls = 0;
    const worker = createWorker({
      operations: {
        recordMetric: async () => {
          metricCalls += 1;
          if (metricCalls === 1) await releaseMetric.promise;
        },
        recordDegraded: async () => undefined,
      },
      reindex: {
        runOnce: async () => {
          reindexCalls += 1;
          return releaseReindex.promise;
        },
      },
    });

    const tick = worker.captureTick();
    await vi.waitFor(() => expect(metricCalls).toBe(1));
    const stop = worker.stop();
    let stopped = false;
    void stop.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    releaseMetric.resolve(undefined);
    await vi.waitFor(() => expect(reindexCalls).toBe(1));
    expect(stopped).toBe(false);
    releaseReindex.resolve(false);
    await Promise.all([tick, stop]);
    expect(stopped).toBe(true);
  });

  it("settles a failed tick and rejects new work after shutdown", async () => {
    let captureCalls = 0;
    const worker = createWorker({
      capture: async () => {
        captureCalls += 1;
        throw new Error("capture failed");
      },
    });

    await expect(worker.captureTick()).rejects.toThrow("capture failed");
    await expect(worker.stop()).resolves.toBeUndefined();
    await expect(worker.captureTick()).resolves.toBe(false);
    await expect(worker.maintenanceTick()).resolves.toBe(false);
    expect(captureCalls).toBe(1);
  });

  it("closes a PostgreSQL pool exactly once for concurrent and repeated callers", async () => {
    const adapter = new PostgresMemoryAdapter({});
    const end = vi.spyOn(adapter.pool, "end").mockResolvedValue(undefined);

    const first = adapter.close();
    const second = adapter.close();
    expect(second).toBe(first);
    await Promise.all([first, second, adapter.close()]);

    expect(end).toHaveBeenCalledOnce();
  });
});
