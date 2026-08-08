import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, subscribe } from "../apps/web-console/src/api.js";
import { CoreClientError } from "@tagent/core-client";

afterEach(() => vi.unstubAllGlobals());

const success = (data: unknown) => ({ data, requestId: "web-test-request" });

function consoleRun(id = "run", attempt = 1) {
  return {
    id, sessionId: "session", requestId: "request", status: "running", phase: "implement", goal: "test",
    modelId: "gpt-5.6-sol", reasoningEffort: "high", contract: null,
    blockedReason: "", lastEventSeq: 0, attempt, resumedAt: null, createdAt: 1, updatedAt: 1, completedAt: null,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    transcriptCount: 0, checkpoint: null, continuations: [], plan: [], checks: [], userInputRequests: [], pendingUserInput: null,
    artifacts: [], completionGate: { passed: false, failures: [] }, launchRetryable: false, resumable: false,
    supervision: { latestDecision: null, latestGates: [], progress: null, approvalRequests: [], latestContextManifest: null },
  };
}

function consoleInboxItem(id = "item") {
  return {
    id, sessionId: "session", requestId: "request", content: "queued", status: "queued", decision: "pending", runId: null,
    error: "", position: 0, createdAt: 1, updatedAt: 1, claimedAt: null, startedAt: null, manualOrder: false,
    analysis: {
      summary: "queued", intent: "new_task", targetRunId: null, priority: 0, urgency: "normal", relation: "independent",
      acceptanceCriteria: [], scope: "", nonGoals: [], confidence: 1, reason: "test", routerVersion: "test",
    },
  };
}

describe("Web API request headers", () => {
  it("sources versioned Console wire DTOs from the ABI", async () => {
    const source = await readFile(new URL("../apps/web-console/src/api.ts", import.meta.url), "utf8");
    expect(source).toContain('type ConsoleV1');
    expect(source).toContain('import { createCoreTransport, ConsoleDecode } from "@tagent/core-client"');
    expect(source).not.toMatch(/export interface (?:TaskRun|LearningFeatureState|MemoryRecord)\b/);
  });

  it("does not send JSON content type for bodyless consumer claims", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(success({ cursor: {
      taskRunId: "run",
      consumerId: "web",
      generation: 1,
      acknowledgedSequence: 0,
      terminalAcknowledgedSequence: null,
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

  it("renames a workspace through the Session API", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(success({ id: "session", title: "After", modelId: "gpt-5.6-sol", reasoningEffort: "high", createdAt: 1, updatedAt: 2, latestRunStatus: null, latestRunPhase: null })), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api.renameSession("session", "After");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/console/sessions/session", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ title: "After" }) }));
  });

  it("uses a caller-stable request ID when creating the initial workspace", async () => {
    const session = { id: "session", title: "First workspace", modelId: "gpt-5.6-sol", reasoningEffort: "high", createdAt: 1, updatedAt: 1, latestRunStatus: null, latestRunPhase: null };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(success(session)), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api.createSession("First workspace", "initial-workspace-request");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/console/sessions", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ title: "First workspace", requestId: "initial-workspace-request" }),
    }));
  });

  it("updates and reorders queued prompts through the Session API", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(success(consoleInboxItem())), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(success([consoleInboxItem("second"), consoleInboxItem("first")])), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api.updateInbox("session", "item", "changed");
    await api.reorderInbox("session", ["second", "first"]);
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/console/sessions/session/inbox/item", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ content: "changed" }) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/console/sessions/session/inbox/order", expect.objectContaining({ method: "PUT", body: JSON.stringify({ itemIds: ["second", "first"] }) }));
  });

  it("renders editable, draggable, and keyboard-accessible queued prompts without removing existing actions", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("function QueuePrompt(");
    expect(source).toContain('draggable={!busy && !editing}');
    expect(source).toContain("await api.updateInbox(sessionId, item.id, content)");
    expect(source).toContain("await api.reorderInbox(sessionId, next.map((item) => item.id))");
    expect(source).toContain("api.decideInbox(sessionId, item.id");
    expect(source).toContain("api.mergeInbox(sessionId, item.id, inbox[0].id)");
    expect(source).toContain('aria-label={`Move queued prompt ${index + 1} up`}');
    expect(source).toContain('aria-label={`Move queued prompt ${index + 1} down`}');
    expect(source).toContain('item.decision === "defer" ? "Resume" : "Defer"');
    expect(source).toContain("Merge first");
  });

  it("keeps Enter as a newline, auto-sizes the composer, and exposes persistent desktop controls", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("ref={composerTextareaRef}");
    expect(source).toContain("Math.min(Math.max(textarea.scrollHeight, 36), 140)");
    expect(source).not.toContain('event.key === "Enter" && !event.shiftKey');
    expect(source).toContain("leftCollapsed");
    expect(source).toContain("rightCollapsed");
    expect(source).toContain("workspaceEmojiById");
    expect(source).toContain("updateExecutionProfile");
    expect(source).toContain('runtimeStatus?.modelId ?? "gpt-5.6-sol"');
  });

  it("posts the selected queued item to the manual start endpoint", async () => {
    const payload = { status: "started", item: consoleInboxItem(), run: consoleRun() };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(success(payload)), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api.startInbox("session", "item");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/console/sessions/session/inbox/item/start", expect.objectContaining({ method: "POST" }));
  });

  it("surfaces manual start conflicts and renders success and error feedback", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "session.running_taskrun", message: "session already has a running TaskRun", requestId: "web-test-request", retryable: false, details: {} } }), { status: 409, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const request = api.startInbox("session", "item");
    await expect(request).rejects.toBeInstanceOf(CoreClientError);
    await expect(request).rejects.toThrow("session already has a running TaskRun");
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("void runInboxNow(item)");
    expect(source).toContain("Queued prompt started.");
    expect(source).toContain("setError(cause instanceof Error ? cause.message : String(cause))");
  });

  it("calls retry-launch and renders retry feedback for retryable launch failures", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(success({ status: "started", item: consoleInboxItem(), run: consoleRun("run", 2) })), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api.retryLaunch("run");
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/console/task-runs/run/retry-launch", expect.objectContaining({ method: "POST" }));
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("await api.retryLaunch(run.id)");
    expect(source).toContain('selectedRun.launchRetryable');
    expect(source).toContain('setNotice("TaskRun launch retry started.")');
    expect(source).toContain("setError(cause instanceof Error ? cause.message : String(cause))");
  });

  it("hydrates a newly discovered active Run during Session polling", async () => {
    const source = await readFile(new URL("../apps/web-console/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("active.id !== activeRunIdRef.current");
    expect(source).toContain("const [hydrated, view, history] = await Promise.all([api.run(active.id), api.transcriptView(active.id), api.messages(targetSessionId)])");
    expect(source).toContain("api.messages(targetSessionId)");
    expect(source).toContain("setSelectedRun(hydrated)");
    expect(source).toContain("setExpandedRunId(hydrated.id)");
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
