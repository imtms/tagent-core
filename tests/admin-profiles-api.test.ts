import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AdminMemoryRecordsResponseSchema,
  AdminMemoryStatusResponseSchema,
  decodeAbi,
  ErrorEnvelopeSchema,
  MemoryRecallResponseSchema,
  ProfileOperationResponseSchema,
  type AdminMemoryRecordsResponse,
} from "@tagent/abi";
import { createCoreApplication } from "@tagent/core-service/application";
import { createApp, type ServiceCredential } from "@tagent/http-fastify";
import { Store } from "@tagent/persistence-sqlite";
import { corePersistence, httpTestResources } from "./support/test-persistence.js";

const apps: Array<ReturnType<typeof createApp>> = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(apps.splice(0).map((app) => app.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(memory?: Record<string, unknown>, serviceCredentials: ServiceCredential[] = []) {
  const workspace = await mkdtemp(path.join(tmpdir(), "tagent-admin-profiles-"));
  directories.push(workspace);
  const store = new Store(":memory:");
  const persistence = corePersistence(store);
  const service = createCoreApplication({
    persistence: persistence,
    workspace: workspace,
    runtimeFactory: () => ({
      prompt: async () => undefined, steer: async () => "accepted" as const, followUp: async () => "accepted" as const,
      compact: async () => undefined, abort: () => undefined, dispose: async () => undefined,
      getMessages: () => [], getError: () => undefined,
    }),
    runtimeDefaults: undefined,
    memory: undefined,
    memoryScopeId: undefined,
  });
  const app = createApp({
    ...httpTestResources(store), service, workspaceRoot: workspace, logger: false, serviceCredentials,
    ...(memory ? { memory: memory as never } : {}),
  });
  apps.push(app);
  return { app, store, service };
}

describe("Admin capability profiles", () => {
  it("bounds and redacts Memory reads and gives external writes durable exact replay", async () => {
    const captureRequests: unknown[] = [];
    const memory = {
      readiness: async () => ({ ready: true, degraded: false, reasons: [] }),
      status: async () => ({}),
      recall: async () => ({ cards: [{ id: "memory-1", kind: "fact", title: "Title", content: "Content", score: 0.9 }], coldTopics: [] }),
      export: async () => ({ records: [{
        id: "memory-1", kind: "fact", tier: "warm", scope: { type: "workspace", id: "*" },
        title: "Title", content: "Content", summary: "Summary", status: "active", confidence: 0.8,
        sourceRefs: [{ sourceType: "artifact", sourceId: "/private/absolute/path" }],
        metadata: { prompt: "secret", privateToolArguments: { token: "secret" } },
        createdAt: 10, updatedAt: 20,
      }], topics: [] }),
      listRecordsPage: async () => ({ records: [{
        id: "memory-1", kind: "fact", tier: "warm", scope: { type: "workspace", id: "*" },
        title: "Title", content: "Content", summary: "Summary", status: "active", confidence: 0.8,
        sourceRefs: [{ sourceType: "artifact", sourceId: "/private/absolute/path" }],
        metadata: { prompt: "secret", privateToolArguments: { token: "secret" } },
        createdAt: 10, updatedAt: 20,
      }], snapshotCreatedAt: 10 }),
      enqueueCapture: async (request: unknown) => { captureRequests.push(request); return { jobId: "capture-job-1" }; },
      forget: async () => ({ records: 1 }), restore: async () => ({}), upsert: async () => ({}),
      getColdTopic: async () => null,
    };
    const { app } = await fixture(memory);

    const status = await app.inject({ method: "GET", url: "/api/v1/admin/profiles/memory/status" });
    expect(decodeAbi(AdminMemoryStatusResponseSchema, status.json()).data.status).toEqual({
      available: true, ready: true, degraded: false, reasons: [],
    });
    const recall = await app.inject({
      method: "POST", url: "/api/v1/admin/profiles/memory/recall", payload: { cue: "remember" },
    });
    expect(decodeAbi(MemoryRecallResponseSchema, recall.json()).data.result.items).toHaveLength(1);

    const listed = await app.inject({
      method: "GET", url: "/api/v1/admin/profiles/memory/records?scopeType=workspace&scopeId=*&limit=1",
    });
    const record = decodeAbi(AdminMemoryRecordsResponseSchema, listed.json()).data.items[0];
    expect(record.sourceRefs[0].sourceRef).toHaveLength(32);
    expect(JSON.stringify(record)).not.toContain("/private/absolute/path");
    expect(JSON.stringify(record)).not.toContain("privateToolArguments");

    const headers = { "idempotency-key": "memory-capture-1" };
    const payload = { scope: { type: "workspace", id: "*" }, content: "Durable user fact" };
    const captured = await app.inject({ method: "POST", url: "/api/v1/admin/profiles/memory/captures", headers, payload });
    const operation = decodeAbi(ProfileOperationResponseSchema, captured.json()).data.operation;
    expect(operation).toMatchObject({ status: "succeeded", result: { jobId: "capture-job-1" } });
    expect(captureRequests).toHaveLength(1);

    const replay = await app.inject({ method: "POST", url: "/api/v1/admin/profiles/memory/captures", headers, payload });
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(captureRequests).toHaveLength(1);

    const lookup = await app.inject({ method: "GET", url: "/api/v1/admin/operations/memory-capture-1" });
    expect(decodeAbi(ProfileOperationResponseSchema, lookup.json()).data.operation.status).toBe("succeeded");

    const conflict = await app.inject({
      method: "POST", url: "/api/v1/admin/profiles/memory/captures", headers,
      payload: { ...payload, content: "Different fact" },
    });
    expect(decodeAbi(ErrorEnvelopeSchema, conflict.json()).error.code).toBe("idempotency.conflict");
  });

  it("authorizes Admin operation lookup with its independent scope and original principal", async () => {
    const memory = {
      readiness: async () => ({ ready: true, degraded: false, reasons: [] }),
      enqueueCapture: async () => ({ jobId: "capture-job-scoped" }),
    };
    const tokenWithoutLookup = "admin-memory-without-lookup-12345";
    const deniedFixture = await fixture(memory, [{
      token: tokenWithoutLookup,
      scopes: ["admin:memory:write"],
      principal: { subjectId: "gateway-admin-denied", resourceScopes: [{ type: "workspace", id: "*" }] },
    }]);
    const payload = { scope: { type: "workspace", id: "*" }, content: "Scoped capture" };
    const deniedHeaders = {
      authorization: `Bearer ${tokenWithoutLookup}`,
      "idempotency-key": "memory-capture-scoped-denied",
    };
    expect((await deniedFixture.app.inject({
      method: "POST", url: "/api/v1/admin/profiles/memory/captures", headers: deniedHeaders, payload,
    })).statusCode).toBe(200);
    const denied = await deniedFixture.app.inject({
      method: "GET",
      url: "/api/v1/admin/operations/memory-capture-scoped-denied",
      headers: { authorization: `Bearer ${tokenWithoutLookup}` },
    });
    expect(denied.statusCode).toBe(403);
    expect(decodeAbi(ErrorEnvelopeSchema, denied.json()).error.code).toBe("auth.permission_denied");

    const tokenWithLookup = "admin-memory-with-lookup-scope-123";
    const allowedFixture = await fixture(memory, [{
      token: tokenWithLookup,
      scopes: ["admin:memory:write", "admin:operations:read"],
      principal: { subjectId: "gateway-admin-allowed", resourceScopes: [{ type: "workspace", id: "*" }] },
    }]);
    const allowedHeaders = {
      authorization: `Bearer ${tokenWithLookup}`,
      "idempotency-key": "memory-capture-scoped-allowed",
    };
    await allowedFixture.app.inject({
      method: "POST", url: "/api/v1/admin/profiles/memory/captures", headers: allowedHeaders, payload,
    });
    const allowed = await allowedFixture.app.inject({
      method: "GET",
      url: "/api/v1/admin/operations/memory-capture-scoped-allowed",
      headers: { authorization: `Bearer ${tokenWithLookup}` },
    });
    expect(allowed.statusCode).toBe(200);
    expect(decodeAbi(ProfileOperationResponseSchema, allowed.json()).data.operation.status).toBe("succeeded");
  });

  it("returns schema-valid durable Memory operations for a maximum-length scope ID", async () => {
    const captureRequests: unknown[] = [];
    const { app } = await fixture({
      readiness: async () => ({ ready: true, degraded: false, reasons: [] }),
      enqueueCapture: async (request: unknown) => { captureRequests.push(request); return { jobId: "long-scope-job" }; },
    });
    const scopeId = "s".repeat(256);
    const headers = { "idempotency-key": "memory-long-scope" };
    const payload = { scope: { type: "workspace", id: scopeId }, content: "Durable boundary fact" };
    const first = await app.inject({ method: "POST", url: "/api/v1/admin/profiles/memory/captures", headers, payload });
    const expected = decodeAbi(ProfileOperationResponseSchema, first.json()).data;
    expect(first.statusCode).toBe(200);
    expect(expected.operation.resource).toEqual({ type: "memory_scope", id: scopeId });

    const replay = await app.inject({ method: "POST", url: "/api/v1/admin/profiles/memory/captures", headers, payload });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(decodeAbi(ProfileOperationResponseSchema, replay.json()).data).toEqual(expected);
    const lookup = await app.inject({ method: "GET", url: "/api/v1/admin/operations/memory-long-scope" });
    expect(decodeAbi(ProfileOperationResponseSchema, lookup.json()).data).toEqual(expected);
    expect(captureRequests).toHaveLength(1);
  });

  it("traverses all Memory snapshot members beyond 500", async () => {
    const memoryRecords = Array.from({ length: 501 }, (_, index) => ({
      id: `memory-${String(index).padStart(3, "0")}`,
      kind: "fact", tier: "warm", scope: { type: "workspace", id: "memory-large" },
      title: `Title ${index}`, content: `Content ${index}`, summary: "", status: "active", confidence: 0.8,
      sourceRefs: [], createdAt: index + 1, updatedAt: index + 1,
    }));
    const requestedLimits: number[] = [];
    const memory = {
      readiness: async () => ({ ready: true, degraded: false, reasons: [] }),
      listRecordsPage: async (_access: unknown, _scope: unknown, query: {
        snapshotCreatedAt?: number; after?: { createdAt: number; id: string }; limit: number;
      }) => {
        requestedLimits.push(query.limit);
        const snapshotCreatedAt = query.snapshotCreatedAt ?? Math.max(...memoryRecords.map((record) => record.createdAt));
        const records = memoryRecords.filter((record) => record.createdAt <= snapshotCreatedAt && (!query.after
          || record.createdAt < query.after.createdAt
          || record.createdAt === query.after.createdAt && record.id < query.after.id))
          .sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id))
          .slice(0, query.limit);
        return { records, snapshotCreatedAt };
      },
    };
    const { app } = await fixture(memory);
    const memoryIds: string[] = [];
    let memoryCursor: string | null = null;
    let memoryPageCount = 0;
    do {
      const response: AdminMemoryRecordsResponse["data"] = decodeAbi(AdminMemoryRecordsResponseSchema, (await app.inject({
        method: "GET",
        url: `/api/v1/admin/profiles/memory/records?scopeType=workspace&scopeId=memory-large&limit=200${memoryCursor ? `&cursor=${encodeURIComponent(memoryCursor)}` : ""}`,
      })).json()).data;
      memoryIds.push(...response.items.map((item) => item.id));
      memoryCursor = response.pageInfo.nextCursor;
      memoryPageCount += 1;
      if (memoryPageCount === 1) memoryRecords[0].updatedAt = 1_000_000;
    } while (memoryCursor);
    expect(memoryIds).toHaveLength(501);
    expect(new Set(memoryIds).size).toBe(501);
    expect(requestedLimits).toEqual([201, 201, 201]);

  });
});
