import { createHash } from "node:crypto";
import { stableJson } from "@tagent/governance";

export const LEARNING_ACTIVE_CONSUMER = "learning-active-v1" as const;
export const LEARNING_SHADOW_CONSUMER = "learning-shadow-v1" as const;

export type LearningProjectionConsumer =
  | typeof LEARNING_ACTIVE_CONSUMER
  | typeof LEARNING_SHADOW_CONSUMER;
export type LearningProjectionDeliveryRole = "legacy" | "integration" | "shadow";
export type LearningProjectionLeaseSource = LearningProjectionDeliveryRole;
export type LearningProjectionAuthoritySource = "legacy" | "integration";
export type LearningProjectionAuthorityStatus =
  | "legacy_active"
  | "switching"
  | "integration_active"
  | "rollback";
export type LearningProjectionReconciliationStatus =
  | "match"
  | "missing"
  | "hash_mismatch"
  | "snapshot_mismatch"
  | "digest_mismatch"
  | "blocker";

export interface LegacyLearningProjectionRecord {
  outboxSequence: number;
  sourceEventId: string;
  payloadHash: string;
  runId: string;
  attemptOrdinal: number;
  attemptId: string | null;
  lifecycle: string;
  outcome: string;
  eventSeq: number;
  payloadJson: string;
  snapshotJson: string;
}

export interface IntegrationLearningProjectionRecord {
  outboxSequence: number;
  sourceEventId: string;
  payloadHash: string;
  aggregateId: string;
  aggregateVersion: number;
  runEventRef: string | null;
  attemptId: string | null;
  attemptOrdinal: number;
  payloadJson: string;
  evidenceSnapshotJson: string;
}

export interface DecodedLearningProjection {
  runId: string;
  attemptOrdinal: number;
  eventSeq: number;
  lifecycle: string;
  outcome: string;
  payload: Record<string, unknown>;
  taskRunSnapshot: Record<string, unknown>;
}

export interface LearningProjectionDeliveryFence {
  outboxSequence: number;
  consumer: LearningProjectionConsumer;
  leaseGeneration: number;
  leaseOwner: string;
  leaseToken: string;
  leaseSource: LearningProjectionLeaseSource;
  authorityGeneration: number;
  authorityToken: string | null;
  sourceEventId: string;
}

export interface LearningProjectionDeliveryClaim {
  fence: LearningProjectionDeliveryFence;
  integration: IntegrationLearningProjectionRecord;
  legacy: LegacyLearningProjectionRecord | null;
  effectDisposition: "apply" | "adopt_legacy_completed";
}

export interface LearningProjectionCheckpoint {
  consumer: LearningProjectionConsumer;
  deliveryRole: LearningProjectionDeliveryRole;
  watermark: number;
  generation: number;
  updatedAt: number;
}

export interface LearningProjectionAuthorityState {
  activeSource: LearningProjectionAuthoritySource;
  generation: number;
  owner: string | null;
  token: string | null;
  leaseUntil: number | null;
  switchWatermark: number;
  legacyLastAcked: number;
  legacyResumePosition: number;
  integrationCheckpoint: number;
  rollbackCheckpoint: number;
  status: LearningProjectionAuthorityStatus;
}

export interface LearningProjectionAuthorityFence {
  activeSource: LearningProjectionAuthoritySource;
  generation: number;
  owner: string;
  token: string;
}

export interface LearningProjectionAuthorityLease {
  fence: LearningProjectionAuthorityFence;
  state: LearningProjectionAuthorityState & {
    owner: string;
    token: string;
    leaseUntil: number;
  };
}

export interface LearningEffectReceipt {
  logicalConsumer: LearningProjectionConsumer;
  sourceEventId: string;
  effectHash: string;
  committedAt: number;
}

export interface LearningProjectionReconciliation {
  sourceEventId: string;
  outboxSequence: number;
  legacyHash: string | null;
  integrationHash: string | null;
  legacySnapshotHash: string | null;
  integrationSnapshotHash: string | null;
  legacyDigest: string | null;
  integrationDigest: string | null;
  status: LearningProjectionReconciliationStatus;
  detail?: string;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value), "utf8").digest("hex");
}

function parseObject(value: string, field: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new TypeError(`${field} must be valid JSON`, { cause: error });
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new TypeError(`${field} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function canonicalLifecycle(lifecycle: string): string {
  return lifecycle === "run.waiting_for_input" ? "run.waiting_input" : lifecycle;
}

function syntheticLifecycle(record: IntegrationLearningProjectionRecord): string {
  const prefix = `run:${record.aggregateId}:synthetic:`;
  const suffix = `:${record.attemptId ?? ""}:${record.attemptOrdinal}:`;
  if (!record.sourceEventId.startsWith(prefix)) {
    throw new TypeError("synthetic Learning projection source identity is malformed");
  }
  const hashOffset = record.sourceEventId.length - 64;
  if (hashOffset <= prefix.length || record.sourceEventId[hashOffset - 1] !== ":") {
    throw new TypeError("synthetic Learning projection source hash is malformed");
  }
  const withoutHash = record.sourceEventId.slice(prefix.length, hashOffset - 1);
  if (!withoutHash.endsWith(suffix.slice(0, -1))) {
    throw new TypeError("synthetic Learning projection Attempt identity is malformed");
  }
  const lifecycle = withoutHash.slice(0, -suffix.length + 1);
  if (!lifecycle) throw new TypeError("synthetic Learning projection lifecycle is missing");
  return canonicalLifecycle(lifecycle);
}

export function decodeLegacyLearningProjection(
  record: LegacyLearningProjectionRecord,
): DecodedLearningProjection {
  return {
    runId: record.runId,
    attemptOrdinal: record.attemptOrdinal,
    eventSeq: record.eventSeq,
    lifecycle: canonicalLifecycle(record.lifecycle),
    outcome: record.outcome,
    payload: parseObject(record.payloadJson, "legacy payload_json"),
    taskRunSnapshot: parseObject(record.snapshotJson, "legacy snapshot_json"),
  };
}

export function decodeIntegrationLearningProjection(
  record: IntegrationLearningProjectionRecord,
): DecodedLearningProjection {
  const evidence = parseObject(record.evidenceSnapshotJson, "integration evidence_snapshot_json");
  const taskRunSnapshot = evidence.taskRun;
  if (!taskRunSnapshot || Array.isArray(taskRunSnapshot) || typeof taskRunSnapshot !== "object") {
    throw new TypeError("integration evidence taskRun must be an object");
  }
  const runEvent = evidence.runEventRef;
  let lifecycle: string;
  if (record.runEventRef === null) {
    lifecycle = syntheticLifecycle(record);
  } else {
    if (!runEvent || Array.isArray(runEvent) || typeof runEvent !== "object"
      || typeof (runEvent as Record<string, unknown>).type !== "string") {
      throw new TypeError("event-backed integration evidence requires runEventRef.type");
    }
    lifecycle = canonicalLifecycle((runEvent as Record<string, unknown>).type as string);
  }
  const outcome = (taskRunSnapshot as Record<string, unknown>).status;
  if (typeof outcome !== "string" || !outcome) {
    throw new TypeError("integration evidence taskRun.status is required");
  }
  return {
    runId: record.aggregateId,
    attemptOrdinal: record.attemptOrdinal,
    eventSeq: record.runEventRef === null ? 0 : record.aggregateVersion,
    lifecycle,
    outcome,
    payload: parseObject(record.payloadJson, "integration payload_json"),
    taskRunSnapshot: taskRunSnapshot as Record<string, unknown>,
  };
}

const VOLATILE_KEY = /(^id$|(?:^|_)?(?:id|uuid)$|Id$|Uuid$|(?:At|_at)$|timestamp|^now$|policy)/i;

function stableProjectionValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableProjectionValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !VOLATILE_KEY.test(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stableProjectionValue(child)]));
}

/** Digest only stable decoded semantics; identity, clocks, UUIDs, and mutable policy are compared elsewhere. */
export function canonicalLearningProjectionDigest(projection: DecodedLearningProjection): string {
  return sha256({
    run_id: projection.runId,
    attempt_ordinal: projection.attemptOrdinal,
    event_seq: projection.eventSeq,
    lifecycle: projection.lifecycle,
    outcome: projection.outcome,
    payload: stableProjectionValue(projection.payload),
    task_run: stableProjectionValue(projection.taskRunSnapshot),
  });
}

function snapshotHash(value: string, field: string): string {
  return sha256(parseObject(value, field));
}

function projectionPairIdentityBlocker(
  legacy: LegacyLearningProjectionRecord,
  integration: IntegrationLearningProjectionRecord,
): string | null {
  if (legacy.sourceEventId !== integration.sourceEventId
    || legacy.outboxSequence !== integration.outboxSequence
    || legacy.runId !== integration.aggregateId
    || legacy.attemptOrdinal !== integration.attemptOrdinal
    || legacy.attemptId !== integration.attemptId) {
    return "projection pair identity mismatch";
  }
  if (!Number.isSafeInteger(legacy.eventSeq) || legacy.eventSeq < 0
    || !Number.isSafeInteger(integration.aggregateVersion) || integration.aggregateVersion < 0) {
    return "projection pair version identity is malformed";
  }
  if (legacy.eventSeq > 0) {
    const expectedSource = `run:${legacy.runId}:event:${legacy.eventSeq}`;
    return legacy.eventSeq === integration.aggregateVersion
      && integration.runEventRef === legacy.sourceEventId
      && legacy.sourceEventId === expectedSource
      ? null
      : "event-backed projection identity mismatch";
  }
  const syntheticPrefix = `run:${legacy.runId}:synthetic:${legacy.lifecycle}:`
    + `${legacy.attemptId ?? ""}:${legacy.attemptOrdinal}:`;
  const stableInputHash = legacy.sourceEventId.slice(syntheticPrefix.length);
  return integration.runEventRef === null
    && integration.aggregateVersion === legacy.attemptOrdinal
    && legacy.sourceEventId.startsWith(syntheticPrefix)
    && /^[a-f0-9]{64}$/.test(stableInputHash)
    ? null
    : "synthetic projection identity mismatch";
}

export function reconcileLearningProjectionPair(
  legacy: LegacyLearningProjectionRecord | null,
  integration: IntegrationLearningProjectionRecord | null,
): LearningProjectionReconciliation {
  const present = integration ?? legacy;
  if (!present) throw new TypeError("Learning projection reconciliation requires at least one side");
  const base = {
    sourceEventId: present.sourceEventId,
    outboxSequence: present.outboxSequence,
    legacyHash: legacy?.payloadHash ?? null,
    integrationHash: integration?.payloadHash ?? null,
    legacySnapshotHash: null,
    integrationSnapshotHash: null,
    legacyDigest: null,
    integrationDigest: null,
  };
  if (!legacy || !integration) return { ...base, status: "missing" };
  const identityBlocker = projectionPairIdentityBlocker(legacy, integration);
  if (identityBlocker) return { ...base, status: "blocker", detail: identityBlocker };
  if (legacy.payloadHash !== integration.payloadHash) return { ...base, status: "hash_mismatch" };
  try {
    const evidence = parseObject(integration.evidenceSnapshotJson, "integration evidence_snapshot_json");
    const taskRun = evidence.taskRun;
    if (!taskRun || Array.isArray(taskRun) || typeof taskRun !== "object") {
      throw new TypeError("integration evidence taskRun must be an object");
    }
    const legacySnapshotHash = snapshotHash(legacy.snapshotJson, "legacy snapshot_json");
    const integrationSnapshotHash = sha256(taskRun);
    const snapshots = { ...base, legacySnapshotHash, integrationSnapshotHash };
    if (legacySnapshotHash !== integrationSnapshotHash) {
      return { ...snapshots, status: "snapshot_mismatch" };
    }
    const legacyDigest = canonicalLearningProjectionDigest(decodeLegacyLearningProjection(legacy));
    const integrationDigest = canonicalLearningProjectionDigest(decodeIntegrationLearningProjection(integration));
    const digests = { ...snapshots, legacyDigest, integrationDigest };
    return legacyDigest === integrationDigest
      ? { ...digests, status: "match" }
      : { ...digests, status: "digest_mismatch" };
  } catch (error) {
    return {
      ...base,
      status: "blocker",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
