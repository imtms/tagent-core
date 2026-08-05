import { afterEach, describe, expect, it } from "vitest";
import { ShadowLearningProjectionWorker } from "@tagent/learning/application";
import { createGuardedLegacyStoreAdapter } from "@tagent/persistence-sqlite/sqlite";
import { Store } from "@tagent/persistence-sqlite/store";
import { CoreWriterLease, WriterFenceGuard } from "@tagent/persistence-sqlite/writer";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

function fixture() {
  const store = new Store(":memory:");
  stores.push(store);
  const writer = CoreWriterLease.claim(store.db, {
    ownerId: "shadow-writer", pid: process.pid, host: "test",
  })!;
  const adapter = createGuardedLegacyStoreAdapter(store, new WriterFenceGuard(store.db, writer.authority));
  const session = adapter.sessions.createSession();
  const run = adapter.taskRuns.createRun(session.id, "shadow projection");
  store.transitionRun(run.id, ["running"], "completed", "run.completed", { ok: true }, "done", 1);
  return {
    store,
    integration: adapter.learningIntegration,
    worker: new ShadowLearningProjectionWorker(adapter.learningIntegration, {
      owner: "shadow-a", leaseMs: 1_000,
    }),
  };
}

function tableCounts(store: Store) {
  const allowed = new Set([
    "integration_consumer_delivery", "integration_reconciliation", "learning_projection_checkpoint",
  ]);
  return Object.fromEntries((store.db.prepare(`SELECT name FROM sqlite_master
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>)
    .filter(({ name }) => !allowed.has(name))
    .map(({ name }) => [name, (store.db.prepare(`SELECT COUNT(*) count FROM "${name}"`).get() as { count: number }).count]));
}

describe("Learning v33 shadow consumer", () => {
  it("reconciles one exact next sequence and changes no Learning business projection", () => {
    const { store, integration, worker } = fixture();
    const before = tableCounts(store);

    expect(worker.runOnce(100)).toMatchObject({ kind: "matched", outboxSequence: 1, watermark: 1 });
    expect(tableCounts(store)).toEqual(before);
    expect(store.db.prepare(`SELECT consumer,delivery_role as role,watermark,generation
      FROM learning_projection_checkpoint`).get()).toEqual({
      consumer: "learning-shadow-v1", role: "shadow", watermark: 1, generation: 1,
    });
    expect(store.db.prepare(`SELECT status,authority_generation as authorityGeneration,
      authority_token as authorityToken FROM integration_consumer_delivery`).get()).toEqual({
      status: "acked", authorityGeneration: 0, authorityToken: null,
    });
    expect(integration.reconciliation.getContiguousWatermark()).toBe(1);
    expect(worker.runOnce(101)).toEqual({ kind: "idle", watermark: 1 });
  });

  it.each([
    ["missing", (store: Store) => store.db.prepare("DELETE FROM learning_projection_outbox").run()],
    ["hash_mismatch", (store: Store) => {
      store.db.exec("DROP TRIGGER learning_projection_outbox_identity_immutable");
      store.db.prepare("UPDATE learning_projection_outbox SET payload_hash='corrupt'").run();
    }],
    ["snapshot_mismatch", (store: Store) => store.db.prepare(
      "UPDATE learning_projection_outbox SET snapshot_json='{}'",
    ).run()],
    ["digest_mismatch", (store: Store) => store.db.prepare(
      "UPDATE learning_projection_outbox SET lifecycle='run.failed'",
    ).run()],
  ] as const)("persists %s as a blocker without advancing the checkpoint", (status, corrupt) => {
    const { store, integration, worker } = fixture();
    corrupt(store);
    expect(worker.runOnce(100)).toMatchObject({ kind: "blocked", status, outboxSequence: 1 });
    expect(store.db.prepare("SELECT status FROM integration_reconciliation").get()).toEqual({ status });
    expect(store.db.prepare("SELECT status FROM integration_consumer_delivery").get()).toEqual({ status: "failed" });
    expect(store.db.prepare("SELECT watermark FROM learning_projection_checkpoint").get()).toEqual({ watermark: 0 });
    expect(integration.reconciliation.getContiguousWatermark()).toBe(0);
  });
});
