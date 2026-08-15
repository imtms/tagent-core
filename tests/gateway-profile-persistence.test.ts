import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SqlitePersistence, Store } from "@tagent/persistence-sqlite";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function adapter(store: Store): SqlitePersistence {
  return new SqlitePersistence(store, {
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

describe("gateway profile persistence", () => {
  it("creates and reopens the current concurrency schema", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "tagent-profile-schema-"));
    directories.push(directory);
    const filename = path.join(directory, "core.db");
    const current = new Store(filename);
    expect(current.getSchemaVersion()).toBe(1);
    for (const table of ["sessions", "session_supervisor_inbox", "skills"]) {
      const revision = (current.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string; type: string; notnull: number; dflt_value: string | null;
      }>).find((column) => column.name === "revision");
      expect(revision).toMatchObject({ type: "INTEGER", notnull: 1, dflt_value: "1" });
    }
    current.close();

    const reopened = new Store(filename);
    expect(reopened.getSchemaVersion()).toBe(1);
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
