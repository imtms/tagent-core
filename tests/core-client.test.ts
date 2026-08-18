import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConsoleDecode,
  createCoreClient,
  createReplayAckCoordinator,
  decodeJsonSse,
  type CoreFetch,
} from "@tagent/core-client";
import {
  MEMORY_SOURCE_TYPES,
  capabilityProfileDetailFixtures,
  capabilityProfileRegistryFixture,
  operatorReadCapabilitiesFixture,
  operatorSessionListFixture,
  operatorTaskRunListFixture,
  operatorSessionSettingsFixture,
  operatorInboxListFixture,
  operatorContextManifestListFixture,
  operatorSkillCatalogFixture,
  adminMemoryStatusFixture,
  submissionIdempotencyFixtures,
  taskRunEventFixture,
  unknownTaskRunEventFixture,
} from "@tagent/abi";

afterEach(() => vi.restoreAllMocks());

describe("console v1 response decoders", () => {
  it("accepts capture jobs carrying every legal Memory provenance source", async () => {
    const jobs = MEMORY_SOURCE_TYPES.map((sourceType, index) => ({
      id: `capture-job-${index}`,
      status: "completed",
      attempts: 1,
      proposalCount: 1,
      persistedCount: 1,
      createdAt: 1_788_000_000_000 + index,
      updatedAt: 1_788_000_001_000 + index,
      request: {
        sourceRefs: [{ sourceType, sourceId: `${sourceType}:fixture`, revision: "1" }],
      },
    }));

    await expect(ConsoleDecode.captureJobs(jobs)).resolves.toEqual(jobs);
  });
});

describe("core-client transport", () => {
  it("supports default and per-request timeouts without discarding caller AbortSignals", async () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn<CoreFetch>(async (_url, init) => {
      signals.push(init?.signal as AbortSignal);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    });
    const client = createCoreClient({ fetch: fetchMock, timeoutMs: 20 });
    await expect(client.request("/api/v1/slow")).rejects.toMatchObject({ code: "client.network_error" });
    expect(signals[0].aborted).toBe(true);

    const controller = new AbortController();
    const pending = client.request("/api/v1/abort", { signal: controller.signal, timeoutMs: 10_000 });
    controller.abort(new Error("caller stopped"));
    await expect(pending).rejects.toMatchObject({ code: "client.network_error" });
    expect(signals[1].aborted).toBe(true);
  });

  it("adds Bearer, request, and idempotency headers without mutating the v1 body", async () => {
    const fetchMock = vi.fn<CoreFetch>(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const client = createCoreClient({ bearerToken: "service-token", fetch: fetchMock, requestIdFactory: () => "generated-request" });

    await client.request("/api/v1/sessions/session/submissions", {
      idempotencyKey: "submission-1",
      json: { content: "hello" },
      method: "POST",
    });

    const [url, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(url).toBe("/api/v1/sessions/session/submissions");
    expect(headers.get("Authorization")).toBe("Bearer service-token");
    expect(headers.get("Idempotency-Key")).toBe("submission-1");
    expect(headers.get("X-Request-Id")).toBe("generated-request");
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ content: "hello" });
  });

  it("rejects invalid idempotency keys before issuing a request", async () => {
    const fetchMock = vi.fn<CoreFetch>();
    const client = createCoreClient({ fetch: fetchMock });

    await expect(client.request("/api/v1/sessions", { idempotencyKey: "not allowed", method: "POST" }))
      .rejects.toMatchObject({ code: "client.protocol_mismatch", retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes v1 failures into stable CoreClientError values", async () => {
    const v1 = createCoreClient({ fetch: async () => new Response(JSON.stringify({
      error: {
        code: "submission.idempotency_conflict",
        message: "payload changed",
        requestId: "request-1",
        retryable: false,
        details: { submissionId: "submission-1" },
      },
    }), { status: 409, headers: { "Content-Type": "application/json" } }) });

    await expect(v1.request("/api/v1/submissions", { method: "POST" })).rejects.toEqual(expect.objectContaining({
      category: "conflict",
      code: "submission.idempotency_conflict",
      details: { submissionId: "submission-1" },
      message: "payload changed",
      requestId: "request-1",
      retryable: false,
      status: 409,
    }));
  });

  it("rejects forbidden fields in v1 error envelopes", async () => {
    const client = createCoreClient({ fetch: async () => new Response(JSON.stringify({
      error: {
        category: "conflict",
        code: "submission.idempotency_conflict",
        details: {},
        message: "payload changed",
        requestId: "request-1",
        retryable: false,
      },
    }), { status: 409, headers: { "Content-Type": "application/json" } }) });

    await expect(client.request("/api/v1/submissions", { method: "POST" })).rejects.toMatchObject({
      category: "protocol",
      code: "client.protocol_mismatch",
      message: expect.stringContaining("error envelope validation failed"),
    });
  });

  it("passes 204 responses through typed decoders while preserving untyped undefined", async () => {
    const fetchMock = vi.fn<CoreFetch>(async () => new Response(null, { status: 204 }));
    const client = createCoreClient({ fetch: fetchMock });
    const decode = vi.fn((_payload: unknown): string => { throw new TypeError("expected a JSON value"); });

    await expect(client.request("/api/v1/empty", { decode })).rejects.toMatchObject({
      category: "protocol",
      code: "client.protocol_mismatch",
      message: expect.stringContaining("expected a JSON value"),
    });
    expect(decode).toHaveBeenCalledWith(undefined);
    await expect(client.request("/api/v1/empty")).resolves.toBeUndefined();
  });

  it("retries only requests with safe or idempotent semantics", async () => {
    const idempotentFetch = vi.fn<CoreFetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "core.busy", details: {}, message: "busy", requestId: "retry-1", retryable: true } }), { status: 503, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const unsafeFetch = vi.fn<CoreFetch>(async () => new Response(JSON.stringify({ error: { code: "core.busy", details: {}, message: "busy", requestId: "retry-2", retryable: true } }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    }));

    await createCoreClient({ fetch: idempotentFetch, retry: { baseDelayMs: 0, maxAttempts: 2 } })
      .request("/api/v1/sessions", { idempotencyKey: "session-1", method: "POST" });
    await expect(createCoreClient({ fetch: unsafeFetch, retry: { baseDelayMs: 0, maxAttempts: 2 } })
      .request("/api/v1/actions", { method: "POST" })).rejects.toMatchObject({ status: 503 });

    expect(idempotentFetch).toHaveBeenCalledTimes(2);
    expect(unsafeFetch).toHaveBeenCalledTimes(1);
  });

  it("streams JSON SSE over authenticated fetch and ignores heartbeat comments", async () => {
    const fetchMock = vi.fn<CoreFetch>(async () => new Response([
      ": heartbeat",
      "",
      "id: 41",
      "event: task_run.updated",
      "data: {\"sequence\":41,",
      "data: \"type\":\"task_run.updated\"}",
      "",
    ].join("\n"), { status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" } }));
    const client = createCoreClient({ baseUrl: "https://core.example/", bearerToken: "events-token", fetch: fetchMock });
    const events: Array<{ sequence: number; type: string }> = [];
    const subscription = client.subscribeSse("/api/v1/task-runs/run/events", {
      decode: decodeJsonSse<{ sequence: number; type: string }>((payload) => payload as { sequence: number; type: string }),
      onMessage: (event) => { events.push(event); },
    });

    await subscription.completed;

    expect(events).toEqual([{ sequence: 41, type: "task_run.updated" }]);
    const [url, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(url).toBe("https://core.example/api/v1/task-runs/run/events");
    expect(headers.get("Accept")).toBe("text/event-stream");
    expect(headers.get("Authorization")).toBe("Bearer events-token");
  });
});

describe("channel v1 helpers", () => {
  it("decodes Skills and Admin profile fixtures and sends recovery headers", async () => {
    const operation = {
      data: { operation: {
        requestId: "capture-key", profileId: "admin.memory.v1", endpointId: "admin.memory.capture",
        status: "succeeded", resource: { type: "memory_scope", id: "workspace:workspace-1" },
        result: { jobId: "job-1" }, error: null,
        createdAt: "2026-08-14T12:00:00.000Z", updatedAt: "2026-08-14T12:00:01.000Z",
        completedAt: "2026-08-14T12:00:01.000Z",
      } },
      requestId: "capture-response",
    };
    const fetchMock = vi.fn<CoreFetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(operatorSkillCatalogFixture), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(adminMemoryStatusFixture), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(operation), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createCoreClient({ baseUrl: "https://core.example", fetch: fetchMock });
    await expect(client.listOperatorSkills({ limit: 25 })).resolves.toEqual(operatorSkillCatalogFixture);
    await expect(client.getAdminMemoryStatus()).resolves.toEqual(adminMemoryStatusFixture);
    await expect(client.captureAdminMemory(
      { scope: { type: "workspace", id: "workspace-1" }, content: "Remember this" }, "capture-key",
    )).resolves.toEqual(operation);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://core.example/api/v1/operator/skills?limit=25",
      "https://core.example/api/v1/admin/profiles/memory/status",
      "https://core.example/api/v1/admin/profiles/memory/captures",
    ]);
    expect(new Headers(fetchMock.mock.calls[2][1]?.headers).get("Idempotency-Key")).toBe("capture-key");
  });

  it("uses opaque pagination and conditional Inbox mutation headers", async () => {
    const decision = {
      data: { item: operatorInboxListFixture.data.items[0], collectionRevision: 2 },
      requestId: "inbox-decision-response",
    };
    const fetchMock = vi.fn<CoreFetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(operatorInboxListFixture), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(decision), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(operatorContextManifestListFixture), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createCoreClient({ baseUrl: "https://core.example", fetch: fetchMock });
    await expect(client.listOperatorInbox("session/id", { cursor: "opaque cursor", limit: 20 }))
      .resolves.toEqual(operatorInboxListFixture);
    await expect(client.decideOperatorInboxItem("session/id", "item/id", 1, "decision-key", { decision: "defer" }))
      .resolves.toEqual(decision);
    await expect(client.listOperatorContextManifests("run/id", { limit: 10 }))
      .resolves.toEqual(operatorContextManifestListFixture);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://core.example/api/v1/operator/sessions/session%2Fid/inbox?cursor=opaque+cursor&limit=20",
      "https://core.example/api/v1/operator/sessions/session%2Fid/inbox/item%2Fid/decision",
      "https://core.example/api/v1/operator/task-runs/run%2Fid/context-manifests?limit=10",
    ]);
    const mutationHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(mutationHeaders.get("If-Match")).toBe('"r1"');
    expect(mutationHeaders.get("Idempotency-Key")).toBe("decision-key");
  });

  it("sends Session Settings revision and idempotency headers and retains response requestId", async () => {
    const fetchMock = vi.fn<CoreFetch>(async () => new Response(JSON.stringify(operatorSessionSettingsFixture), {
      status: 200,
      headers: { "Content-Type": "application/json", ETag: '"r3"' },
    }));
    const client = createCoreClient({ baseUrl: "https://core.example", fetch: fetchMock });
    await expect(client.updateOperatorSessionSettings(
      "session/id", 2, "settings-key-1", { title: "Gateway workspace" }, { requestId: "client-settings-request" },
    )).resolves.toEqual(operatorSessionSettingsFixture);
    const [url, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(url).toBe("https://core.example/api/v1/operator/sessions/session%2Fid/settings");
    expect(headers.get("If-Match")).toBe('"r2"');
    expect(headers.get("Idempotency-Key")).toBe("settings-key-1");
    expect(headers.get("X-Request-Id")).toBe("client-settings-request");
  });

  it("returns profile registry envelopes so Gateway retains Core requestIds", async () => {
    const detail = capabilityProfileDetailFixtures[0];
    const fetchMock = vi.fn<CoreFetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(capabilityProfileRegistryFixture), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createCoreClient({ baseUrl: "https://core.example", fetch: fetchMock });

    await expect(client.listCapabilityProfiles()).resolves.toEqual(capabilityProfileRegistryFixture);
    await expect(client.getCapabilityProfile(detail.data.profile.id)).resolves.toEqual(detail);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://core.example/api/v1/capability-profiles",
      `https://core.example/api/v1/capability-profiles/${detail.data.profile.id}`,
    ]);
  });

  it("decodes Operator Read capabilities and sends bounded opaque pagination cursors", async () => {
    const latest = { data: operatorTaskRunListFixture.data.items[0], requestId: "latest" };
    const fetchMock = vi.fn<CoreFetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(operatorReadCapabilitiesFixture), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(operatorSessionListFixture), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(operatorTaskRunListFixture), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(latest), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createCoreClient({ baseUrl: "https://core.example", fetch: fetchMock });

    await expect(client.getOperatorReadCapabilities()).resolves.toEqual(operatorReadCapabilitiesFixture.data);
    await expect(client.listOperatorSessions({ cursor: "opaque cursor", limit: 25 })).resolves.toEqual(operatorSessionListFixture);
    await expect(client.listSessionTaskRuns("session/id", { cursor: "run cursor", limit: 20 })).resolves.toEqual(operatorTaskRunListFixture);
    await expect(client.getLatestSessionTaskRun("session/id")).resolves.toEqual(latest.data);

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://core.example/api/v1/operator/capabilities",
      "https://core.example/api/v1/operator/sessions?cursor=opaque+cursor&limit=25",
      "https://core.example/api/v1/operator/sessions/session%2Fid/task-runs?cursor=run+cursor&limit=20",
      "https://core.example/api/v1/operator/sessions/session%2Fid/task-runs/latest",
    ]);
  });

  it("rejects invalid Operator Read pagination before issuing a request", async () => {
    const fetchMock = vi.fn<CoreFetch>();
    const client = createCoreClient({ fetch: fetchMock });

    await expect(client.listOperatorSessions({ limit: 201 })).rejects.toMatchObject({
      code: "client.protocol_mismatch",
      retryable: false,
    });
    await expect(client.listSessionTaskRuns("session-1", { cursor: "" })).rejects.toMatchObject({
      code: "client.protocol_mismatch",
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends explicit Session idempotency and decodes capabilities", async () => {
    const session = { id: "session-1", title: "Gateway", modelId: "gpt-5.6-sol", reasoningEffort: "high", createdAt: "2026-08-04T12:34:56.789Z", updatedAt: "2026-08-04T12:34:56.789Z", latestTaskRunStatus: null, latestTaskRunPhase: null };
    const capabilities = {
      releaseVersion: "0.8.8", apiVersions: ["channel.v1"], eventSpecVersion: "1.0", persistenceSchemaVersion: 2,
      commandTypes: ["task_run.steer"], eventTypes: ["task_run.started"],
      interactions: { approvalResolution: true, userInputSubmission: true },
      operator: { profileVersion: "1.0", endpointIds: ["channel.capabilities.get"], workspaceGoals: true, roadmapGenerationIdempotent: true },
      approval: { ready: true },
      receiptRecovery: { protocolVersion: "1.0", exactReplay: true, commandLookup: true, interruptedEffectState: "outcome_unknown", automaticUnknownReplay: false },
      retention: { automaticDeletion: false, cursorExpiry: false },
      limits: { transcriptPageMax: 500, eventReplayBatch: 256, eventLiveBuffer: 1000, artifactPreviewBytes: 5242880, artifactDownloadBytes: 52428800, artifactListPageMax: 200, interactionPageMax: 200 },
    };
    const fetchMock = vi.fn<CoreFetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: session, requestId: "create-session" }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: capabilities, requestId: "capabilities" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createCoreClient({ fetch: fetchMock });
    await expect(client.createSessionIdempotent("session-create-key", { title: "Gateway" })).resolves.toEqual(session);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Idempotency-Key")).toBe("session-create-key");
    await expect(client.getCapabilities()).resolves.toEqual(capabilities);
  });

  it("validates submission fixtures and maps the idempotency contract", async () => {
    const fetchMock = vi.fn<CoreFetch>(async () => new Response(JSON.stringify(submissionIdempotencyFixtures.originalResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const client = createCoreClient({ baseUrl: "https://core.example", fetch: fetchMock });

    await expect(client.submit(
      "session/fixture",
      submissionIdempotencyFixtures.headers["idempotency-key"],
      submissionIdempotencyFixtures.originalPayload,
    )).resolves.toEqual(submissionIdempotencyFixtures.originalResponse.data.receipt);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://core.example/api/v1/sessions/session%2Ffixture/submissions");
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("submission.fixture-001");
    expect(JSON.parse(String(init?.body))).toEqual(submissionIdempotencyFixtures.originalPayload);
  });

  it("validates task-run responses instead of trusting the JSON shape", async () => {
    const client = createCoreClient({ fetch: async () => new Response(JSON.stringify({
      data: { id: "task-run-with-missing-fields" },
      requestId: "request-1",
    }), { status: 200, headers: { "Content-Type": "application/json" } }) });

    await expect(client.getTaskRun("task-run-1")).rejects.toMatchObject({
      code: "client.protocol_mismatch",
      message: expect.stringContaining("response validation failed"),
      retryable: false,
    });
  });

  it("claims and acknowledges consumers with ABI-validated cursors", async () => {
    const cursor = {
      taskRunId: "task-run-1",
      consumerId: "gateway/main",
      generation: 2,
      acknowledgedSequence: 7,
      settledAcknowledgedSequence: null,
      finalAcknowledgedSequence: null,
      claimedAt: "2026-08-04T12:34:56.789Z",
      updatedAt: "2026-08-04T12:34:56.789Z",
    };
    const fetchMock = vi.fn<CoreFetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { cursor }, requestId: "claim-request" }), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { status: "accepted", cursor: { ...cursor, acknowledgedSequence: 8 } }, requestId: "ack-request" }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const client = createCoreClient({ fetch: fetchMock });

    await expect(client.claimEventConsumer("task-run-1", "gateway/main")).resolves.toEqual(cursor);
    await expect(client.ackEventConsumer("task-run-1", "gateway/main", { generation: 2, sequence: 8 }))
      .resolves.toMatchObject({ acknowledgedSequence: 8 });

    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/task-runs/task-run-1/event-consumers/gateway%2Fmain/claim");
    expect(fetchMock.mock.calls[0][1]?.body).toBeUndefined();
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has("Content-Type")).toBe(false);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/v1/task-runs/task-run-1/event-consumers/gateway%2Fmain/ack");
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ generation: 2, sequence: 8 });
  });

  it("decodes TaskRunEvent fixtures through the typed SSE helper", async () => {
    const fetchMock = vi.fn<CoreFetch>(async () => new Response([
      `data: ${JSON.stringify(taskRunEventFixture)}`,
      "",
      `data: ${JSON.stringify(unknownTaskRunEventFixture)}`,
      "",
    ].join("\n"), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
    const events: unknown[] = [];
    const subscription = createCoreClient({ fetch: fetchMock }).subscribeTaskRunEvents("task-run-1", {
      after: 41,
      consumerId: "gateway",
      generation: 3,
      onMessage: (event) => { events.push(event); },
    });

    await subscription.completed;

    expect(events).toEqual([taskRunEventFixture, unknownTaskRunEventFixture]);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/task-runs/task-run-1/events?consumerId=gateway&generation=3&after=41");
  });

  it("rejects invalid event stream cursors before starting a subscription", () => {
    const fetchMock = vi.fn<CoreFetch>();
    const client = createCoreClient({ fetch: fetchMock });

    expect(() => client.subscribeTaskRunEvents("task-run-1", {
      consumerId: "gateway",
      generation: 0,
      onMessage: () => undefined,
    })).toThrow(expect.objectContaining({ code: "client.protocol_mismatch" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("replay ACK coordination", () => {
  it("persists each new event before ACK and ignores an already acknowledged replay", async () => {
    const calls: string[] = [];
    const coordinator = createReplayAckCoordinator<{ seq: number }>({
      ack: async (sequence) => { calls.push(`ack:${sequence}`); },
      initialAcknowledgedSequence: 3,
      persist: async (event) => { calls.push(`persist:${event.seq}`); },
      sequence: (event) => event.seq,
    });

    await expect(coordinator.handle({ seq: 3 })).resolves.toBe("duplicate");
    await expect(coordinator.handle({ seq: 4 })).resolves.toBe("acknowledged");
    expect(calls).toEqual(["persist:4", "ack:4"]);
    expect(coordinator.getAcknowledgedSequence()).toBe(4);
  });

  it("does not ACK or advance when durable persistence fails", async () => {
    const ack = vi.fn(async () => undefined);
    const coordinator = createReplayAckCoordinator<{ seq: number }>({
      ack,
      persist: async () => { throw new Error("outbox unavailable"); },
      sequence: (event) => event.seq,
    });

    await expect(coordinator.handle({ seq: 1 })).rejects.toThrow("outbox unavailable");
    expect(ack).not.toHaveBeenCalled();
    expect(coordinator.getAcknowledgedSequence()).toBe(0);
    await coordinator.idle();
  });
});
