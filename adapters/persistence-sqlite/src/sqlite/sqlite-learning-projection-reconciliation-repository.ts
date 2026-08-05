import type Database from "better-sqlite3";
import type {
  IntegrationLearningProjectionRecord,
  LearningProjectionCheckpoint,
  LegacyLearningProjectionRecord,
} from "@tagent/learning/domain";
import {
  LEARNING_SHADOW_CONSUMER,
  reconcileLearningProjectionPair,
  type LearningProjectionReconciliation,
} from "@tagent/learning/domain";
import type {
  CompleteShadowLearningProjectionInput,
  LearningProjectionPair,
  LearningProjectionReconciliationRepository,
} from "@tagent/learning/ports";

function assertMutationTransaction(db: Database.Database): void {
  if (!db.inTransaction) {
    throw new Error("Learning projection reconciliation mutation requires a writer-fenced transaction");
  }
}

function legacyRecord(db: Database.Database, sequence: number): LegacyLearningProjectionRecord | null {
  return db.prepare(`SELECT outbox_sequence as outboxSequence,source_event_id as sourceEventId,
    payload_hash as payloadHash,run_id as runId,attempt as attemptOrdinal,attempt_id as attemptId,
    lifecycle,outcome,event_seq as eventSeq,payload_json as payloadJson,snapshot_json as snapshotJson
    FROM learning_projection_outbox WHERE outbox_sequence=?`).get(sequence) as LegacyLearningProjectionRecord | undefined ?? null;
}

function integrationRecord(db: Database.Database, sequence: number): IntegrationLearningProjectionRecord | null {
  return db.prepare(`SELECT outbox_sequence as outboxSequence,source_event_id as sourceEventId,
    payload_hash as payloadHash,aggregate_id as aggregateId,aggregate_version as aggregateVersion,
    run_event_ref as runEventRef,attempt_id as attemptId,attempt_ordinal as attemptOrdinal,
    payload_json as payloadJson,evidence_snapshot_json as evidenceSnapshotJson
    FROM integration_outbox WHERE outbox_sequence=?`).get(sequence) as IntegrationLearningProjectionRecord | undefined ?? null;
}

function checkpoint(db: Database.Database, consumer: string): LearningProjectionCheckpoint {
  const row = db.prepare(`SELECT consumer,delivery_role as deliveryRole,watermark,generation,
    updated_at as updatedAt FROM learning_projection_checkpoint
    WHERE consumer=? AND delivery_role='shadow'`).get(consumer) as LearningProjectionCheckpoint | undefined;
  if (!row) throw new Error(`Shadow Learning projection checkpoint is missing for ${consumer}`);
  return row;
}

function sameReconciliation(
  caller: LearningProjectionReconciliation,
  current: LearningProjectionReconciliation,
): boolean {
  return caller.sourceEventId === current.sourceEventId
    && caller.outboxSequence === current.outboxSequence
    && caller.legacyHash === current.legacyHash
    && caller.integrationHash === current.integrationHash
    && caller.legacySnapshotHash === current.legacySnapshotHash
    && caller.integrationSnapshotHash === current.integrationSnapshotHash
    && caller.legacyDigest === current.legacyDigest
    && caller.integrationDigest === current.integrationDigest
    && caller.status === current.status
    && (caller.detail ?? null) === (current.detail ?? null);
}

export class SqliteLearningProjectionReconciliationRepository
implements LearningProjectionReconciliationRepository {
  constructor(private readonly db: Database.Database) {}

  getProjectionPair(outboxSequence: number): LearningProjectionPair {
    if (!Number.isSafeInteger(outboxSequence) || outboxSequence <= 0) {
      throw new TypeError("Learning projection outboxSequence must be a positive safe integer");
    }
    return {
      legacy: legacyRecord(this.db, outboxSequence),
      integration: integrationRecord(this.db, outboxSequence),
    };
  }

  completeShadowClaim(input: CompleteShadowLearningProjectionInput): LearningProjectionCheckpoint | null {
    assertMutationTransaction(this.db);
    const { fence } = input.claim;
    if (fence.consumer !== LEARNING_SHADOW_CONSUMER
      || fence.leaseSource !== "shadow"
      || fence.authorityGeneration !== 0
      || fence.authorityToken !== null
      || input.result.outboxSequence !== fence.outboxSequence
      || input.result.sourceEventId !== fence.sourceEventId
      || input.claim.integration.outboxSequence !== fence.outboxSequence
      || input.claim.integration.sourceEventId !== fence.sourceEventId) {
      return null;
    }
    const current = this.db.prepare(`SELECT 1 FROM integration_consumer_delivery delivery
      JOIN integration_outbox outbox ON outbox.outbox_sequence=delivery.outbox_sequence
      WHERE delivery.outbox_sequence=? AND delivery.consumer=? AND delivery.status='leased'
        AND delivery.lease_generation=? AND delivery.lease_owner=? AND delivery.lease_token=?
        AND delivery.lease_source=? AND delivery.authority_generation=?
        AND delivery.authority_token IS ? AND delivery.lease_until>?
        AND outbox.source_event_id=?`).get(
      fence.outboxSequence,
      fence.consumer,
      fence.leaseGeneration,
      fence.leaseOwner,
      fence.leaseToken,
      fence.leaseSource,
      fence.authorityGeneration,
      fence.authorityToken,
      input.timestamp,
      fence.sourceEventId,
    );
    if (!current) return null;

    const currentPair = {
      legacy: legacyRecord(this.db, fence.outboxSequence),
      integration: integrationRecord(this.db, fence.outboxSequence),
    };
    const canonicalResult = reconcileLearningProjectionPair(currentPair.legacy, currentPair.integration);
    if (!sameReconciliation(input.result, canonicalResult)) return null;

    this.db.prepare(`INSERT INTO integration_reconciliation
      (source_event_id,outbox_sequence,legacy_hash,integration_hash,legacy_snapshot_hash,
       integration_snapshot_hash,legacy_digest,integration_digest,status,checked_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(source_event_id) DO UPDATE SET
        outbox_sequence=excluded.outbox_sequence,legacy_hash=excluded.legacy_hash,
        integration_hash=excluded.integration_hash,legacy_snapshot_hash=excluded.legacy_snapshot_hash,
        integration_snapshot_hash=excluded.integration_snapshot_hash,legacy_digest=excluded.legacy_digest,
        integration_digest=excluded.integration_digest,status=excluded.status,checked_at=excluded.checked_at`)
      .run(
        canonicalResult.sourceEventId,
        canonicalResult.outboxSequence,
        canonicalResult.legacyHash,
        canonicalResult.integrationHash,
        canonicalResult.legacySnapshotHash,
        canonicalResult.integrationSnapshotHash,
        canonicalResult.legacyDigest,
        canonicalResult.integrationDigest,
        canonicalResult.status,
        input.timestamp,
      );

    const deliveryStatus = canonicalResult.status === "match" ? "acked" : "failed";
    const changed = this.db.prepare(`UPDATE integration_consumer_delivery SET
      status=?,acked_at=?,lease_until=NULL
      WHERE outbox_sequence=? AND consumer=? AND status='leased'
        AND lease_generation=? AND lease_owner=? AND lease_token=? AND lease_source=?
        AND authority_generation=? AND authority_token IS ?
        AND EXISTS (SELECT 1 FROM integration_outbox outbox
          WHERE outbox.outbox_sequence=integration_consumer_delivery.outbox_sequence
            AND outbox.source_event_id=?)`).run(
      deliveryStatus,
      canonicalResult.status === "match" ? input.timestamp : null,
      fence.outboxSequence,
      fence.consumer,
      fence.leaseGeneration,
      fence.leaseOwner,
      fence.leaseToken,
      fence.leaseSource,
      fence.authorityGeneration,
      fence.authorityToken,
      fence.sourceEventId,
    );
    if (changed.changes !== 1) throw new Error("Shadow Learning projection claim changed during settlement");

    if (canonicalResult.status === "match") {
      const advanced = this.db.prepare(`UPDATE learning_projection_checkpoint SET
        watermark=?,generation=MAX(generation,?),updated_at=?
        WHERE consumer=? AND delivery_role='shadow' AND watermark=?`).run(
        fence.outboxSequence,
        fence.leaseGeneration,
        input.timestamp,
        fence.consumer,
        fence.outboxSequence - 1,
      );
      if (advanced.changes !== 1) {
        throw new Error(`Shadow Learning projection checkpoint rejected sequence ${fence.outboxSequence}`);
      }
    }
    return checkpoint(this.db, fence.consumer);
  }

  getContiguousWatermark(): number {
    const rows = this.db.prepare(`SELECT outbox.outbox_sequence as outboxSequence,
      reconciliation.status FROM integration_outbox outbox
      LEFT JOIN integration_reconciliation reconciliation
        ON reconciliation.source_event_id=outbox.source_event_id
      ORDER BY outbox.outbox_sequence`).all() as Array<{
        outboxSequence: number;
        status: string | null;
      }>;
    let watermark = 0;
    for (const row of rows) {
      if (row.outboxSequence !== watermark + 1 || row.status !== "match") break;
      watermark = row.outboxSequence;
    }
    return watermark;
  }
}
