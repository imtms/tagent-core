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
    const transcriptView = await app.inject({ method: "GET", url: `/api/runs/${secondRun.id}/transcript-view` });
    expect(transcriptView.json()).toEqual([]);
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

  it("exposes idempotent durable control admission and inbox inspection", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-api-"));
    const store = new Store(":memory:");
    class ActiveRuntime {
      private resolvePrompt?: () => void;
      prompt() { return new Promise<void>((resolve) => { this.resolvePrompt = resolve; }); }
      async steer() { return "accepted" as const; }
      abort() { this.resolvePrompt?.(); }
      getMessages() { return []; }
      getError() { return undefined; }
    }
    const service = new AgentService(store, workspace, () => new ActiveRuntime());
    const app = createApp({ store, service, logger: false, webRoot: workspace });
    apps.push(app);
    const session = store.createSession();
    const run = await service.start(session.id, "control api");
    const first = await app.inject({ method: "POST", url: `/api/runs/${run.id}/steer`, payload: { content: "change", requestId: "request-1" } });
    const duplicate = await app.inject({ method: "POST", url: `/api/runs/${run.id}/steer`, payload: { content: "change", requestId: "request-1" } });
    expect(first.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    const inbox = (await app.inject({ method: "GET", url: `/api/runs/${run.id}/control-inbox` })).json();
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({ requestId: "request-1", kind: "steer", status: "delivered" });
  });

  it("claims consumers and rejects stale or invalid ACKs", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-api-"));
    const store = new Store(":memory:");
    const app = createApp({ store, service: new AgentService(store, workspace), logger: false, webRoot: workspace });
    apps.push(app);
    const session = store.createSession();
    const run = store.createRun(session.id, "consumer api");
    store.appendEvent(run.id, "message.delta", { delta: "a" });
    const first = (await app.inject({ method: "POST", url: `/api/runs/${run.id}/consumers/web/claim` })).json();
    const second = (await app.inject({ method: "POST", url: `/api/runs/${run.id}/consumers/web/claim` })).json();
    expect(second.generation).toBe(first.generation + 1);
    expect((await app.inject({ method: "POST", url: `/api/runs/${run.id}/consumers/web/ack`, payload: { generation: first.generation, seq: 1 } })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/runs/${run.id}/consumers/web/ack`, payload: { generation: second.generation, seq: 2 } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/api/runs/${run.id}/consumers/web/ack`, payload: { generation: second.generation, seq: 1 } })).json()).toEqual({ ok: true, status: "accepted" });
  });

});
