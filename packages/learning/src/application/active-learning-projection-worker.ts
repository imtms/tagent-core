import {
  LEARNING_ACTIVE_CONSUMER,
  canonicalLearningProjectionDigest,
  decodeIntegrationLearningProjection,
  decodeLegacyLearningProjection,
  type DecodedLearningProjection,
  type LearningProjectionAuthorityLease,
  type LearningProjectionAuthoritySource,
  type LearningProjectionAuthorityState,
} from "../domain/learning-projection.js";
import type { ActiveLearningProjectionEffectApplier } from "../ports/active-learning-projection-effect.js";
import type { LearningProjectionIntegrationPersistencePort } from "../ports/learning-projection-integration.js";

export interface ActiveLearningProjectionWorkerOptions {
  owner: string;
  leaseMs: number;
  clock?: () => number;
}

export type ActiveLearningProjectionWorkerResult =
  | { kind: "paused"; source: LearningProjectionAuthoritySource }
  | {
      kind: "inactive";
      source: LearningProjectionAuthoritySource;
      status: LearningProjectionAuthorityState["status"];
    }
  | { kind: "idle"; source: LearningProjectionAuthoritySource; watermark: number }
  | { kind: "stale"; source: LearningProjectionAuthoritySource; outboxSequence: number }
  | {
      kind: "applied" | "adopted" | "replayed";
      source: LearningProjectionAuthoritySource;
      outboxSequence: number;
      sourceEventId: string;
      effectHash: string;
      watermark: number;
    }
  | {
      kind: "failed";
      source: LearningProjectionAuthoritySource;
      outboxSequence: number;
      sourceEventId: string;
      effectHash: string;
      error: string;
    };

export function learningProjectionEffectHash(projection: DecodedLearningProjection): string {
  return canonicalLearningProjectionDigest(projection);
}

function assertTimestamp(timestamp: number): void {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError("Active Learning projection timestamp is invalid");
  }
}

function isActive(state: LearningProjectionAuthorityState): boolean {
  return state.status === (state.activeSource === "legacy" ? "legacy_active" : "integration_active");
}

function sameLease(
  lease: LearningProjectionAuthorityLease,
  state: LearningProjectionAuthorityState,
  owner: string,
): boolean {
  return state.owner === owner
    && state.activeSource === lease.fence.activeSource
    && state.generation === lease.fence.generation
    && state.token === lease.fence.token;
}

/**
 * Synchronous active consumer. The business mutation and effect receipt share
 * one writer UnitOfWork; delivery ACK intentionally commits afterward.
 */
export class ActiveLearningProjectionWorker {
  private authorityLease: LearningProjectionAuthorityLease | null = null;
  private paused = false;
  private activeCalls = 0;
  private readonly clock: () => number;

  constructor(
    private readonly persistence: LearningProjectionIntegrationPersistencePort,
    private readonly effectApplier: ActiveLearningProjectionEffectApplier,
    private readonly options: ActiveLearningProjectionWorkerOptions,
  ) {
    if (!options.owner) throw new TypeError("Active Learning projection owner is required");
    if (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0) {
      throw new TypeError("Active Learning projection leaseMs must be a positive safe integer");
    }
    this.clock = options.clock ?? Date.now;
  }

  get inFlight(): number {
    return this.activeCalls;
  }

  pause(): boolean {
    this.paused = true;
    return this.activeCalls === 0;
  }

  resume(): void {
    this.paused = false;
  }

  renewAuthority(timestamp = Date.now()): LearningProjectionAuthorityLease | null {
    assertTimestamp(timestamp);
    const state = this.persistence.authority.getState();
    if (this.authorityLease && sameLease(this.authorityLease, state, this.options.owner)) {
      const renewed = this.persistence.authority.renew({
        fence: this.authorityLease.fence,
        leaseMs: this.options.leaseMs,
        timestamp,
      });
      if (renewed) {
        this.authorityLease = renewed;
        return renewed;
      }
    }
    this.authorityLease = this.persistence.authority.acquire({
      source: state.activeSource,
      owner: this.options.owner,
      leaseMs: this.options.leaseMs,
      timestamp,
    });
    return this.authorityLease;
  }

  releaseAuthority(): boolean {
    const lease = this.authorityLease;
    if (!lease) return false;
    const released = this.persistence.authority.release({ fence: lease.fence });
    if (!released) return false;
    this.authorityLease = null;
    return true;
  }

  /** Used only by the authority coordinator after a successful generation rotation. */
  acceptAuthorityLease(lease: LearningProjectionAuthorityLease): void {
    if (lease.state.owner !== this.options.owner) {
      throw new Error("Active Learning projection cannot accept another owner's authority lease");
    }
    this.authorityLease = lease;
  }

  runOnce(timestamp = Date.now()): ActiveLearningProjectionWorkerResult {
    assertTimestamp(timestamp);
    const initial = this.persistence.authority.getState();
    if (this.paused) return { kind: "paused", source: initial.activeSource };
    if (!isActive(initial)) {
      return { kind: "inactive", source: initial.activeSource, status: initial.status };
    }
    this.activeCalls += 1;
    try {
      const authority = this.renewAuthority(timestamp);
      if (!authority) {
        const current = this.persistence.authority.getState();
        return { kind: "inactive", source: current.activeSource, status: current.status };
      }
      const source = authority.state.activeSource;
      const before = this.persistence.delivery.getCheckpoint(LEARNING_ACTIVE_CONSUMER, source);
      const claim = this.persistence.delivery.claimNextActive({
        consumer: LEARNING_ACTIVE_CONSUMER,
        source,
        authority: authority.fence,
        owner: this.options.owner,
        leaseMs: this.options.leaseMs,
        timestamp,
      });
      if (!claim) {
        const checkpoint = this.persistence.delivery.getCheckpoint(LEARNING_ACTIVE_CONSUMER, source);
        return { kind: "idle", source, watermark: checkpoint?.watermark ?? before?.watermark ?? 0 };
      }

      let projection: DecodedLearningProjection;
      try {
        if (source === "legacy") {
          if (!claim.legacy) throw new Error("Active legacy claim is missing its legacy projection");
          projection = decodeLegacyLearningProjection(claim.legacy);
        } else {
          projection = decodeIntegrationLearningProjection(claim.integration);
        }
      } catch (error) {
        this.persistence.delivery.failActive({ claim, timestamp: this.settlementTimestamp(timestamp) });
        return this.failed(source, claim.fence.outboxSequence, claim.fence.sourceEventId, "", error);
      }

      const effectHash = learningProjectionEffectHash(projection);
      let completion: "applied" | "adopted" | "replayed";
      try {
        completion = this.persistence.unitOfWork.run(() => {
          const existing = this.persistence.effects.get(LEARNING_ACTIVE_CONSUMER, claim.fence.sourceEventId);
          if (existing) {
            if (existing.effectHash !== effectHash) {
              throw new Error(`Learning effect receipt conflict for ${claim.fence.sourceEventId}`);
            }
            return "replayed" as const;
          }
          if (claim.effectDisposition === "adopt_legacy_completed") {
            if (source !== "legacy") {
              throw new Error("Only a legacy claim may adopt a completed Learning effect");
            }
            this.persistence.effects.record({
              logicalConsumer: LEARNING_ACTIVE_CONSUMER,
              sourceEventId: claim.fence.sourceEventId,
              effectHash,
              timestamp: this.settlementTimestamp(timestamp),
            });
            return "adopted" as const;
          } else {
            this.effectApplier.apply({
              source,
              outboxSequence: claim.fence.outboxSequence,
              sourceEventId: claim.fence.sourceEventId,
              effectHash,
              projection,
            });
            this.persistence.effects.record({
              logicalConsumer: LEARNING_ACTIVE_CONSUMER,
              sourceEventId: claim.fence.sourceEventId,
              effectHash,
              timestamp: this.settlementTimestamp(timestamp),
            });
            return "applied" as const;
          }
        });
      } catch (error) {
        this.persistence.delivery.failActive({ claim, timestamp: this.settlementTimestamp(timestamp) });
        return this.failed(
          source,
          claim.fence.outboxSequence,
          claim.fence.sourceEventId,
          effectHash,
          error,
        );
      }

      const checkpoint = this.persistence.delivery.acknowledgeActive({
        claim,
        effectHash,
        timestamp: this.settlementTimestamp(timestamp),
      });
      if (!checkpoint) {
        return { kind: "stale", source, outboxSequence: claim.fence.outboxSequence };
      }
      return {
        kind: completion,
        source,
        outboxSequence: claim.fence.outboxSequence,
        sourceEventId: claim.fence.sourceEventId,
        effectHash,
        watermark: checkpoint.watermark,
      };
    } finally {
      this.activeCalls -= 1;
    }
  }

  private failed(
    source: LearningProjectionAuthoritySource,
    outboxSequence: number,
    sourceEventId: string,
    effectHash: string,
    error: unknown,
  ): ActiveLearningProjectionWorkerResult {
    return {
      kind: "failed",
      source,
      outboxSequence,
      sourceEventId,
      effectHash,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  private settlementTimestamp(entryTimestamp: number): number {
    const current = this.clock();
    assertTimestamp(current);
    return Math.max(entryTimestamp, current);
  }
}

export type LearningProjectionAuthorityTransitionResult =
  | {
      kind: "activated";
      source: LearningProjectionAuthoritySource;
      switchWatermark: number;
      state: LearningProjectionAuthorityState;
    }
  | {
      kind: "blocked";
      phase: "quiesce" | "authority" | "prepare" | "activate";
      state: LearningProjectionAuthorityState;
    };

/** Coordinates only durable authority rotation; runtime timer quiescence stays outside this package. */
export class LearningProjectionAuthorityCoordinator {
  constructor(
    private readonly persistence: LearningProjectionIntegrationPersistencePort,
    private readonly worker: ActiveLearningProjectionWorker,
  ) {}

  renew(timestamp = Date.now()): LearningProjectionAuthorityLease | null {
    return this.worker.renewAuthority(timestamp);
  }

  cutover(timestamp = Date.now()): LearningProjectionAuthorityTransitionResult {
    assertTimestamp(timestamp);
    if (!this.worker.pause()) return this.blocked("quiesce");
    const authority = this.worker.renewAuthority(timestamp);
    if (!authority || authority.state.activeSource !== "legacy"
      || (authority.state.status !== "legacy_active" && authority.state.status !== "switching")) {
      return this.blocked("authority");
    }
    const switchWatermark = authority.state.status === "switching"
      ? authority.state.switchWatermark
      : this.persistence.reconciliation.getContiguousWatermark();
    let switching = authority;
    if (authority.state.status === "legacy_active") {
      const prepared = this.persistence.authority.prepareCutover({
        fence: authority.fence,
        switchWatermark,
        timestamp,
      });
      if (!prepared) {
        this.worker.resume();
        return this.blocked("prepare");
      }
      switching = prepared;
    }
    this.worker.acceptAuthorityLease(switching);
    const active = this.persistence.authority.activateIntegration({
      fence: switching.fence,
      leaseMs: this.leaseDuration(authority, timestamp),
      timestamp,
    });
    if (!active) return this.blocked("activate");
    this.worker.acceptAuthorityLease(active);
    this.worker.resume();
    return {
      kind: "activated",
      source: "integration",
      switchWatermark,
      state: active.state,
    };
  }

  rollback(timestamp = Date.now()): LearningProjectionAuthorityTransitionResult {
    assertTimestamp(timestamp);
    if (!this.worker.pause()) return this.blocked("quiesce");
    const authority = this.worker.renewAuthority(timestamp);
    if (!authority
      || authority.state.activeSource !== "integration"
      || (authority.state.status !== "integration_active" && authority.state.status !== "rollback")) {
      return this.blocked("authority");
    }
    let rollback = authority;
    if (authority.state.status === "integration_active") {
      const prepared = this.persistence.authority.prepareRollback({
        fence: authority.fence,
        timestamp,
      });
      if (!prepared) {
        this.worker.resume();
        return this.blocked("prepare");
      }
      rollback = prepared;
    }
    this.worker.acceptAuthorityLease(rollback);
    const active = this.persistence.authority.activateLegacy({
      fence: rollback.fence,
      leaseMs: this.leaseDuration(authority, timestamp),
      timestamp,
    });
    if (!active) return this.blocked("activate");
    this.worker.acceptAuthorityLease(active);
    this.worker.resume();
    return {
      kind: "activated",
      source: "legacy",
      switchWatermark: active.state.switchWatermark,
      state: active.state,
    };
  }

  private leaseDuration(lease: LearningProjectionAuthorityLease, timestamp: number): number {
    return Math.max(1, lease.state.leaseUntil - timestamp);
  }

  private blocked(
    phase: Extract<LearningProjectionAuthorityTransitionResult, { kind: "blocked" }>["phase"],
  ): LearningProjectionAuthorityTransitionResult {
    return { kind: "blocked", phase, state: this.persistence.authority.getState() };
  }
}
