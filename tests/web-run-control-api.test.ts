import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../web/src/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("Web Run control API", () => {
  it("sends request IDs for idempotent cancel and resume actions", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await api.cancel("cancel-run");
    await api.resume("resume-run");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/runs/cancel-run/cancel", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/runs/resume-run/resume", expect.objectContaining({ method: "POST" }));

    const cancelBody = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as { requestId?: string };
    const resumeBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body)) as { requestId?: string };
    expect(cancelBody.requestId).toEqual(expect.any(String));
    expect(resumeBody.requestId).toEqual(expect.any(String));
    expect(cancelBody.requestId).not.toBe("");
    expect(resumeBody.requestId).not.toBe("");
    expect(cancelBody.requestId).not.toBe(resumeBody.requestId);
  });
});
