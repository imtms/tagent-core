import { afterEach, describe, expect, it } from "vitest";
import { LearningFeatureControl, SemanticJudge } from "@tagent/learning";
import { LegacyStoreAdapter, Store } from "@tagent/persistence-sqlite";
import type { MutationUnitOfWork, SynchronousResult } from "@tagent/persistence-sqlite/unit-of-work";

const stores: Store[] = [];

afterEach(() => {
  stores.splice(0).forEach((store) => store.close());
});

function fixture() {
  const store = new Store(":memory:");
  stores.push(store);
  const unitOfWork: MutationUnitOfWork = {
    run<T>(work: () => T & SynchronousResult<T>): T {
      return store.db.transaction(work)();
    },
  };
  return { store, adapter: new LegacyStoreAdapter(store, unitOfWork) };
}

function clusterResponse() {
  return { similar: true, confidence: 0.95, reason: "same reusable intent" };
}

function semanticModel(
  modelId: string,
  request: (prompt: string) => Promise<{ value: unknown; inputTokens?: number; outputTokens?: number }>,
) {
  return {
    modelId,
    request: async ({ prompt }: { prompt: string }) => ({
      ...await request(prompt),
      attemptsUsed: 1,
      timeouts: 0,
    }),
  };
}

describe("learning persistence repositories", () => {
  it("applies committed settings snapshots and notifies active listeners", async () => {
    const { adapter } = fixture();
    const control = new LearningFeatureControl(adapter.settings, true, {
      learningEnabled: true,
      autoExecutionEnabled: false,
    });
    expect(control.snapshot()).toMatchObject({
      memoryAvailable: true,
      memoryEnabled: true,
      learningEnabled: true,
      autoExecutionEnabled: false,
      passiveLearningEnabled: true,
      activeExecutionRequiresApproval: true,
      reason: "initialized_from_runtime_configuration",
    });

    const changes: string[] = [];
    const unsubscribe = control.onChange(async (state) => {
      changes.push(`${state.autoExecutionEnabled}:${state.reason}`);
    });
    await expect(control.applyCommittedState({
      memoryEnabled: true,
      learningEnabled: true,
      autoExecutionEnabled: true,
      updatedAt: Date.now(),
      reason: "operator-enabled",
    }))
      .resolves.toMatchObject({ autoExecutionEnabled: true, reason: "operator-enabled" });
    expect(changes).toEqual(["true:operator-enabled"]);

    unsubscribe();
    await control.applyCommittedState({
      memoryEnabled: true,
      learningEnabled: true,
      autoExecutionEnabled: false,
      updatedAt: Date.now(),
      reason: "operator-disabled",
    });
    expect(changes).toEqual(["true:operator-enabled"]);
  });

  it("serves cache hits and treats expired entries as misses", async () => {
    const { adapter } = fixture();
    let cacheableCalls = 0;
    const cacheable = new SemanticJudge({
      model: semanticModel("cacheable-model", async () => {
        cacheableCalls += 1;
        return { value: clusterResponse() };
      }),
    }, adapter.semanticCache);
    await expect(cacheable.cluster("left", "right")).resolves.toMatchObject({ similar: true });
    await expect(cacheable.cluster("left", "right")).resolves.toMatchObject({ similar: true });
    expect(cacheableCalls).toBe(1);
    expect(cacheable.snapshot()).toMatchObject({ calls: 1, cacheHits: 1 });

    let expiredCalls = 0;
    const expiring = new SemanticJudge({
      model: semanticModel("expired-model", async () => {
        expiredCalls += 1;
        return { value: clusterResponse() };
      }),
      cacheTtlMs: -1,
    }, adapter.semanticCache);
    await expiring.cluster("left", "right");
    await expiring.cluster("left", "right");
    expect(expiredCalls).toBe(2);
    expect(expiring.snapshot()).toMatchObject({ calls: 2, cacheHits: 0 });
  });

  it("upserts cache payloads without rewriting their identity metadata", () => {
    const { adapter } = fixture();
    adapter.semanticCache.putSemanticCacheEntry({
      cacheKey: "stable-key",
      task: "memory_capture",
      inputHash: "original-input",
      model: "original-model",
      result: { version: 1 },
      createdAt: 100,
      expiresAt: 1_000,
    });
    adapter.semanticCache.putSemanticCacheEntry({
      cacheKey: "stable-key",
      task: "feedback_attribution",
      inputHash: "changed-input",
      model: "changed-model",
      result: { version: 2 },
      createdAt: 200,
      expiresAt: 2_000,
    });

    expect(adapter.semanticCache.getSemanticCacheEntry("stable-key", 500)).toEqual({
      cacheKey: "stable-key",
      task: "memory_capture",
      inputHash: "original-input",
      model: "original-model",
      result: { version: 2 },
      createdAt: 200,
      expiresAt: 2_000,
    });
    expect(adapter.semanticCache.getSemanticCacheEntry("stable-key", 2_000)).toBeUndefined();
    expect(adapter.semanticCache.deleteExpiredSemanticCacheEntries(2_000)).toBe(1);
  });

  it("treats corrupt cached JSON as a miss and repairs it with the next result", async () => {
    const { store, adapter } = fixture();
    let calls = 0;
    const options = {
      model: semanticModel("corrupt-model", async () => {
        calls += 1;
        return { value: clusterResponse() };
      }),
    };
    await new SemanticJudge(options, adapter.semanticCache).cluster("left", "right");
    store.db.prepare("UPDATE semantic_judgment_cache SET result_json = '{broken-json'").run();

    const recovering = new SemanticJudge(options, adapter.semanticCache);
    await expect(recovering.cluster("left", "right")).resolves.toMatchObject({ similar: true });
    expect(calls).toBe(2);
    expect(recovering.snapshot()).toMatchObject({ calls: 1, cacheHits: 0, failures: 0 });
    expect(store.db.prepare("SELECT json_valid(result_json) AS valid FROM semantic_judgment_cache").get())
      .toEqual({ valid: 1 });
  });
});
