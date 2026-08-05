import {
  LEARNING_SHADOW_CONSUMER,
  reconcileLearningProjectionPair,
  type LearningProjectionReconciliationStatus,
} from "../domain/learning-projection.js";
import type { LearningProjectionIntegrationPersistencePort } from "../ports/learning-projection-integration.js";

export interface ShadowLearningProjectionWorkerOptions {
  owner: string;
  leaseMs: number;
}

export type ShadowLearningProjectionWorkerResult =
  | { kind: "idle"; watermark: number }
  | { kind: "stale"; outboxSequence: number }
  | { kind: "matched"; outboxSequence: number; watermark: number }
  | {
      kind: "blocked";
      outboxSequence: number;
      status: Exclude<LearningProjectionReconciliationStatus, "match">;
    };

/** Side-effect-free shadow: it writes only delivery, reconciliation, and checkpoint control rows. */
export class ShadowLearningProjectionWorker {
  constructor(
    private readonly persistence: LearningProjectionIntegrationPersistencePort,
    private readonly options: ShadowLearningProjectionWorkerOptions,
  ) {
    if (!options.owner) throw new TypeError("Shadow Learning projection owner is required");
    if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0) {
      throw new TypeError("Shadow Learning projection leaseMs must be a positive safe integer");
    }
  }

  runOnce(timestamp = Date.now()): ShadowLearningProjectionWorkerResult {
    const checkpoint = this.persistence.delivery.getCheckpoint(LEARNING_SHADOW_CONSUMER, "shadow");
    const claim = this.persistence.delivery.claimNextShadow({
      consumer: LEARNING_SHADOW_CONSUMER,
      owner: this.options.owner,
      leaseMs: this.options.leaseMs,
      timestamp,
    });
    if (!claim) return { kind: "idle", watermark: checkpoint?.watermark ?? 0 };

    const pair = this.persistence.reconciliation.getProjectionPair(claim.fence.outboxSequence);
    const result = reconcileLearningProjectionPair(pair.legacy, pair.integration);
    const settled = this.persistence.reconciliation.completeShadowClaim({ claim, result, timestamp });
    if (!settled) return { kind: "stale", outboxSequence: claim.fence.outboxSequence };
    if (result.status === "match") {
      return { kind: "matched", outboxSequence: claim.fence.outboxSequence, watermark: settled.watermark };
    }
    return { kind: "blocked", outboxSequence: claim.fence.outboxSequence, status: result.status };
  }
}
