#!/usr/bin/env node
/* global AbortSignal, console, fetch */
import Database from "better-sqlite3";
import path from "node:path";
import process from "node:process";

const CONSUMER_LAG_WARNING_MIN = 1;
const CONSUMER_LAG_CRITICAL = 10_000;
const TERMINAL_UNACKED_WARNING_MIN = 1;
const TERMINAL_UNACKED_CRITICAL_AGE_MS = 120_000;
const RECEIPT_UNCERTAIN_CRITICAL_AGE_MS = 120_000;
const SETTLED_STATUSES = ["completed", "failed", "cancelled", "blocked"];
const FINAL_STATUSES = ["completed", "cancelled"];
const EXPECTED_SCHEMA_VERSION = 46;
const REQUIRED_COMMANDS = ["task_run.steer", "task_run.follow_up", "task_run.cancel", "task_run.resume", "task_run.compact", "task_run.submit_user_input", "task_run.resolve_approval"];
const REQUIRED_EVENTS = ["task_run.started", "task_run.waiting_input", "task_run.blocked", "task_run.resumed", "task_run.completed", "task_run.failed", "task_run.cancelled", "approval.requested", "approval.resolved", "user_input.submitted"];
const REQUIRED_OPERATOR_ENDPOINTS = [
  "channel.sessions.create", "channel.sessions.get", "channel.submissions.create", "channel.submissions.get",
  "channel.task_runs.get", "channel.task_run_commands.create", "channel.task_run_commands.get",
  "channel.task_run_interactions.list", "channel.task_run_transcript.list", "channel.task_run_artifacts.list",
  "channel.task_run_artifacts.get",
  "channel.event_consumers.claim", "channel.event_consumers.ack", "channel.task_run_events.stream",
  "operator.workspace_goals.list", "operator.workspace_goals.get", "operator.workspace_goals.create",
  "operator.workspace_goals.revise_definition", "operator.workspace_goals.revise_roadmap",
  "operator.workspace_goals.generate_roadmap", "operator.workspace_goals.get_operation",
  "operator.workspace_goals.decide", "operator.workspace_goals.start_task_run",
];
const REQUIRED_OPERATOR_READ_ENDPOINTS = [
  "operator.read.capabilities.get", "operator.sessions.list",
  "operator.sessions.task_runs.list", "operator.sessions.task_runs.latest",
];

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
  const unacked = (statuses, column) => db.prepare(`SELECT COUNT(*) AS count,MIN(r.updated_at) AS oldestUpdatedAt
    FROM runs r LEFT JOIN event_consumers ec
      ON ec.run_id=r.id AND ec.consumer_id=?
    WHERE r.status IN (${statuses.map(() => "?").join(",")})
      AND (ec.${column} IS NULL OR ec.${column}<r.last_event_seq)`).get(consumerId, ...statuses);
  const settled = unacked(SETTLED_STATUSES, "settled_acked_seq");
  const final = unacked(FINAL_STATUSES, "final_acked_seq");
  return {
    consumerLag: lag,
    settledUnacked: settled.count,
    finalUnacked: final.count,
    terminalUnacked: settled.count,
    terminalOldestUnackedAgeMs: settled.oldestUpdatedAt === null
      ? null
      : Math.max(0, now - settled.oldestUpdatedAt),
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

function readReceiptHealth(db, now) {
  const read = (table) => {
    if (!tableExists(db, table)) return null;
    const row = db.prepare(`SELECT
      SUM(CASE WHEN status='started' THEN 1 ELSE 0 END) AS started,
      SUM(CASE WHEN status='outcome_unknown' THEN 1 ELSE 0 END) AS outcomeUnknown,
      MIN(CASE WHEN status IN ('started','outcome_unknown') THEN updated_at END) AS oldestUpdatedAt
      FROM ${table}`).get();
    return {
      started: row.started ?? 0,
      outcomeUnknown: row.outcomeUnknown ?? 0,
      oldestUncertainAgeMs: row.oldestUpdatedAt === null ? null : Math.max(0, now - row.oldestUpdatedAt),
    };
  };
  return {
    commands: read("task_run_command_receipts"),
    workspaceGoals: read("workspace_goal_operation_receipts"),
  };
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

async function readCapabilities(url, token) {
  try {
    const response = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json();
    const data = body?.data;
    const commands = new Set(data?.commandTypes ?? []);
    const events = new Set(data?.eventTypes ?? []);
    const operatorEndpoints = new Set(data?.operator?.endpointIds ?? []);
    const apiVersions = new Set(data?.apiVersions ?? []);
    const compatible = response.ok
      && data?.persistenceSchemaVersion === EXPECTED_SCHEMA_VERSION
      && apiVersions.has("operator.read.v1")
      && REQUIRED_COMMANDS.every((item) => commands.has(item))
      && REQUIRED_EVENTS.every((item) => events.has(item))
      && data?.interactions?.approvalResolution === true
      && data?.interactions?.userInputSubmission === true
      && data?.operator?.workspaceGoals === true
      && data?.operator?.roadmapGenerationIdempotent === true
      && REQUIRED_OPERATOR_ENDPOINTS.every((item) => operatorEndpoints.has(item))
      && data?.approval?.ready === true
      && ["legacy", "canonical"].includes(data?.approval?.authority)
      && data?.receiptRecovery?.exactReplay === true
      && data?.receiptRecovery?.commandLookup === true
      && data?.receiptRecovery?.interruptedEffectState === "outcome_unknown"
      && data?.receiptRecovery?.automaticUnknownReplay === false
      && data?.retention?.automaticDeletion === false
      && data?.retention?.cursorExpiry === false;
    return { reachable: true, status: response.status, compatible, data };
  } catch (error) {
    return { reachable: false, status: null, compatible: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function readOperatorReadCapabilities(url, token) {
  try {
    const response = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
    const body = await response.json();
    const data = body?.data;
    const endpoints = new Set(data?.endpointIds ?? []);
    const bindings = new Set(data?.pagination?.cursorBindings ?? []);
    const compatible = response.ok
      && data?.profileVersion === "1.0"
      && REQUIRED_OPERATOR_READ_ENDPOINTS.every((item) => endpoints.has(item))
      && data?.pagination?.cursorOpaque === true
      && data?.pagination?.cursorExpiry === false
      && data?.pagination?.cursorSurvivesRestart === true
      && data?.pagination?.membershipConsistency === "snapshot"
      && data?.pagination?.valueConsistency === "read_committed"
      && data?.pagination?.sessionOrder === "created_at_desc_id_desc"
      && data?.pagination?.taskRunOrder === "created_at_desc_id_desc"
      && ["endpoint", "resource", "filter", "snapshot"].every((item) => bindings.has(item))
      && data?.retention?.automaticDeletion === false
      && data?.retention?.tombstones === false
      && data?.limits?.sessionListMax === 200
      && data?.limits?.taskRunListMax === 200;
    return { reachable: true, status: response.status, compatible, data };
  } catch (error) {
    return { reachable: false, status: null, compatible: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function severityFor(snapshot) {
  if (snapshot.ready) return "ready";
  if (snapshot.schemaVersion !== EXPECTED_SCHEMA_VERSION
    || snapshot.migrationOpenIssues === null
    || snapshot.migrationOpenIssues > 0
    || !snapshot.health.reachable
    || !snapshot.capabilities.compatible
    || !snapshot.operatorReadCapabilities.compatible
    || !snapshot.writerLeaseFresh
    || snapshot.consumerLag === null
    || snapshot.consumerLag >= CONSUMER_LAG_CRITICAL
    || snapshot.terminalUnacked === null
    || (snapshot.terminalOldestUnackedAgeMs ?? 0) >= TERMINAL_UNACKED_CRITICAL_AGE_MS
    || (snapshot.receipts?.commands?.outcomeUnknown ?? 0) > 0
    || (snapshot.receipts?.workspaceGoals?.outcomeUnknown ?? 0) > 0
    || (snapshot.receipts?.commands?.oldestUncertainAgeMs ?? 0) >= RECEIPT_UNCERTAIN_CRITICAL_AGE_MS
    || (snapshot.receipts?.workspaceGoals?.oldestUncertainAgeMs ?? 0) >= RECEIPT_UNCERTAIN_CRITICAL_AGE_MS
    || !snapshot.authority) return "critical";
  return "warning";
}

async function main() {
  const database = process.env.TAGENT_DB?.trim();
  if (!database) throw new Error("TAGENT_DB is required");
  const consumerId = process.env.TAGENT_GATEWAY_CONSUMER_ID?.trim() || "gateway-production";
  const healthUrl = process.env.TAGENT_HEALTH_URL?.trim() || "http://127.0.0.1:3100/api/v1/health";
  const capabilitiesUrl = process.env.TAGENT_CAPABILITIES_URL?.trim() || healthUrl.replace(/\/health(?:\?.*)?$/, "/capabilities");
  const operatorReadCapabilitiesUrl = process.env.TAGENT_OPERATOR_READ_CAPABILITIES_URL?.trim()
    || capabilitiesUrl.replace(/\/capabilities(?:\?.*)?$/, "/operator/capabilities");
  const coreToken = process.env.TAGENT_GATEWAY_CORE_TOKEN?.trim() || "";
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
      receipts: readReceiptHealth(db, now),
    };
  } finally {
    db.close();
  }

  const health = await readHealth(healthUrl);
  const capabilities = await readCapabilities(capabilitiesUrl, coreToken);
  const operatorReadCapabilities = await readOperatorReadCapabilities(operatorReadCapabilitiesUrl, coreToken);
  const authorityReady = databaseSnapshot.authority !== null
    && ["legacy_active", "integration_active"].includes(databaseSnapshot.authority.status);
  const reasons = [];
  if (databaseSnapshot.schemaVersion !== EXPECTED_SCHEMA_VERSION) reasons.push("schema_version");
  if (databaseSnapshot.migrationOpenIssues === null || databaseSnapshot.migrationOpenIssues > 0) {
    reasons.push("migration_open_issues");
  }
  if (!health.reachable) reasons.push("health_unreachable");
  else if (!health.ok || !health.writerReady) reasons.push("health_writer_not_ready");
  if (!capabilities.reachable) reasons.push("capabilities_unreachable");
  else if (!capabilities.compatible) reasons.push("capabilities_incompatible");
  if (!operatorReadCapabilities.reachable) reasons.push("operator_read_capabilities_unreachable");
  else if (!operatorReadCapabilities.compatible) reasons.push("operator_read_capabilities_incompatible");
  if (!databaseSnapshot.writerLeaseFresh) reasons.push("writer_lease_not_fresh");
  if (databaseSnapshot.consumerLag === null || databaseSnapshot.consumerLag > 0) reasons.push("consumer_lag");
  if (databaseSnapshot.settledUnacked === null || databaseSnapshot.settledUnacked > 0) reasons.push("settled_unacked");
  if (databaseSnapshot.finalUnacked === null || databaseSnapshot.finalUnacked > 0) reasons.push("final_unacked");
  if (databaseSnapshot.receipts.commands === null) reasons.push("command_receipts_unavailable");
  else {
    if (databaseSnapshot.receipts.commands.started > 0
      && (databaseSnapshot.receipts.commands.oldestUncertainAgeMs ?? 0) >= RECEIPT_UNCERTAIN_CRITICAL_AGE_MS) {
      reasons.push("command_receipts_stale_started");
    }
    if (databaseSnapshot.receipts.commands.outcomeUnknown > 0) reasons.push("command_receipts_outcome_unknown");
  }
  if (databaseSnapshot.receipts.workspaceGoals === null) reasons.push("goal_receipts_unavailable");
  else {
    if (databaseSnapshot.receipts.workspaceGoals.started > 0
      && (databaseSnapshot.receipts.workspaceGoals.oldestUncertainAgeMs ?? 0) >= RECEIPT_UNCERTAIN_CRITICAL_AGE_MS) {
      reasons.push("goal_receipts_stale_started");
    }
    if (databaseSnapshot.receipts.workspaceGoals.outcomeUnknown > 0) reasons.push("goal_receipts_outcome_unknown");
  }
  if (!authorityReady) reasons.push("authority_not_active");

  const snapshot = {
    probeVersion: 4,
    database: path.resolve(database),
    healthUrl,
    capabilitiesUrl,
    operatorReadCapabilitiesUrl,
    consumerId,
    ...databaseSnapshot,
    writerReady: health.writerReady && databaseSnapshot.writerLeaseFresh,
    authorityReady,
    health,
    capabilities,
    operatorReadCapabilities,
    thresholds: {
      consumerLagWarningMin: CONSUMER_LAG_WARNING_MIN,
      consumerLagCritical: CONSUMER_LAG_CRITICAL,
      terminalUnackedWarningMin: TERMINAL_UNACKED_WARNING_MIN,
      terminalUnackedCriticalAgeMs: TERMINAL_UNACKED_CRITICAL_AGE_MS,
      receiptUncertainCriticalAgeMs: RECEIPT_UNCERTAIN_CRITICAL_AGE_MS,
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
