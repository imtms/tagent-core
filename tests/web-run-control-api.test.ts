import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../apps/web-console/src/api.js";

afterEach(() => vi.unstubAllGlobals());

const success = (data: unknown) => ({ data, requestId: "web-run-control-test" });

const resumableRun = {
  id: "resume-run", sessionId: "session", requestId: "request", status: "running", phase: "implement", goal: "test", contract: null,
  blockedReason: "", lastEventSeq: 0, attempt: 1, resumedAt: 1, createdAt: 1, updatedAt: 1, completedAt: null,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  transcriptCount: 0, checkpoint: null, continuations: [], plan: [], checks: [], userInputRequests: [], pendingUserInput: null,
  artifacts: [], completionGate: { passed: false, failures: [] }, launchRetryable: false, resumable: true,
  supervision: { latestDecision: null, latestGates: [], progress: null, approvalRequests: [], latestContextManifest: null },
};

describe("Web Run control API", () => {
  it("sends request IDs for idempotent cancel and resume actions", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(success({ ok: true })), { status: 200, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify(success(resumableRun)), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await api.cancel("cancel-run");
    await api.resume("resume-run");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/console/task-runs/cancel-run/cancel", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/console/task-runs/resume-run/resume", expect.objectContaining({ method: "POST" }));

    expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({});
    expect(JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body))).toEqual({});
    const cancelRequestId = new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get("X-Request-Id");
    const resumeRequestId = new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers).get("X-Request-Id");
    expect(cancelRequestId).toEqual(expect.any(String));
    expect(resumeRequestId).toEqual(expect.any(String));
    expect(cancelRequestId).not.toBe(resumeRequestId);
  });
});
