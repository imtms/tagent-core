import { afterEach, describe, expect, it } from "vitest";
import {
  reconcileLearningProjectionPair,
  type LearningProjectionDeliveryClaim,
} from "@tagent/learning/domain";
import { createGuardedLegacyStoreAdapter } from "@tagent/persistence-sqlite/sqlite";
import { Store } from "@tagent/persistence-sqlite/store";
import { CoreWriterLease, WriterFenceGuard } from "@tagent/persistence-sqlite/writer";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

function fixture() {
  const store = new Store(":memory:"); stores.push(store);
  const writer = CoreWriterLease.claim(store.db, { ownerId: "writer", pid: process.pid, host: "test" })!;
  const adapter = createGuardedLegacyStoreAdapter(store, new WriterFenceGuard(store.db, writer.authority));
  const session = adapter.sessions.createSession();
  for (let index = 0; index < 2; index += 1) {
    const run = adapter.taskRuns.createRun(session.id, `run-${index}`);
    store.transitionRun(run.id, ["running"], "completed", "run.completed", {}, "done", 1);
  }
  return { store, integration: adapter.learningIntegration };
}

function snapshot(store: Store) {
  return {
    deliveries: store.db.prepare("SELECT * FROM integration_consumer_delivery ORDER BY outbox_sequence").all(),
    checkpoints: store.db.prepare("SELECT * FROM learning_projection_checkpoint ORDER BY consumer").all(),
    reconciliations: store.db.prepare("SELECT * FROM integration_reconciliation ORDER BY source_event_id").all(),
  };
}

describe("Learning v33 delivery fencing", () => {
  it("takes over an expired exact-next lease with a new generation and rejects stale fences with zero writes", () => {
    const { store, integration } = fixture();
    const first = integration.delivery.claimNextShadow({
      consumer: "learning-shadow-v1", owner: "shadow-a", leaseMs: 10, timestamp: 100,
    })!;
    expect(first).toMatchObject({
      fence: { outboxSequence: 1, leaseGeneration: 1, leaseSource: "shadow", authorityGeneration: 0, authorityToken: null },
    });
    expect(integration.delivery.claimNextShadow({
      consumer: "learning-shadow-v1", owner: "shadow-b", leaseMs: 10, timestamp: 105,
    })).toBeNull();
    const takeover = integration.delivery.claimNextShadow({
      consumer: "learning-shadow-v1", owner: "shadow-b", leaseMs: 10, timestamp: 111,
    })!;
    expect(takeover.fence.leaseGeneration).toBe(2);
    expect(takeover.fence.leaseToken).not.toBe(first.fence.leaseToken);

    const pair = integration.reconciliation.getProjectionPair(1);
    const result = reconcileLearningProjectionPair(pair.legacy, pair.integration);
    const before = snapshot(store);
    expect(integration.reconciliation.completeShadowClaim({
      claim: first, result, timestamp: 112,
    })).toBeNull();
    expect(snapshot(store)).toEqual(before);
    for (const forged of [
      { leaseSource: "integration" as const },
      { consumer: "learning-active-v1" as const },
      { authorityGeneration: 1 },
      { authorityToken: "active-token" },
    ]) {
      const wrongFence: LearningProjectionDeliveryClaim = {
        ...takeover,
        fence: { ...takeover.fence, ...forged },
      };
      expect(integration.reconciliation.completeShadowClaim({
        claim: wrongFence, result, timestamp: 112,
      })).toBeNull();
      expect(snapshot(store)).toEqual(before);
    }

    expect(integration.reconciliation.completeShadowClaim({
      claim: takeover, result, timestamp: 112,
    })).toMatchObject({ watermark: 1, generation: 2 });
    expect(integration.delivery.claimNextShadow({
      consumer: "learning-shadow-v1", owner: "shadow-b", leaseMs: 10, timestamp: 113,
    })?.fence.outboxSequence).toBe(2);
  });

  it("rolls back reconciliation, ACK, and checkpoint together when the checkpoint write fails", () => {
    const { store, integration } = fixture();
    const claim = integration.delivery.claimNextShadow({
      consumer: "learning-shadow-v1", owner: "shadow-a", leaseMs: 10, timestamp: 100,
    })!;
    const pair = integration.reconciliation.getProjectionPair(1);
    const result = reconcileLearningProjectionPair(pair.legacy, pair.integration);
    const before = snapshot(store);
    store.db.exec(`CREATE TEMP TRIGGER reject_shadow_checkpoint BEFORE UPDATE ON learning_projection_checkpoint
      BEGIN SELECT RAISE(ABORT,'reject shadow checkpoint'); END`);
    expect(() => integration.reconciliation.completeShadowClaim({ claim, result, timestamp: 101 }))
      .toThrow(/reject shadow checkpoint/);
    expect(snapshot(store)).toEqual(before);
  });

  it("rejects a forged match when the current pair changed before ACK", () => {
    const { store, integration } = fixture();
    const claim = integration.delivery.claimNextShadow({
      consumer: "learning-shadow-v1", owner: "shadow-a", leaseMs: 10, timestamp: 100,
    })!;
    const pair = integration.reconciliation.getProjectionPair(1);
    const staleMatch = reconcileLearningProjectionPair(pair.legacy, pair.integration);
    expect(staleMatch.status).toBe("match");
    store.db.prepare("UPDATE learning_projection_outbox SET lifecycle='run.failed'").run();
    const before = snapshot(store);

    expect(integration.reconciliation.completeShadowClaim({
      claim, result: staleMatch, timestamp: 101,
    })).toBeNull();
    expect(snapshot(store)).toEqual(before);
  });
});
