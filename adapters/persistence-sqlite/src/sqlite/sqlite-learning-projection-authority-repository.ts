import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  LEARNING_ACTIVE_CONSUMER,
  LEARNING_SHADOW_CONSUMER,
  type LearningProjectionAuthorityFence,
  type LearningProjectionAuthorityLease,
  type LearningProjectionAuthorityState,
} from "@tagent/learning/domain";
import type {
  AcquireLearningProjectionAuthorityInput,
  LearningProjectionAuthorityRepository,
  PrepareLearningProjectionCutoverInput,
  PrepareLearningProjectionRollbackInput,
  ReleaseLearningProjectionAuthorityInput,
  RenewLearningProjectionAuthorityInput,
  RotateLearningProjectionAuthorityInput,
} from "@tagent/learning/ports";

function assertMutationTransaction(db: Database.Database): void {
  if (!db.inTransaction) {
    throw new Error("Learning projection authority mutation requires a writer-fenced transaction");
  }
}

function assertTimestamp(timestamp: number): void {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError("Learning projection authority timestamp is invalid");
  }
}

function assertLease(timestamp: number, leaseMs: number): void {
  assertTimestamp(timestamp);
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0
    || !Number.isSafeInteger(timestamp + leaseMs)) {
    throw new TypeError("Learning projection authority leaseMs must be a positive safe integer");
  }
}

function state(db: Database.Database): LearningProjectionAuthorityState {
  const row = db.prepare(`SELECT active_source as activeSource,generation,owner,token,
    lease_until as leaseUntil,switch_watermark as switchWatermark,
    legacy_last_acked as legacyLastAcked,legacy_resume_position as legacyResumePosition,
    integration_checkpoint as integrationCheckpoint,rollback_checkpoint as rollbackCheckpoint,status
    FROM learning_projection_authority_state WHERE id=1`).get() as LearningProjectionAuthorityState | undefined;
  if (!row) throw new Error("Learning projection authority singleton is missing");
  return row;
}

function lease(current: LearningProjectionAuthorityState): LearningProjectionAuthorityLease {
  if (!current.owner || !current.token || current.leaseUntil === null) {
    throw new Error("Learning projection authority lease is incomplete");
  }
  return {
    fence: {
      activeSource: current.activeSource,
      generation: current.generation,
      owner: current.owner,
      token: current.token,
    },
    state: current as LearningProjectionAuthorityLease["state"],
  };
}

function matchesFence(current: LearningProjectionAuthorityState, fence: LearningProjectionAuthorityFence): boolean {
  return current.activeSource === fence.activeSource
    && current.generation === fence.generation
    && current.owner === fence.owner
    && current.token === fence.token;
}

function liveFence(
  current: LearningProjectionAuthorityState,
  fence: LearningProjectionAuthorityFence,
  timestamp: number,
): boolean {
  return matchesFence(current, fence)
    && current.leaseUntil !== null
    && current.leaseUntil > timestamp;
}

function hasLiveDelivery(
  db: Database.Database,
  source: "legacy" | "integration",
  timestamp: number,
): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM integration_consumer_delivery
    WHERE consumer=? AND lease_source=? AND status='leased' AND lease_until>? LIMIT 1`)
    .get(LEARNING_ACTIVE_CONSUMER, source, timestamp));
}

function contiguousReconciliationWatermark(db: Database.Database): number {
  const rows = db.prepare(`SELECT outbox.outbox_sequence as sequence,reconciliation.status
    FROM integration_outbox outbox LEFT JOIN integration_reconciliation reconciliation
      ON reconciliation.source_event_id=outbox.source_event_id
    ORDER BY outbox.outbox_sequence`).all() as Array<{ sequence: number; status: string | null }>;
  let watermark = 0;
  for (const row of rows) {
    if (row.sequence !== watermark + 1 || row.status !== "match") break;
    watermark = row.sequence;
  }
  return watermark;
}

function checkpoint(
  db: Database.Database,
  consumer: string,
  role: "legacy" | "integration" | "shadow",
): { watermark: number; generation: number } | null {
  return db.prepare(`SELECT watermark,generation FROM learning_projection_checkpoint
    WHERE consumer=? AND delivery_role=?`).get(consumer, role) as {
    watermark: number;
    generation: number;
  } | undefined ?? null;
}

export class SqliteLearningProjectionAuthorityRepository
implements LearningProjectionAuthorityRepository {
  constructor(private readonly db: Database.Database) {}

  getState(): LearningProjectionAuthorityState {
    return state(this.db);
  }

  acquire(input: AcquireLearningProjectionAuthorityInput): LearningProjectionAuthorityLease | null {
    assertMutationTransaction(this.db);
    assertLease(input.timestamp, input.leaseMs);
    if (!input.owner) throw new TypeError("Learning projection authority owner is required");
    const current = state(this.db);
    if (current.activeSource !== input.source) return null;
    if (current.leaseUntil !== null && current.leaseUntil > input.timestamp) {
      return current.owner === input.owner ? lease(current) : null;
    }
    const token = randomUUID();
    const nextGeneration = current.generation + 1;
    const changed = this.db.prepare(`UPDATE learning_projection_authority_state SET
      generation=?,owner=?,token=?,lease_until=?
      WHERE id=1 AND active_source=? AND generation=?
        AND (lease_until IS NULL OR lease_until<=?)`).run(
      nextGeneration,
      input.owner,
      token,
      input.timestamp + input.leaseMs,
      input.source,
      current.generation,
      input.timestamp,
    );
    return changed.changes === 1 ? lease(state(this.db)) : null;
  }

  renew(input: RenewLearningProjectionAuthorityInput): LearningProjectionAuthorityLease | null {
    assertMutationTransaction(this.db);
    assertLease(input.timestamp, input.leaseMs);
    const current = state(this.db);
    if (!liveFence(current, input.fence, input.timestamp)) return null;
    const changed = this.db.prepare(`UPDATE learning_projection_authority_state SET lease_until=?
      WHERE id=1 AND active_source=? AND generation=? AND owner=? AND token=? AND lease_until>?`)
      .run(
        input.timestamp + input.leaseMs,
        input.fence.activeSource,
        input.fence.generation,
        input.fence.owner,
        input.fence.token,
        input.timestamp,
      );
    return changed.changes === 1 ? lease(state(this.db)) : null;
  }

  release(input: ReleaseLearningProjectionAuthorityInput): LearningProjectionAuthorityState | null {
    assertMutationTransaction(this.db);
    const changed = this.db.prepare(`UPDATE learning_projection_authority_state
      SET owner=NULL,token=NULL,lease_until=NULL
      WHERE id=1 AND active_source=? AND generation=? AND owner=? AND token=?`).run(
      input.fence.activeSource,
      input.fence.generation,
      input.fence.owner,
      input.fence.token,
    );
    return changed.changes === 1 ? state(this.db) : null;
  }

  prepareCutover(input: PrepareLearningProjectionCutoverInput): LearningProjectionAuthorityLease | null {
    assertMutationTransaction(this.db);
    assertTimestamp(input.timestamp);
    if (!Number.isSafeInteger(input.switchWatermark) || input.switchWatermark < 0) {
      throw new TypeError("Learning projection switchWatermark is invalid");
    }
    const current = state(this.db);
    if (!liveFence(current, input.fence, input.timestamp)
      || current.status !== "legacy_active"
      || current.activeSource !== "legacy") return null;
    if (hasLiveDelivery(this.db, "legacy", input.timestamp)) return null;
    const legacyCheckpoint = checkpoint(this.db, LEARNING_ACTIVE_CONSUMER, "legacy");
    const shadowCheckpoint = checkpoint(this.db, LEARNING_SHADOW_CONSUMER, "shadow");
    if (!legacyCheckpoint
      || legacyCheckpoint.watermark !== input.switchWatermark
      || current.legacyLastAcked !== input.switchWatermark
      || !shadowCheckpoint
      || shadowCheckpoint.watermark < input.switchWatermark
      || contiguousReconciliationWatermark(this.db) !== input.switchWatermark) return null;

    const changed = this.db.prepare(`UPDATE learning_projection_authority_state SET
      status='switching',switch_watermark=?,legacy_last_acked=?,legacy_resume_position=?
      WHERE id=1 AND active_source='legacy' AND status='legacy_active'
        AND generation=? AND owner=? AND token=? AND lease_until>?`).run(
      input.switchWatermark,
      input.switchWatermark,
      input.switchWatermark + 1,
      input.fence.generation,
      input.fence.owner,
      input.fence.token,
      input.timestamp,
    );
    return changed.changes === 1 ? lease(state(this.db)) : null;
  }

  activateIntegration(input: RotateLearningProjectionAuthorityInput): LearningProjectionAuthorityLease | null {
    assertMutationTransaction(this.db);
    assertLease(input.timestamp, input.leaseMs);
    const current = state(this.db);
    if (!liveFence(current, input.fence, input.timestamp)
      || current.status !== "switching"
      || current.activeSource !== "legacy"
      || hasLiveDelivery(this.db, "legacy", input.timestamp)) return null;
    const legacyCheckpoint = checkpoint(this.db, LEARNING_ACTIVE_CONSUMER, "legacy");
    const shadowCheckpoint = checkpoint(this.db, LEARNING_SHADOW_CONSUMER, "shadow");
    if (!legacyCheckpoint
      || legacyCheckpoint.watermark !== current.switchWatermark
      || current.legacyLastAcked !== current.switchWatermark
      || !shadowCheckpoint
      || shadowCheckpoint.watermark < current.switchWatermark
      || contiguousReconciliationWatermark(this.db) < current.switchWatermark) return null;
    const integrationCheckpoint = checkpoint(this.db, LEARNING_ACTIVE_CONSUMER, "integration");
    if (integrationCheckpoint && integrationCheckpoint.watermark > current.switchWatermark) return null;

    const nextGeneration = current.generation + 1;
    const token = randomUUID();
    this.db.prepare(`INSERT INTO learning_projection_checkpoint
      (consumer,delivery_role,watermark,generation,updated_at) VALUES (?,'integration',?,?,?)
      ON CONFLICT(consumer,delivery_role) DO UPDATE SET
        watermark=excluded.watermark,generation=excluded.generation,updated_at=excluded.updated_at`)
      .run(
        LEARNING_ACTIVE_CONSUMER,
        current.switchWatermark,
        nextGeneration,
        input.timestamp,
      );
    const changed = this.db.prepare(`UPDATE learning_projection_authority_state SET
      active_source='integration',status='integration_active',generation=?,token=?,lease_until=?,
      integration_checkpoint=?
      WHERE id=1 AND active_source='legacy' AND status='switching'
        AND generation=? AND owner=? AND token=? AND lease_until>?`).run(
      nextGeneration,
      token,
      input.timestamp + input.leaseMs,
      current.switchWatermark,
      input.fence.generation,
      input.fence.owner,
      input.fence.token,
      input.timestamp,
    );
    if (changed.changes !== 1) throw new Error("Learning projection integration activation lost authority");
    return lease(state(this.db));
  }

  prepareRollback(input: PrepareLearningProjectionRollbackInput): LearningProjectionAuthorityLease | null {
    assertMutationTransaction(this.db);
    assertTimestamp(input.timestamp);
    const current = state(this.db);
    if (!liveFence(current, input.fence, input.timestamp)
      || current.status !== "integration_active"
      || current.activeSource !== "integration"
      || hasLiveDelivery(this.db, "integration", input.timestamp)) return null;
    const integrationCheckpoint = checkpoint(this.db, LEARNING_ACTIVE_CONSUMER, "integration");
    if (!integrationCheckpoint || integrationCheckpoint.watermark !== current.integrationCheckpoint) return null;
    const changed = this.db.prepare(`UPDATE learning_projection_authority_state SET
      status='rollback',rollback_checkpoint=?
      WHERE id=1 AND active_source='integration' AND status='integration_active'
        AND generation=? AND owner=? AND token=? AND lease_until>?`).run(
      integrationCheckpoint.watermark,
      input.fence.generation,
      input.fence.owner,
      input.fence.token,
      input.timestamp,
    );
    return changed.changes === 1 ? lease(state(this.db)) : null;
  }

  activateLegacy(input: RotateLearningProjectionAuthorityInput): LearningProjectionAuthorityLease | null {
    assertMutationTransaction(this.db);
    assertLease(input.timestamp, input.leaseMs);
    const current = state(this.db);
    if (!liveFence(current, input.fence, input.timestamp)
      || current.status !== "rollback"
      || current.activeSource !== "integration"
      || hasLiveDelivery(this.db, "integration", input.timestamp)) return null;
    const legacyCheckpoint = checkpoint(this.db, LEARNING_ACTIVE_CONSUMER, "legacy");
    if (!legacyCheckpoint || legacyCheckpoint.watermark !== current.switchWatermark) return null;

    const nextGeneration = current.generation + 1;
    const token = randomUUID();
    this.db.prepare(`UPDATE learning_projection_checkpoint SET generation=?,updated_at=?
      WHERE consumer=? AND delivery_role='legacy' AND watermark=?`).run(
      nextGeneration,
      input.timestamp,
      LEARNING_ACTIVE_CONSUMER,
      current.switchWatermark,
    );
    const changed = this.db.prepare(`UPDATE learning_projection_authority_state SET
      active_source='legacy',status='legacy_active',generation=?,token=?,lease_until=?
      WHERE id=1 AND active_source='integration' AND status='rollback'
        AND generation=? AND owner=? AND token=? AND lease_until>?`).run(
      nextGeneration,
      token,
      input.timestamp + input.leaseMs,
      input.fence.generation,
      input.fence.owner,
      input.fence.token,
      input.timestamp,
    );
    if (changed.changes !== 1) throw new Error("Learning projection legacy activation lost authority");
    return lease(state(this.db));
  }
}
