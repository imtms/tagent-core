import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  LEARNING_ACTIVE_CONSUMER,
  LEARNING_SHADOW_CONSUMER,
  type IntegrationLearningProjectionRecord,
  type LearningProjectionAuthoritySource,
  type LearningProjectionAuthorityState,
  type LearningProjectionCheckpoint,
  type LearningProjectionDeliveryClaim,
  type LearningProjectionDeliveryFence,
  type LegacyLearningProjectionRecord,
} from "@tagent/learning/domain";
import type {
  AcknowledgeActiveLearningProjectionInput,
  ClaimActiveLearningProjectionInput,
  ClaimShadowLearningProjectionInput,
  FailActiveLearningProjectionInput,
  LearningProjectionDeliveryRepository,
} from "@tagent/learning/ports";

interface DeliveryRow {
  leaseGeneration: number;
  leaseOwner: string | null;
  leaseToken: string | null;
  leaseSource: "legacy" | "integration" | "shadow";
  authorityGeneration: number;
  authorityToken: string | null;
  leaseUntil: number | null;
  status: "pending" | "leased" | "acked" | "failed";
}

interface LegacyRecordWithStatus {
  record: LegacyLearningProjectionRecord;
  status: "pending" | "processing" | "completed" | "failed";
}

function assertMutationTransaction(db: Database.Database): void {
  if (!db.inTransaction) {
    throw new Error("Learning projection delivery mutation requires a writer-fenced transaction");
  }
}

function assertLeaseInput(owner: string, leaseMs: number, timestamp: number): void {
  if (!owner) throw new TypeError("Learning projection delivery owner is required");
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new TypeError("Learning projection delivery leaseMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(timestamp) || timestamp < 0
    || !Number.isSafeInteger(timestamp + leaseMs)) {
    throw new TypeError("Learning projection delivery timestamp is invalid");
  }
}

function assertTimestamp(timestamp: number): void {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError("Learning projection delivery timestamp is invalid");
  }
}

function integrationRecord(db: Database.Database, sequence: number): IntegrationLearningProjectionRecord | null {
  return db.prepare(`SELECT outbox_sequence as outboxSequence,source_event_id as sourceEventId,
    payload_hash as payloadHash,aggregate_id as aggregateId,aggregate_version as aggregateVersion,
    run_event_ref as runEventRef,attempt_id as attemptId,attempt_ordinal as attemptOrdinal,
    payload_json as payloadJson,evidence_snapshot_json as evidenceSnapshotJson
    FROM integration_outbox WHERE outbox_sequence=?`).get(sequence) as IntegrationLearningProjectionRecord | undefined ?? null;
}

function legacyRecord(db: Database.Database, sequence: number): LegacyRecordWithStatus | null {
  const row = db.prepare(`SELECT outbox_sequence as outboxSequence,source_event_id as sourceEventId,
    payload_hash as payloadHash,run_id as runId,attempt as attemptOrdinal,attempt_id as attemptId,
    lifecycle,outcome,event_seq as eventSeq,payload_json as payloadJson,snapshot_json as snapshotJson,status
    FROM learning_projection_outbox WHERE outbox_sequence=?`).get(sequence) as (
      LegacyLearningProjectionRecord & { status: LegacyRecordWithStatus["status"] }
    ) | undefined;
  if (!row) return null;
  const { status, ...record } = row;
  return { record, status };
}

function checkpointRow(
  db: Database.Database,
  consumer: string,
  deliveryRole: string,
): LearningProjectionCheckpoint | null {
  return db.prepare(`SELECT consumer,delivery_role as deliveryRole,watermark,generation,
    updated_at as updatedAt FROM learning_projection_checkpoint
    WHERE consumer=? AND delivery_role=?`).get(consumer, deliveryRole) as LearningProjectionCheckpoint | undefined ?? null;
}

function authorityState(db: Database.Database): LearningProjectionAuthorityState {
  const row = db.prepare(`SELECT active_source as activeSource,generation,owner,token,
    lease_until as leaseUntil,switch_watermark as switchWatermark,
    legacy_last_acked as legacyLastAcked,legacy_resume_position as legacyResumePosition,
    integration_checkpoint as integrationCheckpoint,rollback_checkpoint as rollbackCheckpoint,status
    FROM learning_projection_authority_state WHERE id=1`).get() as LearningProjectionAuthorityState | undefined;
  if (!row) throw new Error("Learning projection authority singleton is missing");
  return row;
}

function activeAuthority(
  db: Database.Database,
  input: ClaimActiveLearningProjectionInput,
): LearningProjectionAuthorityState | null {
  const current = authorityState(db);
  const expectedStatus = input.source === "legacy" ? "legacy_active" : "integration_active";
  return input.consumer === LEARNING_ACTIVE_CONSUMER
    && input.authority.activeSource === input.source
    && current.activeSource === input.source
    && current.status === expectedStatus
    && current.generation === input.authority.generation
    && current.owner === input.authority.owner
    && current.token === input.authority.token
    && current.leaseUntil !== null
    && current.leaseUntil > input.timestamp
    ? current
    : null;
}

function deliveryRow(db: Database.Database, sequence: number, consumer: string): DeliveryRow | null {
  return db.prepare(`SELECT lease_generation as leaseGeneration,lease_owner as leaseOwner,
    lease_token as leaseToken,lease_source as leaseSource,authority_generation as authorityGeneration,
    authority_token as authorityToken,lease_until as leaseUntil,status
    FROM integration_consumer_delivery WHERE outbox_sequence=? AND consumer=?`)
    .get(sequence, consumer) as DeliveryRow | undefined ?? null;
}

function claim(
  db: Database.Database,
  integration: IntegrationLearningProjectionRecord,
  fence: LearningProjectionDeliveryFence,
): LearningProjectionDeliveryClaim {
  const legacy = legacyRecord(db, integration.outboxSequence);
  return {
    fence,
    integration,
    legacy: legacy?.record ?? null,
    effectDisposition: fence.leaseSource === "legacy" && legacy?.status === "completed"
      ? "adopt_legacy_completed"
      : "apply",
  };
}

function claimedShadow(
  db: Database.Database,
  integration: IntegrationLearningProjectionRecord,
  row: DeliveryRow,
): LearningProjectionDeliveryClaim {
  if (!row.leaseOwner || !row.leaseToken || row.leaseSource !== "shadow"
    || row.authorityGeneration !== 0 || row.authorityToken !== null) {
    throw new Error(`Invalid shadow delivery fence at sequence ${integration.outboxSequence}`);
  }
  return claim(db, integration, {
    outboxSequence: integration.outboxSequence,
    consumer: LEARNING_SHADOW_CONSUMER,
    leaseGeneration: row.leaseGeneration,
    leaseOwner: row.leaseOwner,
    leaseToken: row.leaseToken,
    leaseSource: row.leaseSource,
    authorityGeneration: row.authorityGeneration,
    authorityToken: row.authorityToken,
    sourceEventId: integration.sourceEventId,
  });
}

function claimedActive(
  db: Database.Database,
  integration: IntegrationLearningProjectionRecord,
  source: LearningProjectionAuthoritySource,
  row: DeliveryRow,
): LearningProjectionDeliveryClaim {
  if (!row.leaseOwner || !row.leaseToken || row.leaseSource !== source || !row.authorityToken) {
    throw new Error(`Invalid active delivery fence at sequence ${integration.outboxSequence}`);
  }
  return claim(db, integration, {
    outboxSequence: integration.outboxSequence,
    consumer: LEARNING_ACTIVE_CONSUMER,
    leaseGeneration: row.leaseGeneration,
    leaseOwner: row.leaseOwner,
    leaseToken: row.leaseToken,
    leaseSource: source,
    authorityGeneration: row.authorityGeneration,
    authorityToken: row.authorityToken,
    sourceEventId: integration.sourceEventId,
  });
}

function sameActiveFence(
  current: LearningProjectionAuthorityState,
  fence: LearningProjectionDeliveryFence,
  timestamp: number,
): boolean {
  const expectedStatus = fence.leaseSource === "legacy" ? "legacy_active" : "integration_active";
  return fence.consumer === LEARNING_ACTIVE_CONSUMER
    && (fence.leaseSource === "legacy" || fence.leaseSource === "integration")
    && current.activeSource === fence.leaseSource
    && current.status === expectedStatus
    && current.generation === fence.authorityGeneration
    && current.token === fence.authorityToken
    && current.leaseUntil !== null
    && current.leaseUntil > timestamp;
}

export class SqliteLearningProjectionDeliveryRepository
implements LearningProjectionDeliveryRepository {
  constructor(private readonly db: Database.Database) {}

  getCheckpoint(
    consumer: Parameters<LearningProjectionDeliveryRepository["getCheckpoint"]>[0],
    deliveryRole: Parameters<LearningProjectionDeliveryRepository["getCheckpoint"]>[1],
  ): LearningProjectionCheckpoint | null {
    return checkpointRow(this.db, consumer, deliveryRole);
  }

  claimNextShadow(input: ClaimShadowLearningProjectionInput): LearningProjectionDeliveryClaim | null {
    assertMutationTransaction(this.db);
    assertLeaseInput(input.owner, input.leaseMs, input.timestamp);
    if (input.consumer !== LEARNING_SHADOW_CONSUMER) {
      throw new TypeError("Shadow delivery requires the learning-shadow-v1 consumer");
    }
    this.db.prepare(`INSERT INTO learning_projection_checkpoint
      (consumer,delivery_role,watermark,generation,updated_at)
      VALUES (?,'shadow',0,0,?) ON CONFLICT(consumer,delivery_role) DO NOTHING`)
      .run(input.consumer, input.timestamp);
    const checkpoint = checkpointRow(this.db, input.consumer, "shadow")!;
    const sequence = checkpoint.watermark + 1;
    const integration = integrationRecord(this.db, sequence);
    if (!integration) return null;

    const existing = deliveryRow(this.db, sequence, input.consumer);
    if (existing?.status === "acked") {
      throw new Error(`Shadow delivery checkpoint is behind ACKed sequence ${sequence}`);
    }
    if (existing?.status === "leased" && existing.leaseUntil !== null
      && existing.leaseUntil > input.timestamp) {
      return existing.leaseOwner === input.owner
        ? claimedShadow(this.db, integration, existing)
        : null;
    }

    const generation = (existing?.leaseGeneration ?? 0) + 1;
    const token = randomUUID();
    const leaseUntil = input.timestamp + input.leaseMs;
    const changes = existing
      ? this.db.prepare(`UPDATE integration_consumer_delivery SET
          lease_generation=?,lease_owner=?,lease_token=?,lease_source='shadow',
          authority_generation=0,authority_token=NULL,lease_until=?,attempts=attempts+1,
          acked_at=NULL,status='leased'
        WHERE outbox_sequence=? AND consumer=? AND (
          status IN ('pending','failed') OR (status='leased' AND lease_until<=?)
        )`).run(generation, input.owner, token, leaseUntil, sequence, input.consumer, input.timestamp).changes
      : this.db.prepare(`INSERT INTO integration_consumer_delivery
          (outbox_sequence,consumer,lease_generation,lease_owner,lease_token,lease_source,
           authority_generation,authority_token,lease_until,attempts,acked_at,status)
        VALUES (?,?,1,?,?,'shadow',0,NULL,?,1,NULL,'leased')`)
        .run(sequence, input.consumer, input.owner, token, leaseUntil).changes;
    if (changes !== 1) return null;
    return claimedShadow(this.db, integration, {
      leaseGeneration: generation,
      leaseOwner: input.owner,
      leaseToken: token,
      leaseSource: "shadow",
      authorityGeneration: 0,
      authorityToken: null,
      leaseUntil,
      status: "leased",
    });
  }

  claimNextActive(input: ClaimActiveLearningProjectionInput): LearningProjectionDeliveryClaim | null {
    assertMutationTransaction(this.db);
    assertLeaseInput(input.owner, input.leaseMs, input.timestamp);
    const authority = activeAuthority(this.db, input);
    if (!authority) return null;
    const initialWatermark = input.source === "legacy"
      ? authority.legacyLastAcked
      : authority.integrationCheckpoint;
    this.db.prepare(`INSERT INTO learning_projection_checkpoint
      (consumer,delivery_role,watermark,generation,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(consumer,delivery_role) DO NOTHING`).run(
      LEARNING_ACTIVE_CONSUMER,
      input.source,
      initialWatermark,
      authority.generation,
      input.timestamp,
    );

    let checkpoint = checkpointRow(this.db, LEARNING_ACTIVE_CONSUMER, input.source)!;
    if (checkpoint.watermark !== initialWatermark) return null;
    let sequence = checkpoint.watermark + 1;
    let integration = integrationRecord(this.db, sequence);
    while (integration) {
      const existing = deliveryRow(this.db, sequence, LEARNING_ACTIVE_CONSUMER);
      if (existing?.status !== "acked") break;
      const receipt = this.db.prepare(`SELECT 1 FROM effect_receipts
        WHERE logical_consumer=? AND source_event_id=?`).get(
        LEARNING_ACTIVE_CONSUMER,
        integration.sourceEventId,
      );
      if (!receipt) throw new Error(`ACKed Learning projection ${sequence} has no effect receipt`);
      if (input.source === "legacy") {
        const legacyCompleted = this.db.prepare(`UPDATE learning_projection_outbox SET
          status='completed',error='',updated_at=?
          WHERE outbox_sequence=? AND source_event_id=?`).run(
          input.timestamp,
          sequence,
          integration.sourceEventId,
        );
        if (legacyCompleted.changes !== 1) {
          throw new Error(`Legacy Learning projection cannot adopt ACK ${sequence}`);
        }
      }
      const advanced = this.db.prepare(`UPDATE learning_projection_checkpoint SET
        watermark=?,generation=MAX(generation,?),updated_at=?
        WHERE consumer=? AND delivery_role=? AND watermark=?`).run(
        sequence,
        authority.generation,
        input.timestamp,
        LEARNING_ACTIVE_CONSUMER,
        input.source,
        sequence - 1,
      );
      if (advanced.changes !== 1) throw new Error(`Learning projection checkpoint cannot adopt ACK ${sequence}`);
      const field = input.source === "legacy" ? "legacy_last_acked" : "integration_checkpoint";
      const authorityAdvanced = this.db.prepare(`UPDATE learning_projection_authority_state SET ${field}=?
        WHERE id=1 AND active_source=? AND generation=? AND token=? AND ${field}=?`).run(
        sequence,
        input.source,
        authority.generation,
        authority.token,
        sequence - 1,
      );
      if (authorityAdvanced.changes !== 1) {
        throw new Error(`Learning projection authority cannot adopt ACK ${sequence}`);
      }
      checkpoint = checkpointRow(this.db, LEARNING_ACTIVE_CONSUMER, input.source)!;
      sequence = checkpoint.watermark + 1;
      integration = integrationRecord(this.db, sequence);
    }
    if (!integration) return null;
    if (input.source === "legacy" && !legacyRecord(this.db, sequence)) {
      throw new Error(`Legacy Learning projection is missing at sequence ${sequence}`);
    }

    const existing = deliveryRow(this.db, sequence, LEARNING_ACTIVE_CONSUMER);
    if (existing?.status === "leased" && existing.leaseUntil !== null
      && existing.leaseUntil > input.timestamp) {
      return existing.leaseOwner === input.owner
        && existing.leaseSource === input.source
        && existing.authorityGeneration === authority.generation
        && existing.authorityToken === authority.token
        ? claimedActive(this.db, integration, input.source, existing)
        : null;
    }
    const generation = (existing?.leaseGeneration ?? 0) + 1;
    const token = randomUUID();
    const leaseUntil = input.timestamp + input.leaseMs;
    const changes = existing
      ? this.db.prepare(`UPDATE integration_consumer_delivery SET
          lease_generation=?,lease_owner=?,lease_token=?,lease_source=?,authority_generation=?,
          authority_token=?,lease_until=?,attempts=attempts+1,acked_at=NULL,status='leased'
        WHERE outbox_sequence=? AND consumer=? AND (
          status IN ('pending','failed') OR (status='leased' AND lease_until<=?)
        )`).run(
          generation,
          input.owner,
          token,
          input.source,
          authority.generation,
          authority.token,
          leaseUntil,
          sequence,
          LEARNING_ACTIVE_CONSUMER,
          input.timestamp,
        ).changes
      : this.db.prepare(`INSERT INTO integration_consumer_delivery
          (outbox_sequence,consumer,lease_generation,lease_owner,lease_token,lease_source,
           authority_generation,authority_token,lease_until,attempts,acked_at,status)
        VALUES (?,?,?,?,?,?,?,?,?,1,NULL,'leased')`).run(
          sequence,
          LEARNING_ACTIVE_CONSUMER,
          1,
          input.owner,
          token,
          input.source,
          authority.generation,
          authority.token,
          leaseUntil,
        ).changes;
    if (changes !== 1) return null;
    if (input.source === "legacy") {
      const processing = this.db.prepare(`UPDATE learning_projection_outbox SET
        status='processing',error='',updated_at=?
        WHERE outbox_sequence=? AND source_event_id=? AND status IN ('pending','failed')`).run(
        input.timestamp,
        sequence,
        integration.sourceEventId,
      );
      const status = legacyRecord(this.db, sequence)?.status;
      if (processing.changes !== 1 && status !== "completed" && status !== "processing") {
        throw new Error(`Legacy Learning projection cannot enter processing at sequence ${sequence}`);
      }
    }
    return claimedActive(this.db, integration, input.source, {
      leaseGeneration: generation,
      leaseOwner: input.owner,
      leaseToken: token,
      leaseSource: input.source,
      authorityGeneration: authority.generation,
      authorityToken: authority.token,
      leaseUntil,
      status: "leased",
    });
  }

  acknowledgeActive(input: AcknowledgeActiveLearningProjectionInput): LearningProjectionCheckpoint | null {
    assertMutationTransaction(this.db);
    assertTimestamp(input.timestamp);
    if (!input.effectHash) throw new TypeError("Learning projection effectHash is required");
    const { fence } = input.claim;
    const authority = authorityState(this.db);
    const currentIntegration = integrationRecord(this.db, fence.outboxSequence);
    if (!sameActiveFence(authority, fence, input.timestamp)
      || currentIntegration?.sourceEventId !== fence.sourceEventId
      || input.claim.integration.outboxSequence !== fence.outboxSequence
      || input.claim.integration.sourceEventId !== fence.sourceEventId) return null;
    const checkpoint = checkpointRow(this.db, LEARNING_ACTIVE_CONSUMER, fence.leaseSource);
    if (!checkpoint || checkpoint.watermark !== fence.outboxSequence - 1) return null;
    const delivery = deliveryRow(this.db, fence.outboxSequence, fence.consumer);
    if (!delivery
      || delivery.status !== "leased"
      || delivery.leaseGeneration !== fence.leaseGeneration
      || delivery.leaseOwner !== fence.leaseOwner
      || delivery.leaseToken !== fence.leaseToken
      || delivery.leaseSource !== fence.leaseSource
      || delivery.authorityGeneration !== fence.authorityGeneration
      || delivery.authorityToken !== fence.authorityToken
      || delivery.leaseUntil === null
      || delivery.leaseUntil <= input.timestamp) return null;
    const receipt = this.db.prepare(`SELECT effect_hash as effectHash FROM effect_receipts
      WHERE logical_consumer=? AND source_event_id=?`).get(
      LEARNING_ACTIVE_CONSUMER,
      fence.sourceEventId,
    ) as { effectHash: string } | undefined;
    if (!receipt || receipt.effectHash !== input.effectHash) return null;

    const acked = this.db.prepare(`UPDATE integration_consumer_delivery SET
      status='acked',acked_at=?,lease_until=NULL
      WHERE outbox_sequence=? AND consumer=? AND status='leased'
        AND lease_generation=? AND lease_owner=? AND lease_token=? AND lease_source=?
        AND authority_generation=? AND authority_token=? AND lease_until>?`).run(
      input.timestamp,
      fence.outboxSequence,
      fence.consumer,
      fence.leaseGeneration,
      fence.leaseOwner,
      fence.leaseToken,
      fence.leaseSource,
      fence.authorityGeneration,
      fence.authorityToken,
      input.timestamp,
    );
    if (acked.changes !== 1) return null;
    if (fence.leaseSource === "legacy") {
      const legacyCompleted = this.db.prepare(`UPDATE learning_projection_outbox SET
        status='completed',error='',updated_at=?
        WHERE outbox_sequence=? AND source_event_id=?`).run(
        input.timestamp,
        fence.outboxSequence,
        fence.sourceEventId,
      );
      if (legacyCompleted.changes !== 1) {
        throw new Error(`Legacy Learning projection ACK lost sequence ${fence.outboxSequence}`);
      }
    }
    const advanced = this.db.prepare(`UPDATE learning_projection_checkpoint SET
      watermark=?,generation=MAX(generation,?),updated_at=?
      WHERE consumer=? AND delivery_role=? AND watermark=?`).run(
      fence.outboxSequence,
      fence.leaseGeneration,
      input.timestamp,
      fence.consumer,
      fence.leaseSource,
      fence.outboxSequence - 1,
    );
    if (advanced.changes !== 1) {
      throw new Error(`Learning projection checkpoint rejected sequence ${fence.outboxSequence}`);
    }
    const field = fence.leaseSource === "legacy" ? "legacy_last_acked" : "integration_checkpoint";
    const authorityAdvanced = this.db.prepare(`UPDATE learning_projection_authority_state SET ${field}=?
      WHERE id=1 AND active_source=? AND generation=? AND token=? AND ${field}=?`).run(
      fence.outboxSequence,
      fence.leaseSource,
      fence.authorityGeneration,
      fence.authorityToken,
      fence.outboxSequence - 1,
    );
    if (authorityAdvanced.changes !== 1) {
      throw new Error(`Learning projection authority rejected sequence ${fence.outboxSequence}`);
    }
    return checkpointRow(this.db, fence.consumer, fence.leaseSource);
  }

  failActive(input: FailActiveLearningProjectionInput): boolean {
    assertMutationTransaction(this.db);
    assertTimestamp(input.timestamp);
    const { fence } = input.claim;
    const authority = authorityState(this.db);
    const currentIntegration = integrationRecord(this.db, fence.outboxSequence);
    if (!sameActiveFence(authority, fence, input.timestamp)
      || currentIntegration?.sourceEventId !== fence.sourceEventId
      || input.claim.integration.outboxSequence !== fence.outboxSequence
      || input.claim.integration.sourceEventId !== fence.sourceEventId) return false;
    const failed = this.db.prepare(`UPDATE integration_consumer_delivery SET status='failed',lease_until=NULL
      WHERE outbox_sequence=? AND consumer=? AND status='leased'
        AND lease_generation=? AND lease_owner=? AND lease_token=? AND lease_source=?
        AND authority_generation=? AND authority_token=? AND lease_until>?`).run(
      fence.outboxSequence,
      fence.consumer,
      fence.leaseGeneration,
      fence.leaseOwner,
      fence.leaseToken,
      fence.leaseSource,
      fence.authorityGeneration,
      fence.authorityToken,
      input.timestamp,
    ).changes;
    if (failed !== 1) return false;
    if (fence.leaseSource === "legacy") {
      const legacyFailed = this.db.prepare(`UPDATE learning_projection_outbox SET
        status='failed',error='active Learning projection delivery failed',updated_at=?
        WHERE outbox_sequence=? AND source_event_id=?`).run(
        input.timestamp,
        fence.outboxSequence,
        fence.sourceEventId,
      );
      if (legacyFailed.changes !== 1) {
        throw new Error(`Legacy Learning projection failure lost sequence ${fence.outboxSequence}`);
      }
    }
    return true;
  }
}
