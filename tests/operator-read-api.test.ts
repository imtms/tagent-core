import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CoreCapabilitiesResponseSchema,
  decodeAbi,
  ErrorEnvelopeSchema,
  OperatorLatestSessionTaskRunResponseSchema,
  OperatorReadCapabilitiesResponseSchema,
  OperatorSessionListResponseSchema,
  OperatorSessionTaskRunListResponseSchema,
  type OperatorSessionListResponse,
  type OperatorSessionTaskRunListResponse,
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

async function fixture(credentials: ServiceCredential[] = [], filename = ":memory:") {
  const workspace = await mkdtemp(path.join(tmpdir(), "tagent-operator-read-"));
  directories.push(workspace);
  const store = new Store(filename);
  const service = createCoreApplication({
    persistence: corePersistence(store),
    workspace: workspace,
    runtimeFactory: () => ({
      prompt: async () => undefined, steer: async () => "accepted" as const, followUp: async () => "accepted" as const,
      compact: async () => undefined, abort: () => undefined, dispose: async () => undefined, getMessages: () => [], getError: () => undefined,
    })
  });
  const app = createApp({
    ...httpTestResources(store), service, workspaceRoot: workspace, logger: false, serviceCredentials: credentials,
    runtimeConfig: { releaseVersion: "test", schemaVersion: store.getSchemaVersion() },
  });
  apps.push(app);
  return { app, store };
}

function pageUrl(pathname: string, cursor: string | null, limit = 2): string {
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor) query.set("cursor", cursor);
  return `${pathname}?${query}`;
}

describe("Operator Read API", () => {
  it("publishes a forward-compatible independent profile without extending the base allowlist", async () => {
    const { app } = await fixture();
    const baseCapabilities = decodeAbi(CoreCapabilitiesResponseSchema, (await app.inject({ method: "GET", url: "/api/v1/capabilities" })).json()).data;
    expect(baseCapabilities.apiVersions).toContain("operator.read.v1");
    expect(baseCapabilities.operator.endpointIds).not.toContain("operator.sessions.list");

    const operator = decodeAbi(
      OperatorReadCapabilitiesResponseSchema,
      (await app.inject({ method: "GET", url: "/api/v1/operator/capabilities" })).json(),
    ).data;
    expect(operator).toMatchObject({
      profileVersion: "1.0",
      pagination: { membershipConsistency: "snapshot", valueConsistency: "read_committed", cursorExpiry: false },
      retention: { automaticDeletion: false, tombstones: false },
      limits: { sessionListMax: 200, taskRunListMax: 200 },
    });
  });

  it("pages a snapshot of Sessions without duplicates when timestamps tie or a concurrent row is added", async () => {
    const { app, store } = await fixture();
    const sessions = Array.from({ length: 5 }, (_, index) => store.createSession(`Session ${index}`));
    store.db.prepare("UPDATE sessions SET created_at=1000,updated_at=1000").run();

    const first = decodeAbi(OperatorSessionListResponseSchema, (await app.inject({
      method: "GET", url: pageUrl("/api/v1/operator/sessions", null),
    })).json());
    expect(first.data.items).toHaveLength(2);
    expect(first.data.pageInfo.hasMore).toBe(true);

    const concurrent = store.createSession("Concurrent");
    store.db.prepare("UPDATE sessions SET created_at=1000,updated_at=1000 WHERE id=?").run(concurrent.id);
    const seen = [...first.data.items.map((item) => item.id)];
    let cursor = first.data.pageInfo.nextCursor;
    while (cursor) {
      const page = decodeAbi(OperatorSessionListResponseSchema, (await app.inject({
        method: "GET", url: pageUrl("/api/v1/operator/sessions", cursor),
      })).json());
      seen.push(...page.data.items.map((item) => item.id));
      cursor = page.data.pageInfo.nextCursor;
    }
    expect(new Set(seen).size).toBe(sessions.length);
    expect(seen).toHaveLength(sessions.length);
    expect(seen).not.toContain(concurrent.id);

    const retried = decodeAbi(OperatorSessionListResponseSchema, (await app.inject({
      method: "GET", url: pageUrl("/api/v1/operator/sessions", first.data.pageInfo.nextCursor),
    })).json());
    expect(retried.data.items.map((item) => item.id)).toEqual(seen.slice(2, 4));
  });

  it("filters Operator discovery and denies concrete reads outside the principal resource scope", async () => {
    const scopedToken = "operator-scoped-resource-token";
    const wildcardToken = "operator-wildcard-resource-token";
    const emptyToken = "operator-empty-resource-token";
    const scoped: ServiceCredential = {
      token: scopedToken,
      scopes: ["sessions:read", "runs:read"],
      principal: { subjectId: "operator-scoped", resourceScopes: [] },
    };
    const { app, store } = await fixture([
      scoped,
      {
        token: wildcardToken,
        scopes: ["sessions:read", "runs:read"],
        principal: { subjectId: "operator-wildcard", resourceScopes: [{ type: "workspace", id: "*" }] },
      },
      {
        token: emptyToken,
        scopes: ["sessions:read", "runs:read"],
        principal: { subjectId: "operator-empty", resourceScopes: [] },
      },
    ]);
    const allowed = store.createSession("Allowed");
    const denied = store.createSession("Denied");
    store.createRun(allowed.id, "Allowed run");
    store.createRun(denied.id, "Denied run");
    scoped.principal!.resourceScopes.push({ type: "workspace", id: allowed.id });

    const scopedHeaders = { authorization: `Bearer ${scopedToken}` };
    const scopedList = decodeAbi(OperatorSessionListResponseSchema, (await app.inject({
      method: "GET", url: "/api/v1/operator/sessions", headers: scopedHeaders,
    })).json()).data;
    expect(scopedList.items.map((item) => item.id)).toEqual([allowed.id]);
    expect((await app.inject({ method: "GET", url: `/api/v1/operator/sessions/${allowed.id}/task-runs`, headers: scopedHeaders })).statusCode).toBe(200);
    const deniedRead = await app.inject({ method: "GET", url: `/api/v1/operator/sessions/${denied.id}/task-runs/latest`, headers: scopedHeaders });
    expect(deniedRead.statusCode).toBe(403);
    expect(decodeAbi(ErrorEnvelopeSchema, deniedRead.json()).error.code).toBe("auth.resource_scope_denied");

    const emptyList = decodeAbi(OperatorSessionListResponseSchema, (await app.inject({
      method: "GET", url: "/api/v1/operator/sessions", headers: { authorization: `Bearer ${emptyToken}` },
    })).json()).data;
    expect(emptyList.items).toEqual([]);
    const wildcardList = decodeAbi(OperatorSessionListResponseSchema, (await app.inject({
      method: "GET", url: "/api/v1/operator/sessions", headers: { authorization: `Bearer ${wildcardToken}` },
    })).json()).data;
    expect(new Set(wildcardList.items.map((item) => item.id))).toEqual(new Set([allowed.id, denied.id]));
  });

  it("returns bounded TaskRun summaries, stable pages, latest semantics, and distinct missing/empty Sessions", async () => {
    const { app, store } = await fixture();
    const session = store.createSession("Runs");
    const empty = store.createSession("Empty");
    const runs = Array.from({ length: 5 }, (_, index) => store.createRun(session.id, `Goal ${index}`));
    store.db.prepare("UPDATE runs SET created_at=2000,updated_at=2000 WHERE session_id=?").run(session.id);
    store.requestUserInput(runs[0].id, "Choose", [{ key: "choice", label: "Choice", description: "", inputType: "text", required: true, placeholder: "" }]);
    store.db.prepare("UPDATE runs SET contract_json=? WHERE session_id=?")
      .run(JSON.stringify({ summary: "Public summary", sourceInput: "SYSTEM_PROMPT_MUST_NOT_LEAK" }), session.id);

    const first = decodeAbi(OperatorSessionTaskRunListResponseSchema, (await app.inject({
      method: "GET", url: pageUrl(`/api/v1/operator/sessions/${session.id}/task-runs`, null),
    })).json());
    expect(first.data.items).toHaveLength(2);
    expect(first.data.items.every((item) => item.sessionId === session.id && item.goalSummary === "Public summary")).toBe(true);
    expect(JSON.stringify(first)).not.toContain("SYSTEM_PROMPT_MUST_NOT_LEAK");

    const concurrent = store.createRun(session.id, "Concurrent");
    store.db.prepare("UPDATE runs SET created_at=2000,updated_at=2000 WHERE id=?").run(concurrent.id);
    const seen = [...first.data.items.map((item) => item.id)];
    let cursor = first.data.pageInfo.nextCursor;
    while (cursor) {
      const page = decodeAbi(OperatorSessionTaskRunListResponseSchema, (await app.inject({
        method: "GET", url: pageUrl(`/api/v1/operator/sessions/${session.id}/task-runs`, cursor),
      })).json());
      seen.push(...page.data.items.map((item) => item.id));
      cursor = page.data.pageInfo.nextCursor;
    }
    expect(new Set(seen).size).toBe(runs.length);
    expect(seen).toHaveLength(runs.length);
    expect(seen).not.toContain(concurrent.id);

    const mismatched = await app.inject({
      method: "GET",
      url: pageUrl(`/api/v1/operator/sessions/${empty.id}/task-runs`, first.data.pageInfo.nextCursor),
    });
    expect(mismatched.statusCode).toBe(400);
    expect(decodeAbi(ErrorEnvelopeSchema, mismatched.json()).error.code).toBe("pagination.cursor_invalid");

    store.db.prepare("UPDATE runs SET updated_at=3000 WHERE id=?").run(runs[0].id);
    const latest = decodeAbi(OperatorLatestSessionTaskRunResponseSchema, (await app.inject({
      method: "GET", url: `/api/v1/operator/sessions/${session.id}/task-runs/latest`,
    })).json()).data;
    expect(latest).toMatchObject({ id: runs[0].id, currentAttemptId: `attempt:${runs[0].id}:1`, pendingInteractionKinds: ["user_input"] });

    expect(decodeAbi(OperatorLatestSessionTaskRunResponseSchema, (await app.inject({
      method: "GET", url: `/api/v1/operator/sessions/${empty.id}/task-runs/latest`,
    })).json()).data).toBeNull();
    const missing = await app.inject({ method: "GET", url: "/api/v1/operator/sessions/missing/task-runs/latest" });
    expect(missing.statusCode).toBe(404);
    expect(decodeAbi(ErrorEnvelopeSchema, missing.json()).error.code).toBe("session.not_found");
  });

  it("rejects malformed, cross-resource, and over-limit cursors and requires both read scopes", async () => {
    const readToken = "r".repeat(24);
    const { app, store } = await fixture([{ token: readToken, scopes: ["sessions:read"] }]);
    const session = store.createSession("Scoped");
    store.createRun(session.id, "Run");
    const headers = { authorization: `Bearer ${readToken}` };

    expect((await app.inject({ method: "GET", url: "/api/v1/operator/sessions" })).statusCode).toBe(401);
    const overLimit = await app.inject({ method: "GET", url: "/api/v1/operator/sessions?limit=201", headers });
    expect(overLimit.statusCode).toBe(400);
    expect(decodeAbi(ErrorEnvelopeSchema, overLimit.json()).error.code).toBe("pagination.limit_invalid");
    const malformed = await app.inject({ method: "GET", url: "/api/v1/operator/sessions?cursor=bad", headers });
    expect(decodeAbi(ErrorEnvelopeSchema, malformed.json()).error.code).toBe("pagination.cursor_invalid");
    const oversized = await app.inject({
      method: "GET", url: `/api/v1/operator/sessions?cursor=${"x".repeat(4097)}`, headers,
    });
    expect(decodeAbi(ErrorEnvelopeSchema, oversized.json()).error.code).toBe("pagination.cursor_invalid");
    const forbidden = await app.inject({ method: "GET", url: `/api/v1/operator/sessions/${session.id}/task-runs`, headers });
    expect(forbidden.statusCode).toBe(403);
    expect(decodeAbi(ErrorEnvelopeSchema, forbidden.json()).error.details).toMatchObject({ missingScopes: ["runs:read"] });
  });

  it("traverses large Session and TaskRun histories at the declared maximum page size", async () => {
    const { app, store } = await fixture();
    const parent = store.createSession("Large history");
    const insertSession = store.db.prepare(`INSERT INTO sessions
      (id,title,model_id,reasoning_effort,created_at,updated_at) VALUES (?,?,?,'high',?,?)`);
    const insertRun = store.db.prepare(`INSERT INTO runs
      (id,session_id,request_id,status,phase,goal,created_at,updated_at) VALUES (?,?,?,'completed','done',?,?,?)`);
    store.db.transaction(() => {
      for (let index = 0; index < 450; index += 1) {
        const ordinal = String(index).padStart(4, "0");
        insertSession.run(`bulk-session-${ordinal}`, `Bulk ${ordinal}`, "gpt-5.6-sol", 10_000 + index, 10_000 + index);
        insertRun.run(`bulk-run-${ordinal}`, parent.id, `bulk-request-${ordinal}`, `Bulk goal ${ordinal}`, 20_000 + index, 20_000 + index);
      }
    })();

    const sessionIds: string[] = [];
    let sessionCursor: string | null = null;
    do {
      const response: Awaited<ReturnType<typeof app.inject>> = await app.inject({ method: "GET", url: pageUrl("/api/v1/operator/sessions", sessionCursor, 200) });
      const page: OperatorSessionListResponse = decodeAbi(OperatorSessionListResponseSchema, response.json());
      sessionIds.push(...page.data.items.map((item) => item.id));
      sessionCursor = page.data.pageInfo.nextCursor;
    } while (sessionCursor);
    const runIds: string[] = [];
    let runCursor: string | null = null;
    do {
      const response: Awaited<ReturnType<typeof app.inject>> = await app.inject({ method: "GET", url: pageUrl(`/api/v1/operator/sessions/${parent.id}/task-runs`, runCursor, 200) });
      const page: OperatorSessionTaskRunListResponse = decodeAbi(OperatorSessionTaskRunListResponseSchema, response.json());
      runIds.push(...page.data.items.map((item) => item.id));
      runCursor = page.data.pageInfo.nextCursor;
    } while (runCursor);
    expect(sessionIds).toHaveLength(451);
    expect(new Set(sessionIds).size).toBe(451);
    expect(runIds).toHaveLength(450);
    expect(new Set(runIds).size).toBe(450);
  });

  it("continues an opaque cursor after Core reopens the same durable database", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "tagent-operator-restart-"));
    directories.push(directory);
    const filename = path.join(directory, "core.db");
    const firstRuntime = await fixture([], filename);
    Array.from({ length: 3 }, (_, index) => firstRuntime.store.createSession(`Restart ${index}`));
    const first = decodeAbi(OperatorSessionListResponseSchema, (await firstRuntime.app.inject({
      method: "GET", url: pageUrl("/api/v1/operator/sessions", null, 1),
    })).json());
    await firstRuntime.app.close();
    apps.splice(apps.indexOf(firstRuntime.app), 1);

    const reopened = await fixture([], filename);
    const second = decodeAbi(OperatorSessionListResponseSchema, (await reopened.app.inject({
      method: "GET", url: pageUrl("/api/v1/operator/sessions", first.data.pageInfo.nextCursor, 1),
    })).json());
    expect(second.data.items).toHaveLength(1);
    expect(second.data.items[0].id).not.toBe(first.data.items[0].id);
    expect(second.data.pageInfo.snapshot).toBe(first.data.pageInfo.snapshot);
  });
});
