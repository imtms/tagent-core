import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, drainTranscriptView, subscribe } from "../apps/web-console/src/api.js";
import { normalizeCoreOrigin } from "../apps/web-console/src/api-transport.js";
import { CoreClientError } from "@tagent/core-client";

afterEach(() => vi.unstubAllGlobals());

const success = (data: unknown) => ({ data, requestId: "web-test-request" });

function channelRun(id = "run", attempt = 1) {
  return {
    id, sessionId: "session", submissionId: "request", status: "running", phase: "implement", goal: "test",
    modelId: "gpt-5.6-sol", reasoningEffort: "high", contract: null,
    blockedReason: "", lastEventSequence: 0, attempt,
    currentAttempt: { id: `attempt:${id}:${attempt}`, ordinal: attempt, status: "running", active: true },
    resumedAt: null, createdAt: "1970-01-01T00:00:00.001Z", updatedAt: "1970-01-01T00:00:00.001Z", completedAt: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    transcriptCount: 0, checkpoint: null, continuations: [], plan: [], checks: [],
    artifacts: [], completionGate: { passed: false, failures: [] }, launchRetryable: false, resumable: false,
    supervision: {}, pendingInteractions: { approvals: [], userInputs: [] },
  };
}

function consoleRunSummary(id = "run") {
  return {
    id, goal: "test", status: "running", phase: "implement",
    attempt: 1, createdAt: 1, updatedAt: 2,
  };
}

function operatorInboxItem(id = "item") {
  return {
    id, sessionId: "session", content: "queued", status: "queued", decision: "pending", runId: null,
    position: 0, summary: "queued", intent: "new_task", targetRunId: null, priority: 0,
    urgency: "normal", relation: "independent", acceptanceCriteria: [], confidence: 1,
    reason: "Classified by Core", gateProfile: "strict", revision: 1,
    createdAt: "1970-01-01T00:00:00.001Z", updatedAt: "1970-01-01T00:00:00.001Z",
  };
}

function profileOperation(endpointId: "operator.session_inbox.start" | "operator.session_inbox.retry_launch", taskRunId = "run") {
  return {
    operation: {
      requestId: "web-operation", profileId: "operator.session-inbox.v1", endpointId,
      status: "succeeded", resource: { type: "session_inbox_item", id: "item" },
      result: { taskRunId }, error: null, createdAt: "2026-08-15T00:00:00.000Z",
      updatedAt: "2026-08-15T00:00:00.000Z", completedAt: "2026-08-15T00:00:00.000Z",
    },
  };
}

describe("Web API request headers", () => {
  it("accepts only a credential-free HTTP(S) origin", () => {
    expect(normalizeCoreOrigin("https://core.example.test")).toBe("https://core.example.test");
    expect(normalizeCoreOrigin("http://127.0.0.1:3100/")).toBe("http://127.0.0.1:3100");
    for (const value of [
      "javascript:alert(1)",
      "file:///tmp/core",
      "ftp://core.example.test/",
      "https://user:password@core.example.test/",
      "https://core.example.test/api",
      "https://core.example.test/?tenant=a",
      "https://core.example.test/#fragment",
    ]) {
      expect(() => normalizeCoreOrigin(value)).toThrow("must be an http(s) origin without credentials, path, query, or fragment");
    }
  });

  it("sources versioned Console wire DTOs from the ABI", async () => {
    const source = await readFile(new URL("../apps/web-console/src/api.ts", import.meta.url), "utf8");
    const types = await readFile(new URL("../apps/web-console/src/api-types.ts", import.meta.url), "utf8");
    expect(types).toContain('type { ConsoleV1 }');
    expect(source).toContain('import { ConsoleDecode } from "@tagent/core-client"');
    expect(source).not.toMatch(/export interface (?:TaskRun|LearningFeatureState|MemoryRecord)\b/);
  });

  it("does not send JSON content type for bodyless consumer claims", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(success({ cursor: {
      taskRunId: "run",
      consumerId: "web",
      generation: 1,
      acknowledgedSequence: 0,
      settledAcknowledgedSequence: null,
      finalAcknowledgedSequence: null,
      claimedAt: "2026-08-05T00:00:00.000Z",
      updatedAt: "2026-08-05T00:00:00.000Z",
    } })), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api.claimConsumer("run", "web");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).has("Content-Type")).toBe(false);
  });

  it("adds JSON content type when a request has a body", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(success({ ok: true })), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api.ackConsumer("run", "web", 1, 1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  it("uploads a Skill file as bounded base64", async () => {
    const revision = {
      id: "revision", skillId: "skill", revision: 1, name: "release-check", description: "Verify a release",
      content: "Follow the release checklist.", sha256: "a".repeat(64), disableModelInvocation: false,
      createdAt: "2026-08-15T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(success({ skill: revision, resourceRevision: 1, catalogRevision: 2 })), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const file = new File(["skill body"], "SKILL.md", { type: "text/markdown" });
    await expect(api.uploadSkill(file)).resolves.toEqual(revision);
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/operator/skills", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ filename: "SKILL.md", contentBase64: Buffer.from("skill body").toString("base64") }),
    }));
  });

  it("decodes lightweight Run summaries and requests only incremental transcript rows", async () => {
    const operatorSummary = {
      id: "run", sessionId: "session", status: "running", phase: "implement", attempt: 1,
      currentAttemptId: "attempt", goalSummary: "test", blockedReason: null, pendingInteractionKinds: [],
      lastEventSequence: 0, createdAt: "1970-01-01T00:00:00.001Z", updatedAt: "1970-01-01T00:00:00.002Z",
      completedAt: null, resumable: false,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(success({ items: [operatorSummary], pageInfo: { nextCursor: null, hasMore: false, limit: 50, snapshot: "snapshot" } })), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(success({ items: [], pageInfo: { nextCursor: null, hasMore: false, limit: 200 } })), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.runs("session")).resolves.toEqual([consoleRunSummary()]);
    await expect(api.transcriptView("run", 41)).resolves.toEqual({
      items: [], pageInfo: { nextCursor: null, hasMore: false, limit: 200 },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/operator/sessions/session/task-runs?limit=50", expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/task-runs/run/transcript?limit=200&after=41", expect.any(Object));
  });

  it("drains every Transcript page before advancing the consumed cursor", async () => {
    const item = (sequence: number) => ({
      sequence, attempt: 1, occurredAt: "2026-08-16T00:00:00.000Z" as const,
      kind: "user" as const, text: `message ${sequence}`,
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(success({
        items: Array.from({ length: 200 }, (_, index) => item(index + 1)),
        pageInfo: { nextCursor: 200, hasMore: true, limit: 200 },
      })), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(success({
        items: [item(201)], pageInfo: { nextCursor: null, hasMore: false, limit: 200 },
      })), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const transcript = await drainTranscriptView("run", 201);

    expect(transcript.after).toBe(201);
    expect(transcript.items.map((entry) => entry.seq)).toEqual(Array.from({ length: 201 }, (_, index) => index + 1));
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/task-runs/run/transcript?limit=200&after=0", expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/task-runs/run/transcript?limit=200&after=200", expect.any(Object));
  });

  it("consumes a later tool-result projection at its change sequence", async () => {
    const completed = { sequence: 2, attempt: 1, occurredAt: "2026-08-16T00:00:01.000Z", kind: "tool", toolCallId: "split", toolName: "read", arguments: {}, result: "done", isError: false, status: "completed" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(success({ items: [], pageInfo: { nextCursor: 1, hasMore: true, limit: 1 } })), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(success({ items: [completed], pageInfo: { nextCursor: null, hasMore: false, limit: 1 } })), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(drainTranscriptView("run", 2, 0, 1)).resolves.toMatchObject({
      after: 2,
      items: [
        expect.objectContaining({ seq: 2, toolCallId: "split", status: "completed" }),
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("renames a workspace through the Session API", async () => {
    const settings = { sessionId: "session", title: "Before", modelId: "gpt-5.6-sol", reasoningEffort: "high", revision: 1, updatedAt: "2026-08-15T00:00:00.000Z" };
    const current = { id: "session", title: "After", modelId: "gpt-5.6-sol", reasoningEffort: "high", createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:01:00.000Z", latestTaskRunStatus: null, latestTaskRunPhase: null };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(success({ settings })), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(success({ settings: { ...settings, title: "After", revision: 2 } })), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(success(current)), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.renameSession("session", "After")).resolves.toMatchObject({ title: "After", updatedAt: Date.parse(current.updatedAt) });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/operator/sessions/session/settings", expect.any(Object));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/operator/sessions/session/settings", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ title: "After" }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/v1/sessions/session", expect.any(Object));
  });

  it("uses a caller-stable request ID when creating the initial workspace", async () => {
    const session = { id: "session", title: "First workspace", modelId: "gpt-5.6-sol", reasoningEffort: "high", createdAt: "2026-08-15T00:00:00.000Z", updatedAt: "2026-08-15T00:00:00.000Z", latestTaskRunStatus: null, latestTaskRunPhase: null };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(success(session)), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api.createSession("First workspace", "initial-workspace-request");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/sessions", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ title: "First workspace", origin: { surface: "web", gatewayActorId: "local-web", sourceId: "web-console" } }),
    }));
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("Idempotency-Key")).toBe("initial-workspace-request");
  });

  it("updates and reorders queued prompts through the Session API", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(success({ item: operatorInboxItem(), collectionRevision: 2 })), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(success({ ok: true, items: [operatorInboxItem("second"), operatorInboxItem("first")], collectionRevision: 3 })), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api.updateInbox("session", "item", "changed");
    await api.reorderInbox("session", ["second", "first"]);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/operator/sessions/session/inbox/item", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ content: "changed" }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/operator/sessions/session/inbox/order", expect.objectContaining({ method: "PUT", body: JSON.stringify({ itemIds: ["second", "first"] }) }));
  });



  it("posts the selected queued item to the manual start endpoint", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(success(profileOperation("operator.session_inbox.start"))), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(success(channelRun())), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api.startInbox("session", "item");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/operator/sessions/session/inbox/item/start", expect.objectContaining({ method: "POST" }));
  });

  it("surfaces manual start conflicts as typed CoreClient errors", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "session.running_taskrun", message: "session already has a running TaskRun", requestId: "web-test-request", retryable: false, details: {} } }), { status: 409, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const request = api.startInbox("session", "item");
    await expect(request).rejects.toBeInstanceOf(CoreClientError);
    await expect(request).rejects.toThrow("session already has a running TaskRun");
  });

  it("calls retry-launch and returns the relaunched TaskRun", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(success(channelRun())), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(success(profileOperation("operator.session_inbox.retry_launch"))), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(success(channelRun("run", 2))), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const relaunched = await api.retryLaunch("run");
    expect(relaunched).toMatchObject({ status: "started", run: { id: "run", attempt: 2, status: "running" } });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/operator/task-runs/run/retry-launch", expect.objectContaining({ method: "POST" }));
  });


  it("rejects malformed typed payloads before returning them to Web callers", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{
      id: "session",
      title: "Broken",
      createdAt: "not-a-timestamp",
      updatedAt: 1,
      latestRunStatus: null,
      latestRunPhase: null,
    }]), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(api.sessions()).rejects.toMatchObject({ category: "protocol", code: "client.protocol_mismatch" });
  });

  it("does not let typed Web requests accept an unchecked 204 response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));

    await expect(api.sessions()).rejects.toMatchObject({ category: "protocol", code: "client.protocol_mismatch" });
  });

  it("rejects malformed versioned SSE events before invoking the event callback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('data: {"runId":"run","seq":"bad"}\n\n', {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })));
    const onEvent = vi.fn();
    const onError = vi.fn();

    subscribe("run", "web", 1, 0, onEvent, onError);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(onEvent).not.toHaveBeenCalled();
  });
});
