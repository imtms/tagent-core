import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  decodeAbi,
  ErrorEnvelopeSchema,
  OperatorContextManifestListResponseSchema,
  OperatorInboxItemResponseSchema,
  OperatorInboxListResponseSchema,
  ProfileOperationResponseSchema,
} from "@tagent/abi";
import { createCoreApplication } from "@tagent/core-service/application";
import { effectiveTaskExecutionPolicy } from "@tagent/governance";
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
  const workspace = await mkdtemp(path.join(tmpdir(), "tagent-inbox-context-"));
  directories.push(workspace);
  const store = new Store(":memory:");
  const service = createCoreApplication(corePersistence(store), workspace, () => ({
    prompt: async () => undefined, steer: async () => "accepted" as const, followUp: async () => "accepted" as const,
    compact: async () => undefined, abort: () => undefined, dispose: async () => undefined,
    getMessages: () => [], getError: () => undefined,
  }));
  const app = createApp({
    ...httpTestResources(store), service, workspaceRoot: workspace, logger: false, serviceCredentials: credentials,
  });
  apps.push(app);
  return { app, store };
}

function analysis(summary: string) {
  const objectives = [{ id: `objective-${summary}`, summary, timing: "current" as const, kind: "change" as const }];
  return {
    summary,
    objectives,
    intent: "new_task" as const,
    targetRunId: null,
    priority: 500,
    urgency: "normal" as const,
    relation: "independent" as const,
    acceptanceCriteria: ["verified"],
    scope: summary,
    nonGoals: [],
    confidence: 0.9,
    reason: "INTERNAL_ROUTER_REASON_MUST_NOT_LEAK",
    routerVersion: "private-router",
    executionPolicy: { ...effectiveTaskExecutionPolicy({ objectives }), gateProfile: "strict" as const },
  };
}

function mutationHeaders(revision: number, key: string) {
  return { "if-match": `"r${revision}"`, "idempotency-key": key };
}

describe("Operator Inbox and Context Manifest profiles", () => {
  it("pages a durable Inbox snapshot and conditionally mutates the collection with exact replay", async () => {
    const { app, store } = await fixture();
    const session = store.createSession("Inbox");
    const firstItem = store.enqueueSessionInbox(session.id, "First prompt", analysis("First"), "inbox-first");
    const secondItem = store.enqueueSessionInbox(session.id, "Second prompt", analysis("Second"), "inbox-second");
    store.db.prepare("UPDATE session_supervisor_inbox SET created_at=1000,updated_at=1000 WHERE session_id=?").run(session.id);
    const url = `/api/v1/operator/sessions/${session.id}/inbox`;

    const firstPage = decodeAbi(OperatorInboxListResponseSchema, (await app.inject({
      method: "GET", url: `${url}?limit=1`,
    })).json());
    expect(firstPage.data.items).toHaveLength(1);
    expect(firstPage.data.pageInfo.hasMore).toBe(true);
    expect(firstPage.data.collectionRevision).toBe(3);
    expect(JSON.stringify(firstPage)).not.toContain("INTERNAL_ROUTER_REASON_MUST_NOT_LEAK");
    expect(JSON.stringify(firstPage)).not.toContain("private-router");

    const concurrent = store.enqueueSessionInbox(session.id, "Concurrent prompt", analysis("Concurrent"), "inbox-concurrent");
    store.db.prepare("UPDATE session_supervisor_inbox SET created_at=1000,updated_at=1000 WHERE id=?").run(concurrent.id);
    const secondPage = decodeAbi(OperatorInboxListResponseSchema, (await app.inject({
      method: "GET", url: `${url}?limit=1&cursor=${encodeURIComponent(firstPage.data.pageInfo.nextCursor!)}`,
    })).json());
    expect(secondPage.data.items).toHaveLength(1);
    expect([firstPage.data.items[0].id, secondPage.data.items[0].id].sort())
      .toEqual([firstItem.id, secondItem.id].sort());
    expect(secondPage.data.items[0].id).not.toBe(concurrent.id);

    const revision = secondPage.data.collectionRevision;
    const itemId = secondPage.data.items[0].id;
    const decisionUrl = `${url}/${itemId}/decision`;
    const changed = await app.inject({
      method: "POST", url: decisionUrl,
      headers: mutationHeaders(revision, "inbox-decision-1"),
      payload: { decision: "defer" },
    });
    expect(changed.statusCode).toBe(200);
    const changedBody = decodeAbi(OperatorInboxItemResponseSchema, changed.json());
    expect(changedBody.data).toMatchObject({ item: { decision: "defer" }, collectionRevision: revision + 1 });

    const replay = await app.inject({
      method: "POST", url: decisionUrl,
      headers: mutationHeaders(revision, "inbox-decision-1"),
      payload: { decision: "defer" },
    });
    expect(replay.headers["idempotency-replayed"]).toBe("true");
    expect(decodeAbi(OperatorInboxItemResponseSchema, replay.json()).data).toEqual(changedBody.data);

    const payloadConflict = await app.inject({
      method: "POST", url: decisionUrl,
      headers: mutationHeaders(revision, "inbox-decision-1"),
      payload: { decision: "pending" },
    });
    expect(decodeAbi(ErrorEnvelopeSchema, payloadConflict.json()).error.code).toBe("idempotency.conflict");
    const stale = await app.inject({
      method: "POST", url: decisionUrl,
      headers: mutationHeaders(revision, "inbox-decision-2"),
      payload: { decision: "pending" },
    });
    expect(decodeAbi(ErrorEnvelopeSchema, stale.json()).error.code).toBe("concurrency.conflict");
  });

  it("starts Inbox work once, exposes durable lookup, and never repeats the TaskRun side effect", async () => {
    const { app, store } = await fixture();
    const session = store.createSession("Start");
    const item = store.enqueueSessionInbox(session.id, "Start this", analysis("Start this"), "start-item");
    const url = `/api/v1/operator/sessions/${session.id}/inbox/${item.id}/start`;
    const headers = {
      "idempotency-key": "start-operation-1",
      "x-tagent-delegated-actor": "gateway-user-1",
      "x-tagent-delegated-request-id": "gateway-intent-1",
    };
    const started = decodeAbi(ProfileOperationResponseSchema, (await app.inject({ method: "POST", url, headers })).json());
    expect(started.data.operation).toMatchObject({ status: "succeeded", result: { itemId: item.id } });
    const runCount = Number(store.db.prepare("SELECT COUNT(*) FROM runs WHERE session_id=?").pluck().get(session.id));

    const replayResponse = await app.inject({ method: "POST", url, headers });
    expect(replayResponse.headers["idempotency-replayed"]).toBe("true");
    expect(decodeAbi(ProfileOperationResponseSchema, replayResponse.json()).data).toEqual(started.data);
    expect(Number(store.db.prepare("SELECT COUNT(*) FROM runs WHERE session_id=?").pluck().get(session.id))).toBe(runCount);

    const lookup = decodeAbi(ProfileOperationResponseSchema, (await app.inject({
      method: "GET", url: "/api/v1/operator/operations/start-operation-1",
    })).json());
    expect(lookup.data).toEqual(started.data);
    const audit = store.db.prepare(`SELECT principal_id AS principalId,delegated_actor_id AS delegatedActorId,
      delegated_request_id AS delegatedRequestId,outcome FROM profile_audit_events
      WHERE endpoint_id='operator.session_inbox.start'`).get();
    expect(audit).toEqual({
      principalId: "local-admin",
      delegatedActorId: "gateway-user-1",
      delegatedRequestId: "gateway-intent-1",
      outcome: "succeeded",
    });
  });

  it("publishes bounded Context Manifests without raw source IDs, paths, prompts, or metadata", async () => {
    const { app, store } = await fixture();
    const session = store.createSession("Context");
    const run = store.createRun(session.id, "Context run");
    for (let index = 0; index < 3; index += 1) {
      store.recordContextManifest({
        id: `manifest-${index}`,
        runId: run.id,
        attempt: 1,
        source: "session",
        items: [{
          kind: "project_rule",
          sourceId: `/Users/private/workspace/SECRET_RULE_${index}.md`,
          selected: true,
          reason: "PRIVATE_SELECTION_REASON",
          estimatedTokens: 10 + index,
          metadata: { prompt: "SYSTEM_PROMPT_SECRET", credential: "TOKEN_SECRET", toolArguments: { private: true } },
        }],
        stats: { prompt: "PRIVATE_PROMPT", absolutePath: "/Users/private", totalTokens: 10 + index },
        manifestHash: String(index).repeat(64),
        createdAt: 1000 + index,
      });
    }
    const url = `/api/v1/operator/task-runs/${run.id}/context-manifests`;
    const first = decodeAbi(OperatorContextManifestListResponseSchema, (await app.inject({
      method: "GET", url: `${url}?limit=2`,
    })).json());
    expect(first.data.items).toHaveLength(2);
    expect(first.data.pageInfo.hasMore).toBe(true);
    const serialized = JSON.stringify(first);
    for (const secret of ["/Users/private", "SECRET_RULE", "PRIVATE_SELECTION_REASON", "SYSTEM_PROMPT_SECRET", "TOKEN_SECRET", "toolArguments"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(first.data.items[0].items[0].sourceRef).toMatch(/^[a-f0-9]{32}$/);
    const second = decodeAbi(OperatorContextManifestListResponseSchema, (await app.inject({
      method: "GET", url: `${url}?limit=2&cursor=${encodeURIComponent(first.data.pageInfo.nextCursor!)}`,
    })).json());
    expect(second.data.items).toHaveLength(1);
    expect(new Set([...first.data.items, ...second.data.items].map((manifest) => manifest.id)).size).toBe(3);
  });

  it("fails closed on missing profile scopes and resource grants", async () => {
    const token = "inbox-context-token-123456789";
    const { app, store } = await fixture([{
      token,
      scopes: ["operator:inbox:read", "operator:context-manifests:read"],
      principal: { subjectId: "gateway", resourceScopes: [{ type: "session", id: "different" }] },
    }]);
    const session = store.createSession("Denied");
    const headers = { authorization: `Bearer ${token}` };
    const response = await app.inject({
      method: "GET", url: `/api/v1/operator/sessions/${session.id}/inbox`, headers,
    });
    expect(response.statusCode).toBe(403);
    expect(decodeAbi(ErrorEnvelopeSchema, response.json()).error.code).toBe("auth.resource_scope_denied");
  });
});
