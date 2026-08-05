import { afterEach, describe, expect, it } from "vitest";
import { createGuardedLegacyStoreAdapter } from "@tagent/persistence-sqlite/sqlite";
import { Store } from "@tagent/persistence-sqlite/store";
import { CoreWriterLease, WriterFenceGuard } from "@tagent/persistence-sqlite/writer";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

function fixture() {
  const store = new Store(":memory:");
  stores.push(store);
  const writer = CoreWriterLease.claim(store.db, {
    ownerId: "active-writer", pid: process.pid, host: "test",
  })!;
  const adapter = createGuardedLegacyStoreAdapter(store, new WriterFenceGuard(store.db, writer.authority));
  const session = adapter.sessions.createSession();
  for (let index = 0; index < 2; index += 1) {
    const run = adapter.taskRuns.createRun(session.id, `active-${index}`);
    store.transitionRun(run.id, ["running"], "completed", "run.completed", {}, "done", 1);
  }
  store.db.prepare("UPDATE learning_projection_outbox SET status='completed' WHERE outbox_sequence=1").run();
  return { store, integration: adapter.learningIntegration };
}

describe("Learning v33 active delivery", () => {
  it("adopts a completed legacy effect, fences receipts, and never ACKs without its checkpoint", () => {
    const { store, integration } = fixture();
    const authority = integration.authority.acquire({
      source: "legacy", owner: "legacy-active", leaseMs: 1_000, timestamp: 100,
    })!;
    expect(integration.authority.renew({
      fence: authority.fence, leaseMs: 1_000, timestamp: 101,
    })?.state.leaseUntil).toBe(1_101);

    const adopted = integration.delivery.claimNextActive({
      consumer: "learning-active-v1",
      source: "legacy",
      authority: authority.fence,
      owner: "legacy-worker",
      leaseMs: 100,
      timestamp: 102,
    })!;
    expect(adopted).toMatchObject({
      effectDisposition: "adopt_legacy_completed",
      fence: { outboxSequence: 1, leaseSource: "legacy", authorityGeneration: 1 },
    });

    const receipt = integration.effects.record({
      logicalConsumer: "learning-active-v1",
      sourceEventId: adopted.fence.sourceEventId,
      effectHash: "effect-one",
      timestamp: 103,
    });
    expect(integration.effects.record({
      logicalConsumer: "learning-active-v1",
      sourceEventId: adopted.fence.sourceEventId,
      effectHash: "effect-one",
      timestamp: 999,
    })).toEqual(receipt);
    expect(() => integration.effects.record({
      logicalConsumer: "learning-active-v1",
      sourceEventId: adopted.fence.sourceEventId,
      effectHash: "different-effect",
      timestamp: 104,
    })).toThrow(/effect receipt conflict/i);
    expect(integration.delivery.acknowledgeActive({
      claim: adopted, effectHash: "effect-one", timestamp: 104,
    })).toMatchObject({ watermark: 1, deliveryRole: "legacy" });
    expect(integration.authority.getState()).toMatchObject({ legacyLastAcked: 1 });
    expect(store.db.prepare(`SELECT status,error FROM learning_projection_outbox
      WHERE outbox_sequence=1`).get()).toEqual({ status: "completed", error: "" });

    const second = integration.delivery.claimNextActive({
      consumer: "learning-active-v1",
      source: "legacy",
      authority: authority.fence,
      owner: "legacy-worker",
      leaseMs: 100,
      timestamp: 105,
    })!;
    const failedSnapshot = {
      checkpoint: integration.delivery.getCheckpoint("learning-active-v1", "legacy"),
      authority: integration.authority.getState(),
    };
    expect(integration.delivery.failActive({
      claim: {
        ...second,
        fence: { ...second.fence, authorityGeneration: second.fence.authorityGeneration + 1 },
      },
      timestamp: 106,
    })).toBe(false);
    expect(integration.delivery.failActive({ claim: second, timestamp: 106 })).toBe(true);
    expect({
      checkpoint: integration.delivery.getCheckpoint("learning-active-v1", "legacy"),
      authority: integration.authority.getState(),
    }).toEqual(failedSnapshot);
    expect(store.db.prepare(`SELECT status FROM learning_projection_outbox
      WHERE outbox_sequence=2`).get()).toEqual({ status: "failed" });
    const retried = integration.delivery.claimNextActive({
      consumer: "learning-active-v1",
      source: "legacy",
      authority: authority.fence,
      owner: "legacy-worker",
      leaseMs: 100,
      timestamp: 107,
    })!;
    integration.effects.record({
      logicalConsumer: "learning-active-v1",
      sourceEventId: retried.fence.sourceEventId,
      effectHash: "effect-two",
      timestamp: 108,
    });
    const before = {
      delivery: store.db.prepare(`SELECT * FROM integration_consumer_delivery
        WHERE outbox_sequence=2 AND consumer='learning-active-v1'`).get(),
      checkpoint: integration.delivery.getCheckpoint("learning-active-v1", "legacy"),
      authority: integration.authority.getState(),
    };
    store.db.exec(`CREATE TEMP TRIGGER reject_active_checkpoint
      BEFORE UPDATE ON learning_projection_checkpoint
      WHEN OLD.consumer='learning-active-v1'
      BEGIN SELECT RAISE(ABORT,'reject active checkpoint'); END`);
    expect(() => integration.delivery.acknowledgeActive({
      claim: retried, effectHash: "effect-two", timestamp: 109,
    })).toThrow(/reject active checkpoint/);
    expect({
      delivery: store.db.prepare(`SELECT * FROM integration_consumer_delivery
        WHERE outbox_sequence=2 AND consumer='learning-active-v1'`).get(),
      checkpoint: integration.delivery.getCheckpoint("learning-active-v1", "legacy"),
      authority: integration.authority.getState(),
    }).toEqual(before);
    store.db.exec("DROP TRIGGER reject_active_checkpoint");
    expect(integration.delivery.acknowledgeActive({
      claim: retried, effectHash: "effect-two", timestamp: 110,
    })).toMatchObject({ watermark: 2, deliveryRole: "legacy" });
    expect(store.db.prepare(`SELECT status,error FROM learning_projection_outbox
      WHERE outbox_sequence=2`).get()).toEqual({ status: "completed", error: "" });
  });
});
