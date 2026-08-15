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
  it("wires one integration worker and no direct terminal projection", () => {
    const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");
    const collaboration = source("apps/core-service/src/composition/execution-collaboration-adapters.ts");
    const server = source("apps/core-service/src/server.ts");

    expect(collaboration).not.toMatch(/\.drainProjectionOutbox\s*\(/);
    expect(collaboration).not.toMatch(/\.drainLearningProjectionLedger\s*\(/);
    expect(collaboration).not.toMatch(/learningService\.projectRun\s*\(/);
    expect(server).toContain("new ActiveLearningProjectionWorker(");
    expect(server).toContain("new LearningServicesProjectionApplier(");
    expect(server).not.toMatch(/ShadowLearning|AuthorityCoordinator|authorityHeartbeat/);
  });

  it("drains a bounded single-consumer batch without overlapping polls", async () => {
    vi.useFakeTimers();
    const first = deferred<{ kind: "applied" }>();
    let executions = 0;
    let maximumExecutions = 0;
    const worker = {
      runOnce: vi.fn(async () => {
        executions += 1;
        maximumExecutions = Math.max(maximumExecutions, executions);
        try {
          if (worker.runOnce.mock.calls.length === 1) return await first.promise;
          return worker.runOnce.mock.calls.length <= 3
            ? { kind: "applied" as const }
            : { kind: "idle" as const };
        } finally {
          executions -= 1;
        }
      }),
    };
    const afterApplied = vi.fn();
    const runtime = new LearningProjectionRuntime(worker, {
      intervalMs: 1_000,
      maxItemsPerTick: 3,
      afterApplied,
    });

    try {
      runtime.start();
      runtime.start();
      expect(worker.runOnce).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(worker.runOnce).toHaveBeenCalledTimes(1);

      first.resolve({ kind: "applied" });
      await flushMicrotasks();
      expect(maximumExecutions).toBe(1);
      expect(afterApplied).toHaveBeenCalledTimes(3);
      expect(worker.runOnce).toHaveBeenCalledTimes(3);

      await runtime.stop();
      await runtime.stop();
    } finally {
      first.resolve({ kind: "applied" });
      await runtime.close();
      vi.useRealTimers();
    }
  });

  it("reports worker failures without escaping the timer", async () => {
    vi.useFakeTimers();
    const reportFailure = vi.fn();
    const runtime = new LearningProjectionRuntime({
      runOnce: () => ({ kind: "failed", error: "projection failed" }),
    }, {
      intervalMs: 1_000,
      reportFailure,
    });

    try {
      runtime.start();
      await flushMicrotasks();
      expect(reportFailure).toHaveBeenCalledWith(expect.objectContaining({
        kind: "failed",
        error: "projection failed",
      }));
    } finally {
      await runtime.close();
      vi.useRealTimers();
    }
  });
});
