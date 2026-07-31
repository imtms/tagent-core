import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../web/src/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("Web API request headers", () => {
  it("does not send JSON content type for bodyless consumer claims", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ runId: "run", consumerId: "web", generation: 1, ackedSeq: 0, terminalAckedSeq: null, claimedAt: 1, updatedAt: 1 }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api.claimConsumer("run", "web");
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).has("Content-Type")).toBe(false);
  });

  it("adds JSON content type when a request has a body", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api.ackConsumer("run", "web", 1, 1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  it("posts the selected queued item to the manual start endpoint", async () => {
    const payload = { status: "started", item: { id: "item" }, run: { id: "run" } };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await api.startInbox("session", "item");
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions/session/inbox/item/start", expect.objectContaining({ method: "POST" }));
  });

  it("surfaces manual start conflicts and renders success and error feedback", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "session already has a running TaskRun", reason: "running_taskrun" }), { status: 409, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(api.startInbox("session", "item")).rejects.toThrow("session already has a running TaskRun");
    const source = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("void runInboxNow(item)");
    expect(source).toContain("Queued prompt started.");
    expect(source).toContain("setError(cause instanceof Error ? cause.message : String(cause))");
  });

  it("hydrates a newly discovered active Run during Session polling", async () => {
    const source = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    expect(source).toContain("active.id !== activeRunIdRef.current");
    expect(source).toContain("Promise.all([api.run(active.id), api.messages(sessionId), api.transcriptView(active.id)])");
    expect(source).toContain("setSelectedRun(hydrated)");
    expect(source).toContain("setExpandedRunId(hydrated.id)");
  });
});
