import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  LEARNING_PROJECTION_CONSUMER,
  type IntegrationLearningProjectionRecord,
  type LearningProjectionCheckpoint,
  type LearningProjectionDeliveryClaim,
  type LearningProjectionDeliveryFence,
} from "@tagent/learning/domain";
import type {
  AcknowledgeLearningProjectionInput,
  ClaimLearningProjectionInput,
  FailLearningProjectionInput,
  LearningProjectionDeliveryRepository,
} from "@tagent/learning/ports";

interface DeliveryRow {
  leaseGeneration: number;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseUntil: number | null;
  status: "pending" | "leased" | "acked" | "failed";
}

function assertMutationTransaction(db: Database.Database): void {
  if (!db.inTransaction) {
    throw new Error("Learning projection delivery mutation requires a writer-fenced transaction");
  }
}

function assertTimestamp(timestamp: number): void {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError("Learning projection delivery timestamp is invalid");
  }
}

function checkpointRow(
  db: Database.Database,
  consumer: string,
): LearningProjectionCheckpoint | null {
  return db.prepare(`SELECT consumer,watermark,generation,updated_at as updatedAt
    FROM learning_projection_checkpoint
    WHERE consumer=?`).get(consumer) as
    LearningProjectionCheckpoint | undefined ?? null;
}

function integrationRecord(
  db: Database.Database,
  sequence: number,
): IntegrationLearningProjectionRecord | null {
  return db.prepare(`SELECT outbox_sequence as outboxSequence,source_event_id as sourceEventId,
    payload_hash as payloadHash,aggregate_id as aggregateId,aggregate_version as aggregateVersion,
    run_event_ref as runEventRef,attempt_id as attemptId,attempt_ordinal as attemptOrdinal,
    payload_json as payloadJson,evidence_snapshot_json as evidenceSnapshotJson
    FROM integration_outbox WHERE outbox_sequence=?`).get(sequence) as
    IntegrationLearningProjectionRecord | undefined ?? null;
}

function deliveryRow(
  db: Database.Database,
  sequence: number,
  consumer: string,
): DeliveryRow | null {
  return db.prepare(`SELECT lease_generation as leaseGeneration,lease_owner as leaseOwner,
    lease_token as leaseToken,lease_until as leaseUntil,status
    FROM integration_consumer_delivery WHERE outbox_sequence=? AND consumer=?`)
    .get(sequence, consumer) as DeliveryRow | undefined ?? null;
}

function claimFrom(
  integration: IntegrationLearningProjectionRecord,
  row: DeliveryRow,
): LearningProjectionDeliveryClaim {
  if (!row.leaseOwner || !row.leaseToken) {
    throw new Error(`Invalid Learning delivery fence at sequence ${integration.outboxSequence}`);
  }
  const fence: LearningProjectionDeliveryFence = {
    outboxSequence: integration.outboxSequence,
    consumer: LEARNING_PROJECTION_CONSUMER,
    leaseGeneration: row.leaseGeneration,
    leaseOwner: row.leaseOwner,
    leaseToken: row.leaseToken,
    sourceEventId: integration.sourceEventId,
  };
  return { fence, integration };
}

function sameFence(
  db: Database.Database,
  claim: LearningProjectionDeliveryClaim,
  timestamp: number,
): boolean {
  const { fence, integration } = claim;
  if (fence.consumer !== LEARNING_PROJECTION_CONSUMER
    || integration.outboxSequence !== fence.outboxSequence
    || integration.sourceEventId !== fence.sourceEventId
    || integrationRecord(db, fence.outboxSequence)?.sourceEventId !== fence.sourceEventId) {
    return false;
  }
  const row = deliveryRow(db, fence.outboxSequence, fence.consumer);
  return row?.status === "leased"
    && row.leaseGeneration === fence.leaseGeneration
    && row.leaseOwner === fence.leaseOwner
    && row.leaseToken === fence.leaseToken
    && row.leaseUntil !== null
    && row.leaseUntil > timestamp;
}

export class SqliteLearningProjectionDeliveryRepository
implements LearningProjectionDeliveryRepository {
  constructor(private readonly db: Database.Database) {}

  getCheckpoint(
    consumer: Parameters<LearningProjectionDeliveryRepository["getCheckpoint"]>[0],
  ): LearningProjectionCheckpoint | null {
    return checkpointRow(this.db, consumer);
  }

  claimNext(input: ClaimLearningProjectionInput): LearningProjectionDeliveryClaim | null {
    assertMutationTransaction(this.db);
    assertTimestamp(input.timestamp);
    if (input.consumer !== LEARNING_PROJECTION_CONSUMER) {
      throw new TypeError("Unsupported Learning projection consumer");
    }
    if (!input.owner.trim()) throw new TypeError("Learning projection delivery owner is required");
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs <= 0
      || !Number.isSafeInteger(input.timestamp + input.leaseMs)) {
      throw new TypeError("Learning projection delivery leaseMs is invalid");
    }
    this.db.prepare(`INSERT INTO learning_projection_checkpoint
      (consumer,watermark,generation,updated_at)
      VALUES (?,0,0,?) ON CONFLICT(consumer) DO NOTHING`)
      .run(input.consumer, input.timestamp);
    const checkpoint = checkpointRow(this.db, input.consumer)!;
    const sequence = checkpoint.watermark + 1;
    const integration = integrationRecord(this.db, sequence);
    if (!integration) return null;

    const existing = deliveryRow(this.db, sequence, input.consumer);
    if (existing?.status === "acked") {
      throw new Error(`Learning projection checkpoint is behind ACKed sequence ${sequence}`);
    }
    if (existing?.status === "leased" && existing.leaseUntil !== null
      && existing.leaseUntil > input.timestamp) {
      return existing.leaseOwner === input.owner ? claimFrom(integration, existing) : null;
    }

    const generation = (existing?.leaseGeneration ?? 0) + 1;
    const token = randomUUID();
    const leaseUntil = input.timestamp + input.leaseMs;
    const changes = existing
      ? this.db.prepare(`UPDATE integration_consumer_delivery SET
          lease_generation=?,lease_owner=?,lease_token=?,lease_until=?,
          attempts=attempts+1,acked_at=NULL,status='leased'
        WHERE outbox_sequence=? AND consumer=? AND (
          status IN ('pending','failed') OR (status='leased' AND lease_until<=?)
        )`).run(
          generation,
          input.owner,
          token,
          leaseUntil,
          sequence,
          input.consumer,
          input.timestamp,
        ).changes
      : this.db.prepare(`INSERT INTO integration_consumer_delivery
          (outbox_sequence,consumer,lease_generation,lease_owner,lease_token,
           lease_until,attempts,acked_at,status)
        VALUES (?,?,1,?,?,?,1,NULL,'leased')`).run(
          sequence,
          input.consumer,
          input.owner,
          token,
          leaseUntil,
        ).changes;
    if (changes !== 1) return null;
    return claimFrom(integration, {
      leaseGeneration: generation,
      leaseOwner: input.owner,
      leaseToken: token,
      leaseUntil,
      status: "leased",
    });
  }

  acknowledge(input: AcknowledgeLearningProjectionInput): LearningProjectionCheckpoint | null {
    assertMutationTransaction(this.db);
    assertTimestamp(input.timestamp);
    if (!input.effectHash) throw new TypeError("Learning projection effectHash is required");
    if (!sameFence(this.db, input.claim, input.timestamp)) return null;
    const { fence } = input.claim;
    const checkpoint = checkpointRow(this.db, fence.consumer);
    if (!checkpoint || checkpoint.watermark !== fence.outboxSequence - 1) return null;
    const receipt = this.db.prepare(`SELECT effect_hash as effectHash FROM effect_receipts
      WHERE logical_consumer=? AND source_event_id=?`).get(
      fence.consumer,
      fence.sourceEventId,
    ) as { effectHash: string } | undefined;
    if (!receipt || receipt.effectHash !== input.effectHash) return null;

    const acked = this.db.prepare(`UPDATE integration_consumer_delivery SET
      status='acked',acked_at=?,lease_until=NULL
      WHERE outbox_sequence=? AND consumer=? AND status='leased'
        AND lease_generation=? AND lease_owner=? AND lease_token=? AND lease_until>?`).run(
      input.timestamp,
      fence.outboxSequence,
      fence.consumer,
      fence.leaseGeneration,
      fence.leaseOwner,
      fence.leaseToken,
      input.timestamp,
    );
    if (acked.changes !== 1) return null;
    const advanced = this.db.prepare(`UPDATE learning_projection_checkpoint SET
      watermark=?,generation=MAX(generation,?),updated_at=?
      WHERE consumer=? AND watermark=?`).run(
      fence.outboxSequence,
      fence.leaseGeneration,
      input.timestamp,
      fence.consumer,
      fence.outboxSequence - 1,
    );
    if (advanced.changes !== 1) {
      throw new Error(`Learning projection checkpoint rejected sequence ${fence.outboxSequence}`);
    }
    return checkpointRow(this.db, fence.consumer);
  }

  fail(input: FailLearningProjectionInput): boolean {
    assertMutationTransaction(this.db);
    assertTimestamp(input.timestamp);
    if (!sameFence(this.db, input.claim, input.timestamp)) return false;
    const { fence } = input.claim;
    return this.db.prepare(`UPDATE integration_consumer_delivery SET
      status='failed',lease_until=NULL
      WHERE outbox_sequence=? AND consumer=? AND status='leased'
        AND lease_generation=? AND lease_owner=? AND lease_token=? AND lease_until>?`).run(
      fence.outboxSequence,
      fence.consumer,
      fence.leaseGeneration,
      fence.leaseOwner,
      fence.leaseToken,
      input.timestamp,
    ).changes === 1;
  }
}
