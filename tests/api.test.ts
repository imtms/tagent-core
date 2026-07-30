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
