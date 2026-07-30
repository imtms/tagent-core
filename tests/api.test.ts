import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store/store.js";
import { AgentService } from "../src/core/agent-service.js";
import { createApp } from "../src/app.js";

const apps: Array<ReturnType<typeof createApp>> = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("HTTP API", () => {
  it("serves health and session CRUD", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-api-"));
    const store = new Store(":memory:");
    const app = createApp({ store, service: new AgentService(store, workspace), logger: false, webRoot: workspace });
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/api/health" })).json()).toEqual({ ok: true, service: "tagent-core" });
    expect((await app.inject({ method: "GET", url: "/api/config/status" })).json()).toBeNull();
    const created = (await app.inject({ method: "POST", url: "/api/sessions", payload: { title: "API test" } })).json();
    expect(created.title).toBe("API test");
    const sessions = (await app.inject({ method: "GET", url: "/api/sessions" })).json();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe(created.id);
    const firstRun = store.createRun(created.id, "first");
    store.finalizeRun(firstRun.id, "completed");
    const secondRun = store.createRun(created.id, "second");
    const runs = (await app.inject({ method: "GET", url: `/api/sessions/${created.id}/runs` })).json();
    expect(runs.map((run: { id: string }) => run.id)).toEqual([secondRun.id, firstRun.id]);
    const operations = await app.inject({ method: "GET", url: `/api/runs/${secondRun.id}/operations` });
    expect(operations.json()).toEqual([]);
    const missingOperations = await app.inject({ method: "GET", url: "/api/runs/missing/operations" });
    expect(missingOperations.statusCode).toBe(404);
    const missingTranscript = await app.inject({ method: "GET", url: "/api/runs/missing/transcript" });
    expect(missingTranscript.statusCode).toBe(404);
  });

  it("rejects empty messages before invoking the model", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-api-"));
    const store = new Store(":memory:");
    const app = createApp({ store, service: new AgentService(store, workspace), logger: false, webRoot: workspace });
    apps.push(app);
    const session = store.createSession();
    const response = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: " " } });
    expect(response.statusCode).toBe(400);
  });
});
