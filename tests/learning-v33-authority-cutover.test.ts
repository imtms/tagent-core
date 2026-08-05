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
    ownerId: "cutover-writer", pid: process.pid, host: "test",
  })!;
  const adapter = createGuardedLegacyStoreAdapter(store, new WriterFenceGuard(store.db, writer.authority));
  const session = adapter.sessions.createSession();
  for (let index = 0; index < 2; index += 1) {
    const run = adapter.taskRuns.createRun(session.id, `cutover-${index}`);
    store.transitionRun(run.id, ["running"], "completed", "run.completed", {}, "done", 1);
  }
  return { store, integration: adapter.learningIntegration };
}

describe("Learning v33 authority cutover", () => {
  it("fails closed when the frozen reconciliation prefix changes before activation", () => {
    const { store, integration } = fixture();
    const shadow = new ShadowLearningProjectionWorker(integration, {
      owner: "shadow", leaseMs: 1_000,
    });
    expect(shadow.runOnce(100)).toMatchObject({ kind: "matched", watermark: 1 });

    const legacy = integration.authority.acquire({
      source: "legacy", owner: "authority", leaseMs: 1_000, timestamp: 101,
    })!;
    const claim = integration.delivery.claimNextActive({
      consumer: "learning-active-v1", source: "legacy", authority: legacy.fence,
      owner: "legacy-worker", leaseMs: 100, timestamp: 102,
    })!;
    integration.effects.record({
      logicalConsumer: "learning-active-v1", sourceEventId: claim.fence.sourceEventId,
      effectHash: "legacy-one", timestamp: 103,
    });
    integration.delivery.acknowledgeActive({
      claim, effectHash: "legacy-one", timestamp: 104,
    });
    const switching = integration.authority.prepareCutover({
      fence: legacy.fence, switchWatermark: 1, timestamp: 105,
    })!;

    store.db.prepare("UPDATE integration_reconciliation SET status='blocker' WHERE outbox_sequence=1").run();

    expect(integration.authority.activateIntegration({
      fence: switching.fence, leaseMs: 1_000, timestamp: 106,
    })).toBeNull();
    expect(integration.authority.getState()).toMatchObject({
      activeSource: "legacy",
      status: "switching",
      switchWatermark: 1,
    });
  });

  it("cuts over at W+1 and rolls shared ACKs back without dual authority or source rewriting", () => {
    const { store, integration } = fixture();
    const shadow = new ShadowLearningProjectionWorker(integration, {
      owner: "shadow", leaseMs: 1_000,
    });
    expect(shadow.runOnce(100)).toMatchObject({ kind: "matched", watermark: 1 });

    const legacy = integration.authority.acquire({
      source: "legacy", owner: "authority", leaseMs: 1_000, timestamp: 101,
    })!;
    const legacyOne = integration.delivery.claimNextActive({
      consumer: "learning-active-v1", source: "legacy", authority: legacy.fence,
      owner: "legacy-worker", leaseMs: 100, timestamp: 102,
    })!;
    integration.effects.record({
      logicalConsumer: "learning-active-v1", sourceEventId: legacyOne.fence.sourceEventId,
      effectHash: "legacy-one", timestamp: 103,
    });
    integration.delivery.acknowledgeActive({
      claim: legacyOne, effectHash: "legacy-one", timestamp: 104,
    });

    const switching = integration.authority.prepareCutover({
      fence: legacy.fence, switchWatermark: 1, timestamp: 105,
    })!;
    const activeIntegration = integration.authority.activateIntegration({
      fence: switching.fence, leaseMs: 1_000, timestamp: 106,
    })!;
    const integrationTwo = integration.delivery.claimNextActive({
      consumer: "learning-active-v1", source: "integration",
      authority: activeIntegration.fence, owner: "integration-worker", leaseMs: 100, timestamp: 107,
    })!;
    expect(integrationTwo.fence.outboxSequence).toBe(2);

    const beforeStale = {
      deliveries: store.db.prepare("SELECT * FROM integration_consumer_delivery ORDER BY outbox_sequence").all(),
      checkpoints: store.db.prepare("SELECT * FROM learning_projection_checkpoint ORDER BY delivery_role").all(),
      authority: integration.authority.getState(),
    };
    expect(integration.delivery.claimNextActive({
      consumer: "learning-active-v1", source: "legacy", authority: legacy.fence,
      owner: "stale-legacy", leaseMs: 100, timestamp: 108,
    })).toBeNull();
    expect({
      deliveries: store.db.prepare("SELECT * FROM integration_consumer_delivery ORDER BY outbox_sequence").all(),
      checkpoints: store.db.prepare("SELECT * FROM learning_projection_checkpoint ORDER BY delivery_role").all(),
      authority: integration.authority.getState(),
    }).toEqual(beforeStale);

    integration.effects.record({
      logicalConsumer: "learning-active-v1", sourceEventId: integrationTwo.fence.sourceEventId,
      effectHash: "integration-two", timestamp: 109,
    });
    integration.delivery.acknowledgeActive({
      claim: integrationTwo, effectHash: "integration-two", timestamp: 110,
    });
    const rollback = integration.authority.prepareRollback({
      fence: activeIntegration.fence, timestamp: 111,
    })!;
    const activeLegacy = integration.authority.activateLegacy({
      fence: rollback.fence, leaseMs: 1_000, timestamp: 112,
    })!;

    expect(integration.delivery.claimNextActive({
      consumer: "learning-active-v1", source: "legacy", authority: activeLegacy.fence,
      owner: "legacy-worker", leaseMs: 100, timestamp: 113,
    })).toBeNull();
    expect(integration.delivery.getCheckpoint("learning-active-v1", "legacy")?.watermark).toBe(2);
    expect(store.db.prepare(`SELECT lease_source as leaseSource,status
      FROM integration_consumer_delivery WHERE outbox_sequence=2 AND consumer='learning-active-v1'`).get())
      .toEqual({ leaseSource: "integration", status: "acked" });
    expect(integration.authority.getState()).toMatchObject({
      activeSource: "legacy",
      status: "legacy_active",
      generation: 3,
      switchWatermark: 1,
      legacyResumePosition: 2,
      legacyLastAcked: 2,
      integrationCheckpoint: 2,
      rollbackCheckpoint: 2,
    });

    const finalSnapshot = {
      deliveries: store.db.prepare("SELECT * FROM integration_consumer_delivery ORDER BY outbox_sequence").all(),
      checkpoints: store.db.prepare("SELECT * FROM learning_projection_checkpoint ORDER BY delivery_role").all(),
      authority: integration.authority.getState(),
    };
    expect(integration.delivery.claimNextActive({
      consumer: "learning-active-v1", source: "integration", authority: activeIntegration.fence,
      owner: "stale-integration", leaseMs: 100, timestamp: 114,
    })).toBeNull();
    expect({
      deliveries: store.db.prepare("SELECT * FROM integration_consumer_delivery ORDER BY outbox_sequence").all(),
      checkpoints: store.db.prepare("SELECT * FROM learning_projection_checkpoint ORDER BY delivery_role").all(),
      authority: integration.authority.getState(),
    }).toEqual(finalSnapshot);
  });
});
