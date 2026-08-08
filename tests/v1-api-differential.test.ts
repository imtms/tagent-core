import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CommandResponseSchema,
  CoreCapabilitiesResponseSchema,
  decodeAbi,
  ErrorEnvelopeSchema,
  EventConsumerAckResponseSchema,
  EventConsumerClaimResponseSchema,
  MemoryRecallResponseSchema,
  SessionSchema,
  SubmissionResponseSchema,
  SuccessEnvelopeSchema,
  TaskRunEventSchema,
  TaskRunSchema,
  TaskRunInteractionsResponseSchema,
  TranscriptResponseSchema,
} from "@tagent/abi";
import { createApp } from "@tagent/http-fastify";
import { AgentService } from "@tagent/core-service/application";
import { Store } from "@tagent/persistence-sqlite/store";
import { agentPersistence, httpTestResources } from "./support/test-persistence.js";

const apps: Array<ReturnType<typeof createApp>> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class WaitingRuntime {
  private resolve?: () => void;

  prompt(): Promise<void> {
    return new Promise<void>((resolve) => { this.resolve = resolve; });
  }

  async steer() { return "accepted" as const; }
  async followUp() { return "accepted" as const; }
  async compact(): Promise<void> { throw new Error("compaction provider unavailable"); }
  abort(): void { this.resolve?.(); }
  getMessages() { return []; }
  getError() { return undefined; }
}

async function fixture(
  serviceCredentials: Parameters<typeof createApp>[0]["serviceCredentials"] = [],
  controlInboxCapacity = 32,
  overrides: Partial<Parameters<typeof createApp>[0]> = {},
) {
  const workspace = await mkdtemp(path.join(tmpdir(), "tagent-v1-api-"));
  temporaryDirectories.push(workspace);
  const store = new Store(":memory:");
  const service = new AgentService(agentPersistence(store), workspace, () => new WaitingRuntime(), { controlInboxCapacity });
  const app = createApp({
    ...httpTestResources(store),
    service,
    workspaceRoot: workspace,
    logger: false,
    serviceCredentials,
    ...overrides,
  });
  apps.push(app);
  return { app, service, store };
}

async function readSseEvent(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let body = "";
  while (!body.includes("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    body += decoder.decode(chunk.value, { stream: true });
  }
  const data = body.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
  if (!data) throw new Error(`SSE event data was not received: ${body}`);
  return JSON.parse(data) as unknown;
}

describe("v1 API contracts", () => {
  it("creates Sessions idempotently, exposes GET, and publishes capabilities", async () => {
    const { app, store } = await fixture();
    const headers = { "idempotency-key": "gateway-session-create", "x-request-id": "session-create-original" };
    const first = await app.inject({ method: "POST", url: "/api/v1/sessions", headers, payload: { title: "Gateway workspace", origin: { surface: "channel", gatewayActorId: "actor-1", sourceId: "channel-1" } } });
    expect(first.statusCode).toBe(200);
    const session = decodeAbi(SessionSchema, decodeAbi(SuccessEnvelopeSchema, first.json()).data);
    const replay = await app.inject({ method: "POST", url: "/api/v1/sessions", headers: { ...headers, "x-request-id": "session-create-replay" }, payload: { title: "Gateway workspace", origin: { surface: "channel", gatewayActorId: "actor-1", sourceId: "channel-1" } } });
    expect(decodeAbi(SessionSchema, decodeAbi(SuccessEnvelopeSchema, replay.json()).data)).toEqual(session);
    expect(store.listSessions()).toHaveLength(1);
    const conflict = await app.inject({ method: "POST", url: "/api/v1/sessions", headers, payload: { title: "Changed" } });
    expect(conflict.statusCode).toBe(409);
    expect(decodeAbi(ErrorEnvelopeSchema, conflict.json()).error.code).toBe("session.idempotency_conflict");
    const read = await app.inject({ method: "GET", url: `/api/v1/sessions/${session.id}` });
    expect(decodeAbi(SessionSchema, decodeAbi(SuccessEnvelopeSchema, read.json()).data)).toEqual(session);
    const capabilities = decodeAbi(CoreCapabilitiesResponseSchema, (await app.inject({ method: "GET", url: "/api/v1/capabilities" })).json()).data;
    expect(capabilities).toMatchObject({ persistenceSchemaVersion: 39, interactions: { approvalResolution: true, userInputSubmission: true }, operator: { roadmapGenerationIdempotent: true } });
  });
  it("rejects idempotency-key reuse with different canonical content", async () => {
    const { app, store } = await fixture();
    const v1Session = store.createSession();

    const headers = { "idempotency-key": "shared-v1-key", "x-request-id": "v1-submission-request" };
    const first = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${v1Session.id}/submissions`,
      headers,
      payload: { content: " original v1 content ", modelId: "advisory-model-a" },
    });
    expect(first.statusCode).toBe(200);
    const firstEnvelope = decodeAbi(SubmissionResponseSchema, first.json());
    expect(store.getSessionSubmission(v1Session.id, "shared-v1-key")?.content).toBe("original v1 content");
    const sameCanonicalPayload = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${v1Session.id}/submissions`,
      headers: { ...headers, "x-request-id": "v1-submission-retry" },
      payload: { content: "original v1 content", modelId: "advisory-model-b" },
    });
    expect(decodeAbi(SubmissionResponseSchema, sameCanonicalPayload.json()).data.receipt).toEqual(firstEnvelope.data.receipt);

    const conflict = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${v1Session.id}/submissions`,
      headers,
      payload: { content: "different v1 content" },
    });
    expect(conflict.statusCode).toBe(409);
    expect(decodeAbi(ErrorEnvelopeSchema, conflict.json()).error).toMatchObject({ code: "submission.idempotency_conflict", requestId: "v1-submission-request", retryable: false });
    expect(conflict.json().error).not.toHaveProperty("category");
    expect(store.listSessionInbox(v1Session.id, true)).toHaveLength(1);
    expect(store.listRuns(v1Session.id)).toHaveLength(1);
  });

  it("maps v1 session, submission, and TaskRun fields to durable resources", async () => {
    const { app, store } = await fixture();
    const created = await app.inject({ method: "POST", url: "/api/v1/sessions", headers: { "x-request-id": "create-v1-session", "idempotency-key": "create-v1-session" }, payload: { title: "Mapped session" } });
    const sessionEnvelope = decodeAbi(SuccessEnvelopeSchema, created.json());
    const session = decodeAbi(SessionSchema, sessionEnvelope.data);
    expect(sessionEnvelope.requestId).toBe("create-v1-session");
    expect(session).toMatchObject({ title: "Mapped session", latestTaskRunStatus: null, latestTaskRunPhase: null });
    expect(store.getSession(session.id)).toMatchObject({ title: session.title, latestRunStatus: null, latestRunPhase: null });

    const submitted = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/submissions`,
      headers: { "idempotency-key": "mapped-submission" },
      payload: { content: "map this TaskRun" },
    });
    const receipt = decodeAbi(SubmissionResponseSchema, submitted.json()).data.receipt;
    expect(receipt.taskRunId).not.toBeNull();
    if (!receipt.taskRunId) throw new Error("submission did not start a TaskRun");
    const durableRun = store.getRun(receipt.taskRunId)!;
    const v1RunResponse = await app.inject({ method: "GET", url: `/api/v1/task-runs/${receipt.taskRunId}` });
    const v1Run = decodeAbi(TaskRunSchema, decodeAbi(SuccessEnvelopeSchema, v1RunResponse.json()).data);
    expect(v1Run).toMatchObject({ id: durableRun.id, sessionId: durableRun.sessionId, status: durableRun.status, phase: durableRun.phase, lastEventSequence: durableRun.lastEventSeq, attempt: durableRun.attempt });
    expect(v1Run.submissionId).toBe(receipt.submissionId);
    expect(v1Run.createdAt).toBe(new Date(durableRun.createdAt).toISOString());
  });

  it("returns versioned validation and not-found envelopes", async () => {
    const { app, store } = await fixture();
    const session = store.createSession();

    for (const url of ["/api/v1", "/api/v1/unknown"]) {
      const response = await app.inject({ method: "GET", url, headers: { "x-request-id": "unknown-v1-route" } });
      expect(response.statusCode).toBe(404);
      expect(decodeAbi(ErrorEnvelopeSchema, response.json()).error).toMatchObject({ code: "route.not_found", requestId: "unknown-v1-route" });
    }
    const invalid = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/submissions`,
      headers: { "x-request-id": "invalid-v1-request" },
      payload: { content: "missing idempotency header" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(decodeAbi(ErrorEnvelopeSchema, invalid.json()).error).toMatchObject({ code: "request.validation_failed", requestId: "invalid-v1-request" });

    const invalidLookup = await app.inject({
      method: "GET",
      url: `/api/v1/sessions/${session.id}/submissions/not!an!idempotency!key`,
      headers: { "x-request-id": "invalid-v1-lookup" },
    });
    expect(invalidLookup.statusCode).toBe(400);
    expect(decodeAbi(ErrorEnvelopeSchema, invalidLookup.json()).error).toMatchObject({ code: "request.validation_failed", requestId: "invalid-v1-lookup" });

  });

  it("maps durable replay and ACK state into stable v1 event envelopes", async () => {
    const { app, store } = await fixture();
    const run = store.createRun(store.createSession().id, "event mapping");
    store.appendEvent(run.id, "run.completed", { response: "done" });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const claim = await app.inject({ method: "POST", url: `/api/v1/task-runs/${run.id}/event-consumers/gateway/claim` });
    const cursor = decodeAbi(EventConsumerClaimResponseSchema, claim.json()).data.cursor;
    const skipped = await app.inject({ method: "GET", url: `/api/v1/task-runs/${run.id}/events?consumerId=gateway&generation=${cursor.generation}&after=1` });
    expect(skipped.statusCode).toBe(409);
    expect(decodeAbi(ErrorEnvelopeSchema, skipped.json()).error.code).toBe("event_consumer.cursor_mismatch");
    const controller = new AbortController();
    const replay = await fetch(`${address}/api/v1/task-runs/${run.id}/events?consumerId=gateway&generation=${cursor.generation}&after=0`, { signal: controller.signal });
    try {
      const event = decodeAbi(TaskRunEventSchema, await readSseEvent(replay));
      expect(event).toMatchObject({
        specVersion: "1.0",
        eventId: `task_run:${run.id}:1`,
        aggregateId: run.id,
        sequence: 1,
        type: "task_run.completed",
        correlationId: null,
        causationId: null,
        payload: {},
      });
    } finally {
      controller.abort();
    }
    const ack = await app.inject({
      method: "POST",
      url: `/api/v1/task-runs/${run.id}/event-consumers/gateway/ack`,
      payload: { generation: cursor.generation, sequence: 1 },
    });
    expect(decodeAbi(EventConsumerAckResponseSchema, ack.json()).data).toMatchObject({ status: "accepted", cursor: { acknowledgedSequence: 1 } });
    expect(store.listEvents(run.id)[0]).toMatchObject({ runId: run.id, seq: 1, type: "run.completed", data: { response: "done" } });
  });

  it("returns a 422 non-actionable decision through the v1 envelope", async () => {
    const { app, store } = await fixture();
    const session = store.createSession();
    const marker = "release-013-1785530015196";
    const v1 = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/submissions`,
      headers: { "idempotency-key": "non-actionable" },
      payload: { content: marker },
    });
    expect(v1.statusCode).toBe(422);
    expect(decodeAbi(ErrorEnvelopeSchema, v1.json()).error).toMatchObject({ code: "submission.non_actionable", details: { reason: "non_actionable_prompt" } });
  });

  it("pages the public transcript by durable sequence", async () => {
    const { app, store } = await fixture();
    const run = store.createRun(store.createSession().id, "paged transcript");
    for (const [index, content] of ["one", "two", "three"].entries()) {
      store.appendTranscript(run.id, 1, { role: "user", content, timestamp: index + 1 });
    }
    const first = decodeAbi(TranscriptResponseSchema, (await app.inject({ method: "GET", url: `/api/v1/task-runs/${run.id}/transcript?after=0&limit=2` })).json()).data;
    expect(first).toMatchObject({ items: [{ sequence: 1, text: "one" }, { sequence: 2, text: "two" }], pageInfo: { nextCursor: 2, hasMore: true, limit: 2 } });
    const second = decodeAbi(TranscriptResponseSchema, (await app.inject({ method: "GET", url: `/api/v1/task-runs/${run.id}/transcript?after=${first.pageInfo.nextCursor}&limit=2` })).json()).data;
    expect(second).toMatchObject({ items: [{ sequence: 3, text: "three" }], pageInfo: { nextCursor: null, hasMore: false, limit: 2 } });
  });

  it("returns typed paginated TaskRun interactions", async () => {
    const { app, store } = await fixture();
    const run = store.createRun(store.createSession().id, "typed interaction");
    const input = store.requestUserInput(run.id, "Target?", [{ key: "target", label: "Target", description: "Environment", inputType: "text", required: true, placeholder: "staging" }]);
    const response = await app.inject({ method: "GET", url: `/api/v1/task-runs/${run.id}/interactions?after=0&limit=1` });
    expect(decodeAbi(TaskRunInteractionsResponseSchema, response.json()).data).toMatchObject({
      items: [{ kind: "user_input", interaction: { id: input.id, taskRunId: run.id, attempt: 1, prompt: "Target?", status: "pending", response: {} } }],
      pageInfo: { nextCursor: null, hasMore: false, limit: 1 },
    });
  });

  it("returns a retryable 429 envelope when the control inbox is full", async () => {
    const { app, store } = await fixture([], 1);
    const run = store.createRun(store.createSession().id, "bounded control inbox");
    const command = (commandId: string, content: string) => ({ commandId, expectedAttemptId: null, type: "task_run.steer" as const, payload: { content } });
    expect((await app.inject({ method: "POST", url: `/api/v1/task-runs/${run.id}/commands`, payload: command("capacity-1", "first") })).statusCode).toBe(200);
    const full = await app.inject({ method: "POST", url: `/api/v1/task-runs/${run.id}/commands`, payload: command("capacity-2", "second") });
    expect(full.statusCode).toBe(429);
    expect(decodeAbi(ErrorEnvelopeSchema, full.json()).error).toMatchObject({ code: "task_run.command_capacity_exceeded", retryable: true });
  });

  it("accepts the current AttemptId and rejects a stale AttemptId with zero command side effects", async () => {
    const { app, store } = await fixture();
    const session = store.createSession();
    const started = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/submissions`,
      headers: { "idempotency-key": "attempt-fenced-command" },
      payload: { content: "keep the current attempt active" },
    });
    const runId = decodeAbi(SubmissionResponseSchema, started.json()).data.receipt.taskRunId!;
    const currentAttemptId = store.db.prepare("SELECT id FROM attempts WHERE run_id=? AND active=1").pluck().get(runId) as string;
    const before = {
      run: structuredClone(store.getRun(runId)),
      events: structuredClone(store.listEvents(runId)),
      controls: structuredClone(store.listControlInbox(runId)),
      operations: structuredClone(store.listOperations(runId)),
    };
    const stale = await app.inject({
      method: "POST",
      url: `/api/v1/task-runs/${runId}/commands`,
      payload: { commandId: "stale-attempt-command", expectedAttemptId: `${currentAttemptId}:stale`, type: "task_run.steer", payload: { content: "must not apply" } },
    });
    expect(stale.statusCode).toBe(409);
    expect(decodeAbi(ErrorEnvelopeSchema, stale.json()).error).toMatchObject({
      code: "task_run.attempt_mismatch",
      details: { expectedAttemptId: `${currentAttemptId}:stale`, currentAttemptId },
    });
    expect({
      run: store.getRun(runId), events: store.listEvents(runId),
      controls: store.listControlInbox(runId), operations: store.listOperations(runId),
    }).toEqual(before);

    const current = await app.inject({
      method: "POST",
      url: `/api/v1/task-runs/${runId}/commands`,
      payload: { commandId: "current-attempt-command", expectedAttemptId: currentAttemptId, type: "task_run.steer", payload: { content: "apply once" } },
    });
    expect(current.statusCode).toBe(200);
    expect(decodeAbi(CommandResponseSchema, current.json()).data.receipt.status).toBe("accepted");
  });

  it("returns a generic 500 envelope without leaking unexpected storage errors", async () => {
    const { app, store } = await fixture();
    store.db.exec(`
      CREATE TRIGGER reject_v1_session_insert
      BEFORE INSERT ON sessions
      BEGIN
        SELECT RAISE(ABORT, 'sensitive storage failure');
      END
    `);
    const response = await app.inject({ method: "POST", url: "/api/v1/sessions", headers: { "x-request-id": "unexpected-v1-error", "idempotency-key": "unexpected-v1-error" }, payload: { title: "fails" } });
    expect(response.statusCode).toBe(500);
    const envelope = decodeAbi(ErrorEnvelopeSchema, response.json());
    expect(envelope.error).toMatchObject({ code: "internal.error", message: "Internal server error", requestId: "unexpected-v1-error", retryable: true });
    expect(JSON.stringify(envelope)).not.toContain("sensitive storage failure");
  });

  it("persists command idempotency and maps resume and compact failures deterministically", async () => {
    const { app, store } = await fixture();
    const session = store.createSession();
    const started = await app.inject({
      method: "POST",
      url: `/api/v1/sessions/${session.id}/submissions`,
      headers: { "idempotency-key": "command-target" },
      payload: { content: "keep runtime active" },
    });
    const runId = decodeAbi(SubmissionResponseSchema, started.json()).data.receipt.taskRunId!;
    const steer = {
      commandId: "command-steer-1",
      expectedAttemptId: null,
      type: "task_run.steer",
      payload: { content: "new instruction" },
    } as const;
    const first = await app.inject({ method: "POST", url: `/api/v1/task-runs/${runId}/commands`, payload: steer });
    expect(decodeAbi(CommandResponseSchema, first.json()).data.receipt.status).toBe("accepted");
    const duplicate = await app.inject({ method: "POST", url: `/api/v1/task-runs/${runId}/commands`, payload: steer });
    const duplicateReceipt = decodeAbi(CommandResponseSchema, duplicate.json()).data.receipt;
    expect(duplicateReceipt).toMatchObject({ status: "duplicate", state: "succeeded", outcome: "accepted", replayed: true, result: { accepted: true } });
    const lookup = await app.inject({ method: "GET", url: `/api/v1/task-runs/${runId}/commands/${steer.commandId}` });
    expect(decodeAbi(CommandResponseSchema, lookup.json()).data.receipt).toEqual(duplicateReceipt);

    const resume = await app.inject({
      method: "POST",
      url: `/api/v1/task-runs/${runId}/commands`,
      payload: { commandId: "command-resume-1", expectedAttemptId: null, type: "task_run.resume", payload: {} },
    });
    expect(resume.statusCode).toBe(409);
    expect(decodeAbi(ErrorEnvelopeSchema, resume.json()).error.code).toBe("task_run.invalid_transition");

    const compact = await app.inject({
      method: "POST",
      url: `/api/v1/task-runs/${runId}/commands`,
      payload: { commandId: "command-compact-1", expectedAttemptId: null, type: "task_run.compact", payload: {} },
    });
    expect(compact.statusCode).toBe(503);
    expect(decodeAbi(ErrorEnvelopeSchema, compact.json()).error).toMatchObject({ code: "task_run.compaction_failed", retryable: true });
  });

  it("keeps channel, admin, and internal authentication surfaces distinct", async () => {
    const token = "v1-read-only-token-with-24-characters";
    const adminToken = "v1-admin-only-token-with-24-characters";
    const internalToken = "v1-internal-only-token-with-24-characters";
    const { app } = await fixture([
      { token, scopes: ["sessions:read"] },
      { token: adminToken, scopes: ["admin"] },
      { token: internalToken, scopes: ["internal"] },
    ]);
    const unauthenticated = await app.inject({ method: "POST", url: "/api/v1/sessions", payload: { title: "blocked" } });
    expect(unauthenticated.statusCode).toBe(401);
    expect(decodeAbi(ErrorEnvelopeSchema, unauthenticated.json()).error.code).toBe("auth.unauthenticated");

    const channel = await app.inject({ method: "POST", url: "/api/v1/sessions", headers: { authorization: `Bearer ${token}` }, payload: { title: "blocked" } });
    expect(channel.statusCode).toBe(403);
    expect(decodeAbi(ErrorEnvelopeSchema, channel.json()).error).toMatchObject({ code: "auth.permission_denied", details: { surface: "channel", requiredScope: "sessions:write" } });

    const admin = await app.inject({ method: "GET", url: "/api/v1/admin/missing", headers: { authorization: `Bearer ${token}` } });
    expect(admin.statusCode).toBe(403);
    expect(decodeAbi(ErrorEnvelopeSchema, admin.json()).error).toMatchObject({ code: "auth.permission_denied", details: { surface: "admin", requiredScope: "admin" } });

    const internal = await app.inject({ method: "GET", url: "/api/v1/internal/missing", headers: { authorization: `Bearer ${token}` } });
    expect(internal.statusCode).toBe(403);
    expect(decodeAbi(ErrorEnvelopeSchema, internal.json()).error).toMatchObject({ code: "auth.permission_denied", details: { surface: "internal", requiredScope: "internal" } });

    const adminOnInternal = await app.inject({ method: "GET", url: "/api/v1/internal/missing", headers: { authorization: `Bearer ${adminToken}` } });
    expect(adminOnInternal.statusCode).toBe(403);
    expect(decodeAbi(ErrorEnvelopeSchema, adminOnInternal.json()).error).toMatchObject({ code: "auth.permission_denied", details: { surface: "internal", requiredScope: "internal" } });

    const internalFallback = await app.inject({ method: "GET", url: "/api/v1/internal/missing", headers: { authorization: `Bearer ${internalToken}` } });
    expect(internalFallback.statusCode).toBe(404);
    expect(decodeAbi(ErrorEnvelopeSchema, internalFallback.json()).error).toMatchObject({ code: "route.not_found", details: { surface: "internal" } });

  });

  it("derives v1 admin Memory access from the authenticated principal", async () => {
    const token = "v1-admin-principal-token-with-24-characters";
    const recall = vi.fn(async () => ({
      cards: [
        {
          id: "memory-1",
          kind: "fact",
          title: "Allowed title",
          content: "Allowed content",
          score: 0.75,
          embedding: [0.1, 0.2],
          encryptionKey: "must-not-leak",
        },
        {
          id: "memory-2",
          kind: "backend-specific-kind",
          summary: "Mapped summary",
          score: 12,
          backendMetadata: { shard: "sensitive-shard" },
        },
      ],
      coldTopics: [{ id: "cold-topic-1", privateNotes: "must-not-leak" }],
      queryEmbedding: [0.3, 0.4],
    }));
    const unavailable = async () => undefined;
    const memory = {
      enqueueCapture: unavailable,
      status: unavailable,
      recall,
      getColdTopic: async () => null,
      upsert: unavailable,
      export: unavailable,
      forget: unavailable,
      restore: unavailable,
      readiness: async () => ({ ready: true, degraded: false, reasons: [] }),
    } as NonNullable<Parameters<typeof createApp>[0]["memory"]>;
    const { app } = await fixture([{
      token,
      scopes: ["admin"],
      principal: {
        subjectId: "service:gateway-a",
        resourceScopes: [{ type: "workspace", id: "workspace-authorized" }],
      },
    }], 32, { memory });

    const callerScoped = await app.inject({
      method: "POST",
      url: "/api/v1/admin/memory/recall",
      headers: { authorization: `Bearer ${token}` },
      payload: { cue: "find facts", scopes: [{ type: "workspace", id: "workspace-forged" }] },
    });
    expect(callerScoped.statusCode).toBe(400);
    expect(decodeAbi(ErrorEnvelopeSchema, callerScoped.json()).error.code).toBe("request.validation_failed");
    expect(recall).not.toHaveBeenCalled();

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/admin/memory/recall",
      headers: {
        authorization: `Bearer ${token}`,
        "x-tagent-subject": "caller-spoofed-subject",
      },
      payload: { cue: "find facts" },
    });
    expect(response.statusCode).toBe(200);
    expect(decodeAbi(MemoryRecallResponseSchema, response.json()).data.result).toEqual({
      items: [
        { id: "memory-1", kind: "fact", title: "Allowed title", content: "Allowed content", score: 0.75 },
        { id: "memory-2", kind: "fact", title: "", content: "Mapped summary", score: 1 },
      ],
      total: 2,
      coldTopicCount: 1,
    });
    expect(JSON.stringify(response.json())).not.toMatch(/embedding|encryptionKey|backendMetadata|privateNotes|sensitive-shard/);
    expect(recall).toHaveBeenCalledWith(expect.objectContaining({
      access: {
        subjectId: "service:gateway-a",
        scopes: [{ type: "workspace", id: "workspace-authorized" }],
        purpose: "memory_admin",
      },
      cue: "find facts",
    }));
  });

  it("closes malformed replay and live v1 SSE streams without leaking errors", async () => {
    const { app, service, store } = await fixture();
    const replayRun = store.createRun(store.createSession().id, "malformed replay event");
    const liveRun = store.createRun(store.createSession().id, "malformed live event");
    store.appendEvent(replayRun.id, "run.completed", { response: "replay" });
    store.appendEvent(liveRun.id, "run.completed", { response: "live" });
    const replayEvent = service.replay(replayRun.id, 0)[0]!;
    const liveEvent = service.replay(liveRun.id, 0)[0]!;
    const replayClaim = decodeAbi(EventConsumerClaimResponseSchema, (await app.inject({
      method: "POST",
      url: `/api/v1/task-runs/${replayRun.id}/event-consumers/replay-client/claim`,
    })).json()).data.cursor;
    const liveClaim = decodeAbi(EventConsumerClaimResponseSchema, (await app.inject({
      method: "POST",
      url: `/api/v1/task-runs/${liveRun.id}/event-consumers/live-client/claim`,
    })).json()).data.cursor;
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);

    try {
      const replayUnsubscribe = vi.fn();
      const replaySpy = vi.spyOn(service, "replay").mockReturnValue([{ ...replayEvent, createdAt: Number.NaN }]);
      const replaySubscribeSpy = vi.spyOn(service, "subscribe").mockReturnValue(replayUnsubscribe);
      const replayResponse = await fetch(`${address}/api/v1/task-runs/${replayRun.id}/events?consumerId=replay-client&generation=${replayClaim.generation}&after=0`);
      expect(replayResponse.status).toBe(200);
      expect(await replayResponse.text()).toBe("");
      expect(replayUnsubscribe).toHaveBeenCalledOnce();
      replaySpy.mockRestore();
      replaySubscribeSpy.mockRestore();

      const liveUnsubscribe = vi.fn();
      vi.spyOn(service, "replay").mockReturnValue([]);
      vi.spyOn(service, "subscribe").mockImplementation((_taskRunId, listener) => {
        listener({ ...liveEvent, createdAt: Number.NaN } as never);
        return liveUnsubscribe;
      });
      const liveResponse = await fetch(`${address}/api/v1/task-runs/${liveRun.id}/events?consumerId=live-client&generation=${liveClaim.generation}&after=0`);
      expect(liveResponse.status).toBe(200);
      expect(await liveResponse.text()).toBe("");
      expect(liveUnsubscribe).toHaveBeenCalledOnce();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      vi.restoreAllMocks();
    }
  });

});
