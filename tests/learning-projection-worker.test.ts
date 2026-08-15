import { afterEach, describe, expect, it } from "vitest";
import { ActiveLearningProjectionWorker } from "@tagent/learning/application";
import { createGuardedSqlitePersistence } from "@tagent/persistence-sqlite/sqlite";
import { Store } from "@tagent/persistence-sqlite/store";
import { CoreWriterLease, WriterFenceGuard } from "@tagent/persistence-sqlite/writer";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

function fixture(runCount = 1) {
  const store = new Store(":memory:");
  stores.push(store);
  const writer = CoreWriterLease.claim(store.db, {
    ownerId: "learning-projection-writer", pid: process.pid, host: "test",
  })!;
  const persistence = createGuardedSqlitePersistence(
    store,
    new WriterFenceGuard(store.db, writer.authority),
  );
  const session = persistence.sessions.createSession();
  for (let index = 0; index < runCount; index += 1) {
    const run = persistence.taskRuns.createRun(session.id, `projection-${index}`);
    store.transitionRun(run.id, ["running"], "completed", "run.completed", {}, "done", 1);
  }
  return { store, integration: persistence.learningIntegration };
}

describe("Learning projection worker", () => {
  it("replays a committed effect after an ACK crash without applying it twice", () => {
    const { store, integration } = fixture();
    let applications = 0;
    const worker = new ActiveLearningProjectionWorker(integration, {
      apply: () => { applications += 1; },
    }, { owner: "worker", leaseMs: 50, clock: () => 100 });

    store.db.exec(`CREATE TEMP TRIGGER crash_before_projection_ack
      BEFORE UPDATE ON integration_consumer_delivery
      WHEN NEW.status='acked'
      BEGIN SELECT RAISE(ABORT,'crash before projection ACK'); END`);
    expect(() => worker.runOnce(100)).toThrow(/crash before projection ACK/);
    expect(applications).toBe(1);
    expect(store.db.prepare("SELECT COUNT(*) count FROM effect_receipts").get()).toEqual({ count: 1 });
    expect(integration.delivery.getCheckpoint("learning-projection-v1")?.watermark ?? 0).toBe(0);

    store.db.exec("DROP TRIGGER crash_before_projection_ack");
    expect(worker.runOnce(151)).toMatchObject({
      kind: "replayed", outboxSequence: 1, watermark: 1,
    });
    expect(applications).toBe(1);
    expect(integration.delivery.getCheckpoint("learning-projection-v1")?.watermark).toBe(1);
  });

  it("fences lease takeover, stale settlement, and checkpoint updates atomically", () => {
    const { store, integration } = fixture(2);
    const first = integration.delivery.claimNext({
      consumer: "learning-projection-v1", owner: "worker-a", leaseMs: 10, timestamp: 100,
    })!;
    expect(first.fence).toMatchObject({ outboxSequence: 1, leaseGeneration: 1 });
    expect(integration.delivery.claimNext({
      consumer: "learning-projection-v1", owner: "worker-b", leaseMs: 10, timestamp: 105,
    })).toBeNull();
    const takeover = integration.delivery.claimNext({
      consumer: "learning-projection-v1", owner: "worker-b", leaseMs: 10, timestamp: 111,
    })!;
    expect(takeover.fence.leaseGeneration).toBe(2);
    expect(takeover.fence.leaseToken).not.toBe(first.fence.leaseToken);

    integration.effects.record({
      logicalConsumer: "learning-projection-v1",
      sourceEventId: takeover.fence.sourceEventId,
      effectHash: "effect-one",
      timestamp: 112,
    });
    expect(integration.delivery.acknowledge({
      claim: first, effectHash: "effect-one", timestamp: 112,
    })).toBeNull();

    const before = {
      delivery: store.db.prepare("SELECT * FROM integration_consumer_delivery").get(),
      checkpoint: integration.delivery.getCheckpoint("learning-projection-v1"),
    };
    store.db.exec(`CREATE TEMP TRIGGER reject_projection_checkpoint
      BEFORE UPDATE ON learning_projection_checkpoint
      BEGIN SELECT RAISE(ABORT,'reject projection checkpoint'); END`);
    expect(() => integration.delivery.acknowledge({
      claim: takeover, effectHash: "effect-one", timestamp: 112,
    })).toThrow(/reject projection checkpoint/);
    expect({
      delivery: store.db.prepare("SELECT * FROM integration_consumer_delivery").get(),
      checkpoint: integration.delivery.getCheckpoint("learning-projection-v1"),
    }).toEqual(before);

    store.db.exec("DROP TRIGGER reject_projection_checkpoint");
    expect(integration.delivery.acknowledge({
      claim: takeover, effectHash: "effect-one", timestamp: 112,
    })).toMatchObject({ watermark: 1, generation: 2 });
    expect(integration.delivery.claimNext({
      consumer: "learning-projection-v1", owner: "worker-b", leaseMs: 10, timestamp: 113,
    })?.fence.outboxSequence).toBe(2);
  });

  it("fails closed when an existing effect receipt has a different digest", () => {
    const { store, integration } = fixture();
    const source = store.db.prepare(
      "SELECT source_event_id as sourceEventId FROM integration_outbox WHERE outbox_sequence=1",
    ).get() as { sourceEventId: string };
    integration.effects.record({
      logicalConsumer: "learning-projection-v1",
      sourceEventId: source.sourceEventId,
      effectHash: "conflicting-effect",
      timestamp: 100,
    });
    let applications = 0;
    const worker = new ActiveLearningProjectionWorker(integration, {
      apply: () => { applications += 1; },
    }, { owner: "worker", leaseMs: 50, clock: () => 100 });

    expect(worker.runOnce(100)).toMatchObject({ kind: "failed", outboxSequence: 1 });
    expect(applications).toBe(0);
    expect(integration.delivery.getCheckpoint("learning-projection-v1")?.watermark ?? 0).toBe(0);
    expect(store.db.prepare("SELECT status FROM integration_consumer_delivery").get())
      .toEqual({ status: "failed" });
  });
});
