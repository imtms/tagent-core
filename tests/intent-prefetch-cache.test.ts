import { describe, expect, it, vi } from "vitest";
import { IntentPrefetchCache } from "../apps/web-console/src/intent-prefetch-cache";

describe("intent prefetch cache", () => {
  it("deduplicates in-flight intent and exposes resolved values", async () => {
    const cache = new IntentPrefetchCache<string, string>();
    const loader = vi.fn(async () => "ready");
    const first = cache.load("workspace", loader);
    const second = cache.load("workspace", loader);
    expect(first).toBe(second);
    await expect(first).resolves.toBe("ready");
    expect(cache.peek("workspace")).toBe("ready");
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("expires stale entries and evicts the oldest bounded entry", async () => {
    let now = 0;
    const cache = new IntentPrefetchCache<string, string>(30, 2, () => now);
    await cache.load("first", async () => "one");
    now = 1; await cache.load("second", async () => "two");
    now = 2; await cache.load("third", async () => "three");
    expect(cache.peek("first")).toBeUndefined();
    expect(cache.peek("second")).toBe("two");
    now = 40;
    expect(cache.peek("second")).toBeUndefined();
  });

  it("removes failures so later intent can retry", async () => {
    const cache = new IntentPrefetchCache<string, string>();
    await expect(cache.load("workspace", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    await expect(cache.load("workspace", async () => "recovered")).resolves.toBe("recovered");
  });
});
