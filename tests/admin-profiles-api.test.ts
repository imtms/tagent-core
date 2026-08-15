import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AdminAutonomyApprovalResponseSchema,
  AdminAutonomyApprovalsResponseSchema,
  AdminLearningSettingsResponseSchema,
  AdminMemoryRecordsResponseSchema,
  AdminMemoryStatusResponseSchema,
  AdminWorkflowResponseSchema,
  AdminWorkflowsResponseSchema,
  decodeAbi,
  ErrorEnvelopeSchema,
  MemoryRecallResponseSchema,
  ProfileOperationResponseSchema,
} from "@tagent/abi";
import { createCoreApplication } from "@tagent/core-service/application";
import { createApp, type ServiceCredential } from "@tagent/http-fastify";
import { LearningFeatureControl } from "@tagent/learning";
import { Store } from "@tagent/persistence-sqlite";
import { corePersistence, httpTestResources, learningSettingsPersistence } from "./support/test-persistence.js";

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
  const learningControl = new LearningFeatureControl(learningSettingsPersistence(store), true, {
    learningEnabled: true, autoExecutionEnabled: true,
  });
  const service = createCoreApplication(persistence, workspace, () => ({
    prompt: async () => undefined, steer: async () => "accepted" as const, followUp: async () => "accepted" as const,
    compact: async () => undefined, abort: () => undefined, dispose: async () => undefined,
    getMessages: () => [], getError: () => undefined,
  }), undefined, undefined, undefined, learningControl);
  const app = createApp({
    ...httpTestResources(store), service, workspaceRoot: workspace, logger: false, learningControl, serviceCredentials,
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

  it("publishes stable Learning, Workflow, and Autonomy projections with monotonic revisions", async () => {
    const { app, service, store } = await fixture();
    const session = store.createSession("Admin profile workspace");
    const workflow = service.teachWorkflow(session.id, {
      name: "Verify change", intent: "verify a software change", cueTerms: ["verify"], applicability: ["verify change"],
      nonApplicability: [], preconditions: [], inputContract: [], outputContract: [],
      steps: [{ stepId: "check", instruction: "Run checks", required: true }],
      verification: [{ check: "tests", required: true, successCondition: "pass" }], requiredCapabilities: [], riskClass: "low",
    }, "message:1") as { id: string };

    const learning = await app.inject({ method: "GET", url: "/api/v1/admin/profiles/learning/settings" });
    expect(learning.headers.etag).toBe('"r1"');
    expect(decodeAbi(AdminLearningSettingsResponseSchema, learning.json()).data).toMatchObject({
      resourceRevision: 1, settings: { learningEnabled: true, autoExecutionEnabled: true },
    });

    const workflows = await app.inject({
      method: "GET", url: `/api/v1/admin/profiles/workflows?scopeId=${session.id}`,
    });
    const projected = decodeAbi(AdminWorkflowsResponseSchema, workflows.json()).data.items[0];
    expect(projected).toMatchObject({ id: workflow.id, resourceRevision: 1, revision: { name: "Verify change" } });
    expect(projected).not.toHaveProperty("deleteReason");

    const suspendHeaders = { "idempotency-key": "workflow-suspend-1", "if-match": '"r1"' };
    const suspendedResponse = await app.inject({
      method: "POST", url: `/api/v1/admin/profiles/workflows/${workflow.id}/suspend`,
      headers: suspendHeaders, payload: { reason: "maintenance" },
    });
    expect(suspendedResponse.statusCode).toBe(200);
    const suspended = decodeAbi(AdminWorkflowResponseSchema, suspendedResponse.json()).data.workflow;
    expect(suspended).toMatchObject({ status: "suspended", resourceRevision: 2 });
    const replay = await app.inject({
      method: "POST", url: `/api/v1/admin/profiles/workflows/${workflow.id}/suspend`,
      headers: suspendHeaders, payload: { reason: "maintenance" },
    });
    expect(replay.headers["idempotency-replayed"]).toBe("true");

    const stale = await app.inject({
      method: "POST", url: `/api/v1/admin/profiles/workflows/${workflow.id}/suspend`,
      headers: { "idempotency-key": "workflow-suspend-stale", "if-match": '"r1"' }, payload: { reason: "again" },
    });
    expect(decodeAbi(ErrorEnvelopeSchema, stale.json()).error.code).toBe("concurrency.conflict");

    const activation = await app.inject({
      method: "POST", url: `/api/v1/admin/profiles/workflows/${workflow.id}/activation-requests`,
      headers: { "idempotency-key": "workflow-activation-request-1" }, payload: { reason: "approved rollout" },
    });
    const activationOperation = decodeAbi(ProfileOperationResponseSchema, activation.json()).data.operation;
    expect(activationOperation.status).toBe("succeeded");
    const approvalId = String(activationOperation.result?.approvalId);

    const approvals = await app.inject({
      method: "GET", url: `/api/v1/admin/profiles/autonomy/approvals?scopeId=${session.id}`,
    });
    expect(decodeAbi(AdminAutonomyApprovalsResponseSchema, approvals.json()).data.items[0]).toMatchObject({
      id: approvalId, status: "pending", resourceRevision: 1,
    });

    const decision = await app.inject({
      method: "POST", url: `/api/v1/admin/profiles/autonomy/approvals/${approvalId}/decision`,
      headers: { "idempotency-key": "approval-decision-1", "if-match": '"r1"' },
      payload: { decision: "approved", reason: "human reviewed" },
    });
    expect(decodeAbi(AdminAutonomyApprovalResponseSchema, decision.json()).data.approval).toMatchObject({
      id: approvalId, status: "approved", resourceRevision: 2,
    });

    const audit = store.db.prepare(`SELECT principal_id AS principalId,granted_scopes_json AS scopes
      FROM profile_audit_events WHERE profile_id='admin.autonomy.v1'`).get() as { principalId: string; scopes: string };
    expect(audit.principalId).toBe("local-admin");
    expect(JSON.parse(audit.scopes)).toContain("admin:autonomy:decide");
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
});
