import { afterEach, describe, expect, it } from "vitest";
import {
  ActiveLearningProjectionWorker,
  LearningProjectionAuthorityCoordinator,
  ShadowLearningProjectionWorker,
  WorkflowServiceActiveProjectionApplier,
  learningProjectionEffectHash,
} from "@tagent/learning/application";
import { WorkflowService } from "@tagent/learning";
import {
  decodeIntegrationLearningProjection,
  decodeLegacyLearningProjection,
} from "@tagent/learning/domain";
import { createGuardedLegacyStoreAdapter } from "@tagent/persistence-sqlite/sqlite";
import { Store } from "@tagent/persistence-sqlite/store";
import { CoreWriterLease, WriterFenceGuard } from "@tagent/persistence-sqlite/writer";

const stores: Store[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.close()));

describe("Learning v33 active worker", () => {
  it("adopts, recovers an effect-before-ACK crash, cuts over, and fails closed on receipt conflict", () => {
    const store = new Store(":memory:");
    stores.push(store);
    const writer = CoreWriterLease.claim(store.db, {
      ownerId: "active-worker-writer", pid: process.pid, host: "test",
    })!;
    const adapter = createGuardedLegacyStoreAdapter(store, new WriterFenceGuard(store.db, writer.authority));
    const session = adapter.sessions.createSession();
    for (let index = 0; index < 4; index += 1) {
      const run = adapter.taskRuns.createRun(session.id, `active-worker-${index}`);
      store.transitionRun(run.id, ["running"], "completed", "run.completed", {}, "done", 1);
    }
    store.db.prepare("UPDATE learning_projection_outbox SET status='completed' WHERE outbox_sequence=1").run();
    const shadow = new ShadowLearningProjectionWorker(
      adapter.learningIntegration,
      { owner: "shadow", leaseMs: 1_000 },
    );
    expect(shadow.runOnce(50)).toMatchObject({ kind: "matched", watermark: 1 });
    expect(shadow.runOnce(51)).toMatchObject({ kind: "matched", watermark: 2 });

    const worker = new ActiveLearningProjectionWorker(
      adapter.learningIntegration,
      new WorkflowServiceActiveProjectionApplier(new WorkflowService(adapter.workflow)),
      { owner: "active", leaseMs: 50, clock: () => 0 },
    );
    const coordinator = new LearningProjectionAuthorityCoordinator(adapter.learningIntegration, worker);

    expect(worker.runOnce(90)).toMatchObject({ kind: "adopted", source: "legacy", outboxSequence: 1 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM experience_observations").get())
      .toEqual({ count: 0 });

    store.db.exec(`CREATE TEMP TRIGGER crash_before_active_ack
      BEFORE UPDATE ON integration_consumer_delivery
      WHEN OLD.outbox_sequence=2 AND NEW.status='acked'
      BEGIN SELECT RAISE(ABORT,'crash before active ACK'); END`);
    expect(() => worker.runOnce(100)).toThrow(/crash before active ACK/);
    expect(store.db.prepare("SELECT COUNT(*) count FROM experience_observations").get())
      .toEqual({ count: 1 });
    expect(store.db.prepare(`SELECT status FROM integration_consumer_delivery
      WHERE consumer='learning-active-v1' AND outbox_sequence=2`).get()).toEqual({ status: "leased" });
    expect(adapter.learningIntegration.delivery.getCheckpoint("learning-active-v1", "legacy")?.watermark).toBe(1);

    store.db.exec("DROP TRIGGER crash_before_active_ack");
    expect(worker.runOnce(151)).toMatchObject({ kind: "replayed", source: "legacy", outboxSequence: 2 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM experience_observations").get())
      .toEqual({ count: 1 });

    const pair = adapter.learningIntegration.reconciliation.getProjectionPair(1);
    expect(learningProjectionEffectHash(decodeLegacyLearningProjection(pair.legacy!)))
      .toBe(learningProjectionEffectHash(decodeIntegrationLearningProjection(pair.integration!)));
    store.db.exec(`CREATE TEMP TRIGGER interrupt_integration_activation
      BEFORE UPDATE ON learning_projection_authority_state
      WHEN NEW.status='integration_active'
      BEGIN SELECT RAISE(ABORT,'interrupt integration activation'); END`);
    expect(() => coordinator.cutover(152)).toThrow(/interrupt integration activation/);
    expect(adapter.learningIntegration.authority.getState().status).toBe("switching");
    store.db.exec("DROP TRIGGER interrupt_integration_activation");
    expect(coordinator.cutover(153)).toMatchObject({
      kind: "activated", source: "integration", switchWatermark: 2,
    });
    expect(worker.runOnce(154)).toMatchObject({ kind: "applied", source: "integration", outboxSequence: 3 });
    expect(store.db.prepare("SELECT COUNT(*) count FROM experience_observations").get())
      .toEqual({ count: 2 });

    const fourth = adapter.learningIntegration.reconciliation.getProjectionPair(4).integration!;
    adapter.learningIntegration.effects.record({
      logicalConsumer: "learning-active-v1",
      sourceEventId: fourth.sourceEventId,
      effectHash: "conflicting-effect",
      timestamp: 155,
    });
    expect(worker.runOnce(155)).toMatchObject({
      kind: "failed", source: "integration", outboxSequence: 4,
    });
    expect(store.db.prepare("SELECT COUNT(*) count FROM experience_observations").get())
      .toEqual({ count: 2 });
    expect(adapter.learningIntegration.delivery.getCheckpoint("learning-active-v1", "integration")?.watermark)
      .toBe(3);
  });

  it("does not ACK an effect after its delivery lease expires and replays the durable receipt", () => {
    const store = new Store(":memory:");
    stores.push(store);
    const writer = CoreWriterLease.claim(store.db, {
      ownerId: "active-worker-expiry", pid: process.pid, host: "test",
    })!;
    const adapter = createGuardedLegacyStoreAdapter(store, new WriterFenceGuard(store.db, writer.authority));
    const session = adapter.sessions.createSession();
    const run = adapter.taskRuns.createRun(session.id, "lease expiry");
    store.transitionRun(run.id, ["running"], "completed", "run.completed", {}, "done", 1);
    let clock = 100;
    let applications = 0;
    const worker = new ActiveLearningProjectionWorker(
      adapter.learningIntegration,
      {
        apply: () => {
          applications += 1;
          clock = 151;
        },
      },
      { owner: "active-expiry", leaseMs: 50, clock: () => clock },
    );

    expect(worker.runOnce(100)).toMatchObject({ kind: "stale", source: "legacy", outboxSequence: 1 });
    expect(applications).toBe(1);
    expect(adapter.learningIntegration.delivery.getCheckpoint("learning-active-v1", "legacy")?.watermark ?? 0)
      .toBe(0);
    expect(store.db.prepare("SELECT COUNT(*) count FROM effect_receipts").get())
      .toEqual({ count: 1 });

    clock = 152;
    expect(worker.runOnce(152)).toMatchObject({ kind: "replayed", source: "legacy", outboxSequence: 1 });
    expect(applications).toBe(1);
    expect(adapter.learningIntegration.delivery.getCheckpoint("learning-active-v1", "legacy")?.watermark)
      .toBe(1);
  });
});
