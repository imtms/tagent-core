import {
  LEARNING_PROJECTION_CONSUMER,
  canonicalLearningProjectionDigest,
  decodeIntegrationLearningProjection,
  type DecodedLearningProjection,
} from "../domain/learning-projection.js";
import type { ActiveLearningProjectionEffectApplier } from "../ports/active-learning-projection-effect.js";
import type { LearningProjectionIntegrationPersistencePort } from "../ports/learning-projection-integration.js";

export interface ActiveLearningProjectionWorkerOptions {
  owner: string;
  leaseMs: number;
  clock?: () => number;
}

export type ActiveLearningProjectionWorkerResult =
  | { kind: "idle"; watermark: number }
  | { kind: "stale"; outboxSequence: number }
  | { kind: "applied" | "replayed"; outboxSequence: number; sourceEventId: string; effectHash: string; watermark: number }
  | { kind: "failed"; outboxSequence: number; sourceEventId: string; effectHash: string; error: string };

export function learningProjectionEffectHash(projection: DecodedLearningProjection): string {
  return canonicalLearningProjectionDigest(projection);
}

export class ActiveLearningProjectionWorker {
  private readonly clock: () => number;

  constructor(
    private readonly persistence: LearningProjectionIntegrationPersistencePort,
    private readonly effectApplier: ActiveLearningProjectionEffectApplier,
    private readonly options: ActiveLearningProjectionWorkerOptions,
  ) {
    if (!options.owner.trim()) throw new TypeError("Learning projection owner is required");
    if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0) {
      throw new TypeError("Learning projection leaseMs must be a positive safe integer");
    }
    this.clock = options.clock ?? Date.now;
  }

  runOnce(timestamp = this.clock()): ActiveLearningProjectionWorkerResult {
    const checkpoint = this.persistence.delivery.getCheckpoint(LEARNING_PROJECTION_CONSUMER);
    const claim = this.persistence.delivery.claimNext({
      consumer: LEARNING_PROJECTION_CONSUMER,
      owner: this.options.owner,
      leaseMs: this.options.leaseMs,
      timestamp,
    });
    if (!claim) return { kind: "idle", watermark: checkpoint?.watermark ?? 0 };

    let projection: DecodedLearningProjection;
    try {
      projection = decodeIntegrationLearningProjection(claim.integration);
    } catch (error) {
      this.persistence.delivery.fail({ claim, timestamp: this.settlementTimestamp(timestamp) });
      return this.failed(claim.fence.outboxSequence, claim.fence.sourceEventId, "", error);
    }

    const effectHash = learningProjectionEffectHash(projection);
    let completion: "applied" | "replayed";
    try {
      completion = this.persistence.unitOfWork.run(() => {
        const existing = this.persistence.effects.get(LEARNING_PROJECTION_CONSUMER, claim.fence.sourceEventId);
        if (existing) {
          if (existing.effectHash !== effectHash) {
            throw new Error(`Learning effect receipt conflict for ${claim.fence.sourceEventId}`);
          }
          return "replayed" as const;
        }
        this.effectApplier.apply({
          source: "integration",
          outboxSequence: claim.fence.outboxSequence,
          sourceEventId: claim.fence.sourceEventId,
          effectHash,
          projection,
        });
        this.persistence.effects.record({
          logicalConsumer: LEARNING_PROJECTION_CONSUMER,
          sourceEventId: claim.fence.sourceEventId,
          effectHash,
          timestamp: this.settlementTimestamp(timestamp),
        });
        return "applied" as const;
      });
    } catch (error) {
      this.persistence.delivery.fail({ claim, timestamp: this.settlementTimestamp(timestamp) });
      return this.failed(claim.fence.outboxSequence, claim.fence.sourceEventId, effectHash, error);
    }

    const settled = this.persistence.delivery.acknowledge({
      claim,
      effectHash,
      timestamp: this.settlementTimestamp(timestamp),
    });
    if (!settled) return { kind: "stale", outboxSequence: claim.fence.outboxSequence };
    return {
      kind: completion,
      outboxSequence: claim.fence.outboxSequence,
      sourceEventId: claim.fence.sourceEventId,
      effectHash,
      watermark: settled.watermark,
    };
  }

  private failed(outboxSequence: number, sourceEventId: string, effectHash: string, error: unknown): ActiveLearningProjectionWorkerResult {
    return { kind: "failed", outboxSequence, sourceEventId, effectHash, error: error instanceof Error ? error.message : String(error) };
  }

  private settlementTimestamp(entryTimestamp: number): number {
    return Math.max(entryTimestamp, this.clock());
  }
}
