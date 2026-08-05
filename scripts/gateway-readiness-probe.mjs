#!/usr/bin/env node
/* global AbortSignal, console, fetch */
import Database from "better-sqlite3";
import path from "node:path";
import process from "node:process";

const CONSUMER_LAG_WARNING_MIN = 1;
const CONSUMER_LAG_CRITICAL = 10_000;
const TERMINAL_UNACKED_WARNING_MIN = 1;
const TERMINAL_UNACKED_CRITICAL_AGE_MS = 120_000;
const TERMINAL_STATUSES = ["completed", "failed", "cancelled", "interrupted"];

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function readSchemaVersion(db) {
  if (!tableExists(db, "schema_meta")) return null;
  return db.prepare("SELECT version FROM schema_meta WHERE id=1").get()?.version ?? null;
}

function readMigrationOpenIssues(db) {
  if (!tableExists(db, "migration_issues")) return null;
  return db.prepare("SELECT COUNT(*) AS count FROM migration_issues WHERE status='open'").get().count;
}

function readWriter(db, now) {
  if (!tableExists(db, "core_writer_lease")) {
    return { ownerId: null, fence: null, expiresAt: null, releasedAt: null, leaseFresh: false };
  }
  const row = db.prepare(`SELECT owner_id AS ownerId,fence,expires_at AS expiresAt,released_at AS releasedAt
    FROM core_writer_lease WHERE lock_name='core-writer'`).get();
  if (!row) return { ownerId: null, fence: null, expiresAt: null, releasedAt: null, leaseFresh: false };
  return { ...row, leaseFresh: row.releasedAt === null && row.expiresAt >= now };
}

function readConsumer(db, consumerId, now) {
  if (!tableExists(db, "runs") || !tableExists(db, "event_consumers")) {
    return { consumerLag: null, terminalUnacked: null, terminalOldestUnackedAgeMs: null };
  }
  const lag = db.prepare(`SELECT COALESCE(MAX(MAX(r.last_event_seq-COALESCE(ec.acked_seq,0),0)),0) AS value
    FROM runs r LEFT JOIN event_consumers ec
      ON ec.run_id=r.id AND ec.consumer_id=?`).get(consumerId).value;
  const terminal = db.prepare(`SELECT COUNT(*) AS count,MIN(r.updated_at) AS oldestUpdatedAt
    FROM runs r LEFT JOIN event_consumers ec
      ON ec.run_id=r.id AND ec.consumer_id=?
    WHERE r.status IN (${TERMINAL_STATUSES.map(() => "?").join(",")})
      AND (ec.terminal_acked_seq IS NULL OR ec.terminal_acked_seq<r.last_event_seq)`)
    .get(consumerId, ...TERMINAL_STATUSES);
  return {
    consumerLag: lag,
    terminalUnacked: terminal.count,
    terminalOldestUnackedAgeMs: terminal.oldestUpdatedAt === null
      ? null
      : Math.max(0, now - terminal.oldestUpdatedAt),
  };
}

function readAuthority(db) {
  if (!tableExists(db, "learning_projection_authority_state")) return null;
  return db.prepare(`SELECT active_source AS activeSource,status,generation,
    switch_watermark AS switchWatermark,legacy_last_acked AS legacyLastAcked,
    legacy_resume_position AS legacyResumePosition,
    integration_checkpoint AS integrationCheckpoint,rollback_checkpoint AS rollbackCheckpoint
    FROM learning_projection_authority_state WHERE id=1`).get() ?? null;
}

function readWatermarks(db) {
  if (!tableExists(db, "learning_projection_checkpoint")) return [];
  return db.prepare(`SELECT consumer,delivery_role AS deliveryRole,watermark,generation
    FROM learning_projection_checkpoint ORDER BY consumer,delivery_role`).all();
}

async function readHealth(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    const body = await response.json();
    return {
      reachable: true,
      status: response.status,
      ok: body?.data?.ok === true,
      writerReady: body?.data?.writer?.ready === true,
    };
  } catch (error) {
    return {
      reachable: false,
      status: null,
      ok: false,
      writerReady: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function severityFor(snapshot) {
  if (snapshot.ready) return "ready";
  if (snapshot.schemaVersion !== 34
    || snapshot.migrationOpenIssues === null
    || snapshot.migrationOpenIssues > 0
    || !snapshot.health.reachable
    || !snapshot.writerLeaseFresh
    || snapshot.consumerLag === null
    || snapshot.consumerLag >= CONSUMER_LAG_CRITICAL
    || snapshot.terminalUnacked === null
    || (snapshot.terminalOldestUnackedAgeMs ?? 0) >= TERMINAL_UNACKED_CRITICAL_AGE_MS
    || !snapshot.authority) return "critical";
  return "warning";
}

async function main() {
  const database = process.env.TAGENT_DB?.trim();
  if (!database) throw new Error("TAGENT_DB is required");
  const consumerId = process.env.TAGENT_GATEWAY_CONSUMER_ID?.trim() || "gateway-production";
  const healthUrl = process.env.TAGENT_HEALTH_URL?.trim() || "http://127.0.0.1:3100/api/v1/health";
  const now = Date.now();
  const db = new Database(path.resolve(database), { readonly: true, fileMustExist: true });
  let databaseSnapshot;
  try {
    const writer = readWriter(db, now);
    const consumer = readConsumer(db, consumerId, now);
    databaseSnapshot = {
      schemaVersion: readSchemaVersion(db),
      migrationOpenIssues: readMigrationOpenIssues(db),
      writerOwnerId: writer.ownerId,
      writerFence: writer.fence,
      writerExpiresAt: writer.expiresAt,
      writerReleasedAt: writer.releasedAt,
      writerLeaseFresh: writer.leaseFresh,
      ...consumer,
      authority: readAuthority(db),
      watermarks: readWatermarks(db),
    };
  } finally {
    db.close();
  }

  const health = await readHealth(healthUrl);
  const authorityReady = databaseSnapshot.authority !== null
    && ["legacy_active", "integration_active"].includes(databaseSnapshot.authority.status);
  const reasons = [];
  if (databaseSnapshot.schemaVersion !== 34) reasons.push("schema_version");
  if (databaseSnapshot.migrationOpenIssues === null || databaseSnapshot.migrationOpenIssues > 0) {
    reasons.push("migration_open_issues");
  }
  if (!health.reachable) reasons.push("health_unreachable");
  else if (!health.ok || !health.writerReady) reasons.push("health_writer_not_ready");
  if (!databaseSnapshot.writerLeaseFresh) reasons.push("writer_lease_not_fresh");
  if (databaseSnapshot.consumerLag === null || databaseSnapshot.consumerLag > 0) reasons.push("consumer_lag");
  if (databaseSnapshot.terminalUnacked === null || databaseSnapshot.terminalUnacked > 0) {
    reasons.push("terminal_unacked");
  }
  if (!authorityReady) reasons.push("authority_not_active");

  const snapshot = {
    probeVersion: 1,
    database: path.resolve(database),
    healthUrl,
    consumerId,
    ...databaseSnapshot,
    writerReady: health.writerReady && databaseSnapshot.writerLeaseFresh,
    authorityReady,
    health,
    thresholds: {
      consumerLagWarningMin: CONSUMER_LAG_WARNING_MIN,
      consumerLagCritical: CONSUMER_LAG_CRITICAL,
      terminalUnackedWarningMin: TERMINAL_UNACKED_WARNING_MIN,
      terminalUnackedCriticalAgeMs: TERMINAL_UNACKED_CRITICAL_AGE_MS,
    },
    ready: reasons.length === 0,
    reasons,
  };
  const output = { ...snapshot, severity: severityFor(snapshot) };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (!output.ready) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
});
