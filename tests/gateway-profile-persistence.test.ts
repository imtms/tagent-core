import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LegacyStoreAdapter, Store } from "@tagent/persistence-sqlite";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function adapter(store: Store): LegacyStoreAdapter {
  return new LegacyStoreAdapter(store, {
    run: <T>(work: () => T): T => store.db.transaction(work)(),
  });
}

const identity = {
  principalId: "gateway-production",
  profileId: "operator.session-inbox.v1",
  endpointId: "operator.session_inbox.start",
  resourceType: "session_inbox_item",
  resourceId: "inbox-1",
  idempotencyKey: "gw-operation-1",
};

describe("gateway profile v47 persistence", () => {
  it("migrates a genuine v46 shape re-entrantly and adds concurrency revisions", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "tagent-v47-migration-"));
    directories.push(directory);
    const filename = path.join(directory, "core.db");
    const initial = new Store(filename);
    initial.db.exec(`
      DROP TABLE profile_audit_events;
      DROP TABLE profile_operation_receipts;
      DROP TABLE profile_mutation_receipts;
      DROP TABLE workspace_skill_revisions;
      DROP TABLE session_inbox_revisions;
      DROP TABLE skill_catalog_state;
      DROP TABLE profile_resource_revisions;
      ALTER TABLE sessions DROP COLUMN revision;
      ALTER TABLE session_supervisor_inbox DROP COLUMN revision;
      ALTER TABLE skills DROP COLUMN revision;
      UPDATE schema_meta SET version=46 WHERE id=1;
    `);
    initial.close();

    const migrated = new Store(filename);
    expect(migrated.getSchemaVersion()).toBe(47);
    for (const table of ["sessions", "session_supervisor_inbox", "skills"]) {
      const revision = (migrated.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string; type: string; notnull: number; dflt_value: string | null;
      }>).find((column) => column.name === "revision");
      expect(revision).toMatchObject({ type: "INTEGER", notnull: 1, dflt_value: "1" });
    }
    migrated.close();

    const reopened = new Store(filename);
    expect(reopened.getSchemaVersion()).toBe(47);
    reopened.close();
  });

  it("claims, replays, conflicts, settles, and recovers durable profile operations", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "tagent-profile-operation-"));
    directories.push(directory);
    const filename = path.join(directory, "core.db");
    const store = new Store(filename);
    const contracts = adapter(store).profileContracts;

    const claimed = contracts.claimOperation({
      ...identity,
      canonicalPayload: JSON.stringify({ action: "start" }),
      delegatedActorId: "user-42",
      delegatedRequestId: "gateway-intent-42",
    });
    expect(claimed.claimed).toBe(true);
    expect(claimed.receipt).toMatchObject({
      ...identity,
      delegatedActorId: "user-42",
      delegatedRequestId: "gateway-intent-42",
      status: "started",
    });
    const replay = contracts.claimOperation({ ...identity, canonicalPayload: JSON.stringify({ action: "start" }) });
    expect(replay).toMatchObject({ claimed: false, receipt: { status: "started" } });
    expect(() => contracts.claimOperation({ ...identity, canonicalPayload: JSON.stringify({ action: "different" }) }))
      .toThrow("idempotency conflict");
    expect(contracts.settleOperation(identity, "succeeded", { taskRunId: "run-1" })).toMatchObject({
      status: "succeeded",
      result: { taskRunId: "run-1" },
    });

    const uncertainIdentity = { ...identity, idempotencyKey: "gw-operation-uncertain" };
    contracts.claimOperation({ ...uncertainIdentity, canonicalPayload: "{}" });
    store.close();

    const reopened = new Store(filename);
    expect(adapter(reopened).profileContracts.getOperation(uncertainIdentity)).toMatchObject({
      status: "outcome_unknown",
      completedAt: expect.any(Number),
    });
    reopened.close();
  });

  it("audits authenticated principal and delegated provenance in separate columns without request bodies", () => {
    const store = new Store(":memory:");
    const contracts = adapter(store).profileContracts;
    contracts.recordAudit({
      principalId: "gateway-service",
      grantedScopes: ["admin:memory:write"],
      delegatedActorId: "user-7",
      delegatedRequestId: "gateway-request-7",
      requestId: "core-request-7",
      profileId: "admin.memory.v1",
      endpointId: "admin.memory.govern",
      resourceType: "memory",
      resourceId: "memory-7",
      operation: "correct",
      outcome: "succeeded",
    });
    const row = store.db.prepare(`SELECT principal_id AS principalId,granted_scopes_json AS grantedScopesJson,
      delegated_actor_id AS delegatedActorId,delegated_request_id AS delegatedRequestId,request_id AS requestId,
      profile_id AS profileId,endpoint_id AS endpointId,resource_id AS resourceId,outcome
      FROM profile_audit_events`).get();
    expect(row).toEqual({
      principalId: "gateway-service",
      grantedScopesJson: JSON.stringify(["admin:memory:write"]),
      delegatedActorId: "user-7",
      delegatedRequestId: "gateway-request-7",
      requestId: "core-request-7",
      profileId: "admin.memory.v1",
      endpointId: "admin.memory.govern",
      resourceId: "memory-7",
      outcome: "succeeded",
    });
    expect(JSON.stringify(row)).not.toContain("request body");
    store.close();
  });
});
