import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LearningProjectionRuntime } from "../apps/core-service/src/composition/learning-projection-runtime.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function flushMicrotasks() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

describe("Learning projection runtime", () => {
  it("replaces production direct drains only after wiring the active Learning worker", () => {
    const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
    const collaboration = source("apps/core-service/src/composition/execution-collaboration-adapters.ts");
    const server = source("apps/core-service/src/server.ts");

    expect(collaboration).not.toMatch(/\.drainProjectionOutbox\s*\(/);
    expect(server).toContain("new ActiveLearningProjectionWorker(");
    expect(server).toContain("new WorkflowServiceActiveProjectionApplier(workflowService)");
    expect(server.indexOf("new ActiveLearningProjectionWorker(")).toBeLessThan(
      server.indexOf("new LearningProjectionRuntime("),
    );
    expect(server).toMatch(/startLearningProjection\(learningProjectionRuntime!?\)/);
  });

  it("runs bounded shadow and exclusive active loops and quiesces exact-W cutover and rollback", async () => {
    vi.useFakeTimers();
    const firstShadow = deferred<{ kind: "matched" }>();
    const firstActive = deferred<{ kind: "applied" }>();
    let activeSource: "legacy" | "integration" = "legacy";
    let activePosition = 1;
    let activeCalls = 0;
    let activeExecutions = 0;
    let maximumActiveExecutions = 0;
    const observedActiveClaims: Array<{ source: "legacy" | "integration"; position: number }> = [];

    const shadowWorker = {
      runOnce: vi.fn(async () => {
        if (shadowWorker.runOnce.mock.calls.length === 1) return await firstShadow.promise;
        return { kind: "matched" as const };
      }),
    };
    const activeWorker = {
      runOnce: vi.fn(async () => {
        activeCalls += 1;
        activeExecutions += 1;
        maximumActiveExecutions = Math.max(maximumActiveExecutions, activeExecutions);
        observedActiveClaims.push({ source: activeSource, position: activePosition });
        try {
          if (activeCalls === 1) return await firstActive.promise;
          return { kind: "idle" as const };
        } finally {
          activeExecutions -= 1;
        }
      }),
      renewAuthority: vi.fn(() => ({ source: activeSource })),
      pause: vi.fn(),
      resume: vi.fn(),
      releaseAuthority: vi.fn(),
    };
    const coordinator = {
      cutover: vi.fn(() => {
        activeSource = "integration";
        activePosition = 8;
        return { kind: "activated" as const, source: activeSource, switchWatermark: 7 };
      }),
      rollback: vi.fn(() => {
        activeSource = "legacy";
        activePosition = 8;
        return { kind: "activated" as const, source: activeSource, resumePosition: 8 };
      }),
    };
    const runtime = new LearningProjectionRuntime(
      { shadow: shadowWorker, active: activeWorker, coordinator },
      { intervalMs: 1_000, authorityHeartbeatMs: 250, maxItemsPerTick: 2 },
    );

    try {
      runtime.start();
      runtime.start();
      expect(shadowWorker.runOnce).toHaveBeenCalledTimes(1);
      expect(activeWorker.runOnce).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(shadowWorker.runOnce).toHaveBeenCalledTimes(1);
      expect(activeWorker.runOnce).toHaveBeenCalledTimes(1);
      expect(activeWorker.renewAuthority).not.toHaveBeenCalled();

      const cutover = runtime.cutover(500);
      await flushMicrotasks();
      expect(coordinator.cutover).not.toHaveBeenCalled();

      firstShadow.resolve({ kind: "matched" });
      firstActive.resolve({ kind: "applied" });
      await expect(cutover).resolves.toEqual({
        kind: "activated", source: "integration", switchWatermark: 7,
      });
      await flushMicrotasks();

      expect(shadowWorker.runOnce).toHaveBeenCalledTimes(2);
      expect(observedActiveClaims).toEqual([
        { source: "legacy", position: 1 },
        { source: "integration", position: 8 },
      ]);
      expect(maximumActiveExecutions).toBe(1);
      await vi.advanceTimersByTimeAsync(250);
      expect(activeWorker.renewAuthority).toHaveBeenCalledTimes(1);

      await expect(runtime.rollback(600)).resolves.toEqual({
        kind: "activated", source: "legacy", resumePosition: 8,
      });
      await flushMicrotasks();
      expect(observedActiveClaims).toEqual([
        { source: "legacy", position: 1 },
        { source: "integration", position: 8 },
        { source: "legacy", position: 8 },
      ]);
      expect(maximumActiveExecutions).toBe(1);

      await runtime.stop();
      await runtime.stop();
      expect(activeWorker.releaseAuthority).toHaveBeenCalledTimes(1);
    } finally {
      firstShadow.resolve({ kind: "matched" });
      firstActive.resolve({ kind: "applied" });
      await flushMicrotasks();
      await runtime.close();
      vi.useRealTimers();
    }
  });

  it("reports synchronous authority heartbeat failures instead of escaping the timer", async () => {
    vi.useFakeTimers();
    const reportFailure = vi.fn();
    const runtime = new LearningProjectionRuntime({
      shadow: { runOnce: () => ({ kind: "idle" }) },
      active: {
        runOnce: () => ({ kind: "idle" }),
        renewAuthority: () => { throw new Error("authority lost"); },
        pause: () => undefined,
        resume: () => undefined,
        releaseAuthority: () => undefined,
      },
      coordinator: {
        cutover: () => ({ kind: "blocked", phase: "authority" }),
        rollback: () => ({ kind: "blocked", phase: "authority" }),
      },
    }, {
      intervalMs: 1_000,
      authorityHeartbeatMs: 100,
      reportFailure,
    });

    try {
      runtime.start();
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(100);
      await flushMicrotasks();
      expect(reportFailure).toHaveBeenCalledWith("authority", expect.objectContaining({
        message: "authority lost",
      }));
    } finally {
      await runtime.close();
      vi.useRealTimers();
    }
  });
});
