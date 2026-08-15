import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  decodeAbi,
  ErrorEnvelopeSchema,
  OperatorSessionSettingsResponseSchema,
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

async function fixture(credentials: ServiceCredential[] = []) {
  const workspace = await mkdtemp(path.join(tmpdir(), "tagent-session-settings-"));
  directories.push(workspace);
  const store = new Store(":memory:", { defaultModelId: "model-primary" });
  const service = createCoreApplication(corePersistence(store), workspace, () => ({
    prompt: async () => undefined, steer: async () => "accepted" as const, followUp: async () => "accepted" as const,
    compact: async () => undefined, abort: () => undefined, dispose: async () => undefined,
    getMessages: () => [], getError: () => undefined,
  }));
  const app = createApp({
    ...httpTestResources(store), service, workspaceRoot: workspace, logger: false, serviceCredentials: credentials,
    runtimeConfig: { modelId: "model-primary", fallbackModelIds: ["model-fallback"] },
  });
  apps.push(app);
  return { app, store };
}

describe("Operator Session Settings profile", () => {
  it("reads, conditionally updates, exactly replays, and rejects changed payloads or stale revisions", async () => {
    const { app, store } = await fixture();
    const session = store.createSession("Original");
    const url = `/api/v1/operator/sessions/${session.id}/settings`;

    const get = await app.inject({ method: "GET", url });
    expect(get.headers.etag).toBe('"r1"');
    expect(decodeAbi(OperatorSessionSettingsResponseSchema, get.json()).data.settings).toMatchObject({
      sessionId: session.id,
      title: "Original",
      revision: 1,
    });

    const headers = {
      "idempotency-key": "settings-change-1",
      "if-match": '"r1"',
      "x-request-id": "core-request-settings-1",
      "x-tagent-delegated-actor": "user-42",
      "x-tagent-delegated-request-id": "gateway-request-42",
    };
    const changed = await app.inject({
      method: "PATCH", url, headers, payload: { title: "Gateway title", modelId: "model-fallback" },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).toBe('"r2"');
    const changedBody = decodeAbi(OperatorSessionSettingsResponseSchema, changed.json());
    expect(changedBody).toMatchObject({
      data: { settings: { title: "Gateway title", modelId: "model-fallback", revision: 2 } },
      requestId: "core-request-settings-1",
    });

    const replay = await app.inject({
      method: "PATCH", url, headers: { ...headers, "x-request-id": "core-request-settings-replay" },
      payload: { title: "Gateway title", modelId: "model-fallback" },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(decodeAbi(OperatorSessionSettingsResponseSchema, replay.json()).data).toEqual(changedBody.data);

    const conflict = await app.inject({
      method: "PATCH", url, headers, payload: { title: "Different payload" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(decodeAbi(ErrorEnvelopeSchema, conflict.json()).error.code).toBe("idempotency.conflict");

    const stale = await app.inject({
      method: "PATCH", url,
      headers: { ...headers, "idempotency-key": "settings-change-stale" },
      payload: { reasoningEffort: "low" },
    });
    expect(stale.statusCode).toBe(409);
    expect(decodeAbi(ErrorEnvelopeSchema, stale.json()).error).toMatchObject({
      code: "concurrency.conflict",
      details: { currentRevision: 2, currentEtag: '"r2"' },
    });

    const audits = store.db.prepare(`SELECT principal_id AS principalId,delegated_actor_id AS delegatedActorId,
      delegated_request_id AS delegatedRequestId,request_id AS requestId FROM profile_audit_events`).all();
    expect(audits).toEqual([{
      principalId: "local-admin",
      delegatedActorId: "user-42",
      delegatedRequestId: "gateway-request-42",
      requestId: "core-request-settings-1",
    }]);
  });

  it("requires profile scopes, an explicit resource grant, idempotency identity, and revision", async () => {
    const token = "settings-profile-token-123456789";
    const { app, store } = await fixture([{
      token,
      scopes: ["operator:session-settings:read", "operator:session-settings:write"],
      principal: { subjectId: "gateway-settings", resourceScopes: [{ type: "session", id: "allowed-session" }] },
    }]);
    const session = store.createSession("Scoped");
    const url = `/api/v1/operator/sessions/${session.id}/settings`;
    const authorization = { authorization: `Bearer ${token}` };

    expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    const denied = await app.inject({ method: "GET", url, headers: authorization });
    expect(denied.statusCode).toBe(403);
    expect(decodeAbi(ErrorEnvelopeSchema, denied.json()).error.code).toBe("auth.resource_scope_denied");

    const wildcardToken = "settings-wildcard-token-123456";
    const wildcard = await fixture([{
      token: wildcardToken,
      scopes: ["operator:session-settings:read", "operator:session-settings:write"],
      principal: { subjectId: "gateway-settings", resourceScopes: [{ type: "session", id: "*" }] },
    }]);
    const wildcardSession = wildcard.store.createSession("Wildcard");
    const wildcardUrl = `/api/v1/operator/sessions/${wildcardSession.id}/settings`;
    const wildcardAuth = { authorization: `Bearer ${wildcardToken}` };
    expect((await wildcard.app.inject({ method: "GET", url: wildcardUrl, headers: wildcardAuth })).statusCode).toBe(200);
    const missingHeaders = await wildcard.app.inject({
      method: "PATCH", url: wildcardUrl, headers: wildcardAuth, payload: { title: "No revision" },
    });
    expect(missingHeaders.statusCode).toBe(400);
    expect(decodeAbi(ErrorEnvelopeSchema, missingHeaders.json()).error.code).toBe("request.validation_failed");
  });
});
