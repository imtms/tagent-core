import { EventEmitter } from "node:events";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { withinDeadline } from "../apps/core-service/src/composition/execution-collaboration-adapters.js";
import type { MemoryFacade } from "../packages/memory/src/memory-service.js";
import type { HttpArtifactContentPort } from "../adapters/http-fastify/src/ports/http-adapter-ports.js";
import { withRequestAbortSignal } from "../adapters/http-fastify/src/v1/console-route-support.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("deadline ownership", () => {
  it("requires caller-owned signals at memory and HTTP artifact seams", () => {
    expectTypeOf<Parameters<MemoryFacade["recall"]>[0]>().toMatchTypeOf<{ signal: AbortSignal }>();
    expectTypeOf<Parameters<NonNullable<MemoryFacade["getCoreSnapshot"]>>[1]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<Parameters<HttpArtifactContentPort["loadSource"]>[3]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<Parameters<HttpArtifactContentPort["loadDownload"]>[3]>().toEqualTypeOf<AbortSignal>();
  });

  it("translates an HTTP connection close into a scoped operation abort and removes listeners", async () => {
    const requestRaw = Object.assign(new EventEmitter(), { aborted: false });
    const replyRaw = Object.assign(new EventEmitter(), { destroyed: false });
    let observedSignal: AbortSignal | undefined;
    const pending = withRequestAbortSignal(
      { raw: requestRaw } as never,
      { raw: replyRaw } as never,
      async (signal) => {
        observedSignal = signal;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    );

    replyRaw.emit("close");

    await expect(pending).rejects.toThrow("HTTP request was aborted");
    expect(observedSignal?.aborted).toBe(true);
    expect(requestRaw.listenerCount("aborted")).toBe(0);
    expect(replyRaw.listenerCount("close")).toBe(0);
  });

  it("does not settle the owner until timed-out same-process work finishes cleanup", async () => {
    const aborted = deferred<unknown>();
    const releaseCleanup = deferred();
    let cleanupFinished = false;
    const caller = new AbortController();
    let settled = false;
    const pending = withinDeadline(async (signal) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted.resolve(signal.reason);
          resolve();
        }, { once: true });
      });
      await releaseCleanup.promise;
      cleanupFinished = true;
      throw signal.reason;
    }, 5, caller.signal).finally(() => { settled = true; });

    await aborted.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(cleanupFinished).toBe(false);
    releaseCleanup.resolve();
    await expect(pending).rejects.toThrow("online memory recall exceeded 5ms");
    expect(cleanupFinished).toBe(true);
  });

  it("removes caller cancellation ownership when work throws synchronously", async () => {
    const caller = new AbortController();
    const addListener = vi.spyOn(caller.signal, "addEventListener");
    const removeListener = vi.spyOn(caller.signal, "removeEventListener");
    const failure = new Error("synchronous setup failure");

    await expect(withinDeadline(() => { throw failure; }, 50, caller.signal)).rejects.toBe(failure);

    const abortListener = addListener.mock.calls.find(([type]) => type === "abort")?.[1];
    expect(abortListener).toBeDefined();
    expect(removeListener).toHaveBeenCalledWith("abort", abortListener);
  });
});
