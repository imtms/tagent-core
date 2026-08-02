import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "../src/store/store.js";
import { AgentService } from "../src/core/agent-service.js";
import { TaskRunSupervisor } from "../src/core/supervisor.js";
import { TestSupervisorReviewer } from "../src/core/supervisor-reviewer.js";
import { createApp } from "../src/app.js";

const apps: Array<ReturnType<typeof createApp>> = [];
const inboxAnalysis = (summary: string) => ({ summary, intent: "new_task" as const, targetRunId: null, priority: 500, urgency: "normal" as const, relation: "independent" as const, acceptanceCriteria: [summary], scope: summary, nonGoals: [], confidence: 1, reason: "test", routerVersion: "test" });
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });

describe("HTTP API", () => {
  it("keeps the original API usable and reports memory disabled when no memory facade is configured", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-api-"));
    const store = new Store(":memory:");
    const app = createApp({ store, service: new AgentService(store, workspace), logger: false, webRoot: workspace });
    apps.push(app);

    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
    const session = await app.inject({ method: "POST", url: "/api/sessions", payload: { title: "without long-term memory" } });
    expect(session.statusCode).toBe(200);
    const memory = await app.inject({ method: "POST", url: "/api/memory/status", payload: { scopes: [{ type: "workspace", id: "default" }] } });
    expect(memory.statusCode).toBe(503);
    expect(memory.json()).toEqual({ error: "memory is disabled" });
  });
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
    expect((await app.inject({ method: "GET", url: "/api/sessions" })).json()[0]).toMatchObject({ latestRunStatus: "running", latestRunPhase: "discover" });
    const operations = await app.inject({ method: "GET", url: `/api/runs/${secondRun.id}/operations` });
    expect(operations.json()).toEqual([]);
    const missingOperations = await app.inject({ method: "GET", url: "/api/runs/missing/operations" });
    expect(missingOperations.statusCode).toBe(404);
    const missingTranscript = await app.inject({ method: "GET", url: "/api/runs/missing/transcript" });
    expect(missingTranscript.statusCode).toBe(404);
    const transcriptView = await app.inject({ method: "GET", url: `/api/runs/${secondRun.id}/transcript-view` });
    expect(transcriptView.json()).toEqual([]);
    store.recordContextManifest({ id: "api-manifest", runId: secondRun.id, attempt: 1, source: "session", items: [], stats: {}, manifestHash: "hash", createdAt: 1 });
    const manifests = await app.inject({ method: "GET", url: `/api/runs/${secondRun.id}/context-manifests` });
    expect(manifests.json()).toEqual([expect.objectContaining({ id: "api-manifest", manifestHash: "hash" })]);
    expect((await app.inject({ method: "GET", url: "/api/runs/missing/context-manifests" })).statusCode).toBe(404);
  });

  it("creates Sessions idempotently with an optional requestId", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-api-session-request-"));
    const store = new Store(":memory:");
    const app = createApp({ store, service: new AgentService(store, workspace), logger: false, webRoot: workspace }); apps.push(app);
    const first = (await app.inject({ method: "POST", url: "/api/sessions", payload: { title: "External", requestId: "session-request-1" } })).json();
    const duplicate = (await app.inject({ method: "POST", url: "/api/sessions", payload: { title: "Changed", requestId: "session-request-1" } })).json();
    expect(duplicate.id).toBe(first.id);
    expect(duplicate.title).toBe("External");
    expect(store.listSessions()).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: "/api/sessions", payload: { requestId: "" } })).statusCode).toBe(400);
  });

  it("rejects opaque UI and release synchronization markers instead of starting autonomous work", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-api-marker-"));
    const store = new Store(":memory:");
    const app = createApp({ store, service: new AgentService(store, workspace), logger: false, webRoot: workspace }); apps.push(app);
    const session = store.createSession();
    for (const content of ["release-013-1785530015196", "ui-sync-1785529628478", "final-ui-sync-1785529817867"]) {
      const response = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content } });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ reason: "non_actionable_prompt" });
    }
    expect(store.listRuns(session.id)).toHaveLength(0);
    expect(store.listMessages(session.id)).toHaveLength(0);
    const actionable = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "Please prepare release 0.1.4" } });
    expect(actionable.statusCode).toBe(200);
  });

  it("pages long chat history and validates the cursor", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-api-message-page-"));
    const store = new Store(":memory:");
    const app = createApp({ store, service: new AgentService(store, workspace), logger: false, webRoot: workspace }); apps.push(app);
    const session = store.createSession();
    for (let index = 1; index <= 100; index += 1) store.appendMessage(session.id, index % 2 ? "user" : "assistant", `message-${index}`);
    const latest = (await app.inject({ method: "GET", url: `/api/sessions/${session.id}/messages?limit=20` })).json();
    expect(latest).toHaveLength(20);
    expect(latest[0].content).toBe("message-81");
    const older = (await app.inject({ method: "GET", url: `/api/sessions/${session.id}/messages?limit=20&beforeId=${latest[0].id}` })).json();
    expect(older).toHaveLength(20);
    expect(older.at(-1).id).toBeLessThan(latest[0].id);
    expect((await app.inject({ method: "GET", url: `/api/sessions/${session.id}/messages?beforeId=bad` })).statusCode).toBe(400);
  });

  it("returns a durable submission receipt and finds it by requestId", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-api-submission-"));
    const store = new Store(":memory:");
    class WaitingRuntime { private resolve?: () => void; prompt() { return new Promise<void>((resolve) => { this.resolve = resolve; }); } async steer() { return "accepted" as const; } abort() { this.resolve?.(); } getMessages() { return []; } getError() { return undefined; } }
    const app = createApp({ store, service: new AgentService(store, workspace, () => new WaitingRuntime()), logger: false, webRoot: workspace }); apps.push(app);
    const session = store.createSession();
    const submitted = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "durable", requestId: "external-request-1" } });
    expect(submitted.json().receipt).toMatchObject({ requestId: "external-request-1", sessionId: session.id, inboxItemId: submitted.json().item.id, status: "started", runId: submitted.json().run.id });
    const found = await app.inject({ method: "GET", url: `/api/sessions/${session.id}/submissions/external-request-1` });
    expect(found.json()).toEqual(submitted.json().receipt);
    expect((await app.inject({ method: "GET", url: `/api/sessions/${session.id}/submissions/missing` })).statusCode).toBe(404);
  });

  it("authorizes service credentials by least-privilege scope", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-api-service-auth-"));
    const store = new Store(":memory:");
    const token = "gateway-service-token-1234567890";
    const app = createApp({ store, service: new AgentService(store, workspace), logger: false, webRoot: workspace, serviceCredentials: [{ token, scopes: ["sessions:read", "sessions:write", "runs:read", "runs:control", "events:consume"] }] }); apps.push(app);
    const bearer = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: "POST", url: "/api/sessions", headers: bearer, payload: { title: "service" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/sessions", headers: bearer })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/config/status", headers: bearer })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/sessions" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/health" })).statusCode).toBe(200);
  });

  it("renames a workspace through the Session API", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-api-rename-"));
    const store = new Store(":memory:");
    const app = createApp({ store, service: new AgentService(store, workspace), logger: false, webRoot: workspace }); apps.push(app);
    const session = store.createSession("Before");
    const renamed = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { title: "  After  " } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id: session.id, title: "After" });
    expect((await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}`, payload: { title: " " } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PATCH", url: "/api/sessions/missing", payload: { title: "After" } })).statusCode).toBe(404);
  });

  it("queues all message input through the Session Supervisor inbox and deletes only unstarted items", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-api-"));
    const store = new Store(":memory:");
    class WaitingRuntime {
      private resolve?: () => void;
      prompt() { return new Promise<void>((resolve) => { this.resolve = resolve; }); }
      async steer() { return "accepted" as const; }
      abort() { this.resolve?.(); }
      getMessages() { return []; }
      getError() { return undefined; }
    }
    const service = new AgentService(store, workspace, () => new WaitingRuntime());
    const app = createApp({ store, service, logger: false, webRoot: workspace }); apps.push(app);
    const session = store.createSession();
    const first = (await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "first", requestId: "msg-1" } })).json();
    const second = (await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "second", requestId: "msg-2" } })).json();
    expect(first).toMatchObject({ item: { content: "first", status: "started" }, run: { goal: "first", status: "running" } });
    expect(second).toMatchObject({ item: { content: "second", status: "queued" }, run: null });
    expect((await app.inject({ method: "GET", url: `/api/sessions/${session.id}/inbox` })).json()).toEqual([expect.objectContaining({ id: second.item.id, content: "second" })]);
    expect((await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}/inbox/${first.item.id}` })).statusCode).toBe(409);
    expect((await app.inject({ method: "DELETE", url: `/api/sessions/${session.id}/inbox/${second.item.id}` })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: "GET", url: `/api/sessions/${session.id}/inbox` })).json()).toEqual([]);
  });

  it("edits and reorders queued prompts through the Session API", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-api-edit-inbox-"));
    const store = new Store(":memory:");
    const service = new AgentService(store, workspace);
    const app = createApp({ store, service, logger: false, webRoot: workspace }); apps.push(app);
    const session = store.createSession();
    const blocked = store.createRun(session.id, "blocked"); store.blockRun(blocked.id, "review");
    const first = store.enqueueSessionInbox(session.id, "first", inboxAnalysis("first"), "api-edit-first");
    const second = store.enqueueSessionInbox(session.id, "second", inboxAnalysis("second"), "api-edit-second");
    const third = store.enqueueSessionInbox(session.id, "third", inboxAnalysis("third"), "api-edit-third");

    const edited = await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}/inbox/${second.id}`, payload: { content: "  changed  " } });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ id: second.id, content: "changed" });
    const reordered = await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/inbox/order`, payload: { itemIds: [third.id, second.id, first.id] } });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json().map((item: { id: string; position: number }) => [item.id, item.position])).toEqual([[third.id, 1], [second.id, 2], [first.id, 3]]);
    expect((await app.inject({ method: "PUT", url: `/api/sessions/${session.id}/inbox/order`, payload: { itemIds: [first.id] } })).statusCode).toBe(409);
    expect((await app.inject({ method: "PATCH", url: `/api/sessions/${session.id}/inbox/${first.id}`, payload: { content: " " } })).statusCode).toBe(400);
  });

  it("starts a selected queued inbox item through the manual start API and reports conflicts", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-api-"));
    const store = new Store(":memory:");
    class WaitingRuntime {
      private resolve?: () => void;
      prompt() { return new Promise<void>((resolve) => { this.resolve = resolve; }); }
      async steer() { return "accepted" as const; }
      abort() { this.resolve?.(); }
      getMessages() { return []; }
      getError() { return undefined; }
    }
    const service = new AgentService(store, workspace, () => new WaitingRuntime());
    const app = createApp({ store, service, logger: false, webRoot: workspace }); apps.push(app);
    const session = store.createSession();
    const blocked = store.createRun(session.id, "blocked"); store.blockRun(blocked.id, "gate");
    const queued = store.enqueueSessionInbox(session.id, "run selected", inboxAnalysis("run selected"), "api-run-now");

    const started = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/inbox/${queued.id}/start` });
    expect(started.statusCode).toBe(200);
    expect(started.json()).toMatchObject({ status: "started", item: { id: queued.id, status: "started" }, run: { goal: "run selected", status: "running" } });
    expect(store.getRun(blocked.id)?.status).toBe("blocked");

    const second = store.enqueueSessionInbox(session.id, "conflict", inboxAnalysis("conflict"), "api-conflict");
    const conflict = await app.inject({ method: "POST", url: `/api/sessions/${session.id}/inbox/${second.id}/start` });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ reason: "running_taskrun" });
  });

  it("retries a failed inbox runtime initialization on the same TaskRun", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-api-launch-retry-"));
    const store = new Store(":memory:");
    let initializationAttempts = 0;
    class InitializingRuntime {
      async initialize() { initializationAttempts += 1; if (initializationAttempts === 1) throw new Error("runtime unavailable"); }
      async prompt() {}
      async steer() { return "accepted" as const; }
      abort() {}
      getMessages() { return []; }
      getError() { return undefined; }
    }
    const service = new AgentService(store, workspace, () => new InitializingRuntime());
    const app = createApp({ store, service, logger: false, webRoot: workspace }); apps.push(app);
    const session = store.createSession();
    const admitted = (await app.inject({ method: "POST", url: `/api/sessions/${session.id}/messages`, payload: { content: "initialize", requestId: "initialize-once" } })).json();
    await new Promise((resolve) => setImmediate(resolve));
    const failed = store.getRun(admitted.run.id)!;
    expect(failed).toMatchObject({ status: "failed", attempt: 1, launchRetryable: true });
    expect(store.getSessionInboxItem(admitted.item.id)).toMatchObject({ status: "started", runId: failed.id, error: "runtime unavailable" });

    const response = await app.inject({ method: "POST", url: `/api/runs/${failed.id}/retry-launch` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "started", item: { id: admitted.item.id, status: "started" }, run: { id: failed.id, attempt: 2 } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.listRuns(session.id)).toHaveLength(1);
    expect(store.listMessages(session.id).filter((message) => message.role === "user" && message.content === "initialize")).toHaveLength(1);
    expect(store.listEvents(failed.id).some((event) => event.type === "run.launch.retrying" && event.data.attempt === 2)).toBe(true);
  });

  it("returns a conflict when retry-launch would overlap another running TaskRun", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-api-launch-conflict-"));
    const store = new Store(":memory:");
    const service = new AgentService(store, workspace);
    const app = createApp({ store, service, logger: false, webRoot: workspace }); apps.push(app);
    const session = store.createSession();
    const item = store.enqueueSessionInbox(session.id, "retry", inboxAnalysis("retry"), "retry-api-conflict");
    const claimed = store.claimNextSessionInbox(session.id)!;
    store.recordSessionInboxLaunchFailure(item.id, claimed.run.id, "init failed");
    store.transitionRun(claimed.run.id, ["running"], "failed", "run.failed", { reason: "runtime_initialization_failed", retryable: true }, "init failed", 1);
    const running = store.createRun(session.id, "other running");
    const response = await app.inject({ method: "POST", url: `/api/runs/${claimed.run.id}/retry-launch` });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: "running_taskrun", runId: running.id });
  });

  it("rejects retry-launch for an ordinary failed Run", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-api-launch-not-retryable-"));
    const store = new Store(":memory:");
    const service = new AgentService(store, workspace);
    const app = createApp({ store, service, logger: false, webRoot: workspace }); apps.push(app);
    const session = store.createSession();
    const run = store.createRun(session.id, "ordinary"); store.finalizeRun(run.id, "failed", "ordinary failure");
    const response = await app.inject({ method: "POST", url: `/api/runs/${run.id}/retry-launch` });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ reason: "not_retryable" });
  });

  it("returns JSON 404 for unknown API routes instead of the SPA document", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-api-"));
    const store = new Store(":memory:");
    const app = createApp({ store, service: new AgentService(store, workspace), logger: false, webRoot: workspace }); apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/not-a-route" });
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.json()).toEqual({ error: "API route not found: GET /api/not-a-route" });
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

  it("exposes supervision state and explicitly launches an approved spawn proposal", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "tagent-api-"));
    const store = new Store(":memory:");
    const service = new AgentService(store, workspace, () => ({
      async prompt() {}, async steer() { return "accepted" as const; }, abort() {}, getMessages() { return []; }, getError() { return undefined; },
    }));
    const app = createApp({ store, service, logger: false, webRoot: workspace }); apps.push(app);
    const session = store.createSession();
    const parent = store.createRun(session.id, "parent"); store.finalizeRun(parent.id, "completed");
    const proposal = (await app.inject({ method: "POST", url: `/api/runs/${parent.id}/spawn-proposals`, payload: { goal: "child", acceptanceCriteria: ["done"], relation: "follow_up" } })).json();
    const rejectedBeforeApproval = await app.inject({ method: "POST", url: `/api/spawn-proposals/${proposal.id}/spawn` });
    expect(rejectedBeforeApproval.statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `/api/spawn-proposals/${proposal.id}/approve` })).statusCode).toBe(200);
    const childResponse = await app.inject({ method: "POST", url: `/api/spawn-proposals/${proposal.id}/spawn` });
    expect(childResponse.statusCode).toBe(200);
    expect(childResponse.json()).toMatchObject({ goal: "child", status: "running" });
    const supervision = (await app.inject({ method: "GET", url: `/api/runs/${parent.id}/supervision` })).json();
    expect(supervision.edges).toEqual([expect.objectContaining({ relation: "follow_up", toRunId: childResponse.json().id })]);
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

describe("User input request API", () => {
  it("submits requested fields and resumes the original TaskRun", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "configure target");
    const request = store.requestUserInput(run.id, "Which target?", [{ key: "target", label: "Target", description: "", inputType: "text", required: true, placeholder: "staging" }]);
    const prompts: string[] = [];
    const app = createApp({ store, service: new AgentService(store, "/tmp", () => ({
      async prompt(prompt) { prompts.push(prompt); }, async steer() { return "accepted" as const; }, async followUp() { return "accepted" as const; },
      abort() {}, getMessages() { return []; }, getError() { return undefined; },
    })), logger: false, webRoot: "/tmp" });
    apps.push(app);
    const missing = await app.inject({ method: "POST", url: `/api/user-input-requests/${request.id}/submit`, payload: { response: {} } });
    expect(missing.statusCode).toBe(409);
    const submitted = await app.inject({ method: "POST", url: `/api/user-input-requests/${request.id}/submit`, payload: { response: { target: "staging" } } });
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toMatchObject({ id: run.id, status: "running", attempt: 2, pendingUserInput: null });
    await new Promise((resolve) => setImmediate(resolve));
    expect(prompts.join("\n")).toContain("Target (target): staging");
  });
});

describe("Supervisor approval API", () => {
  it("requires an explicit approval decision before resuming", async () => {
    const store = new Store(":memory:");
    const session = store.createSession();
    const run = store.createRun(session.id, "approved operation");
    store.blockRun(run.id, "approval required");
    const decision = await new TaskRunSupervisor(store, new TestSupervisorReviewer(undefined, { action: "pause_for_approval", reasonCode: "approval_required", rationale: "Explicit approval is required.", confidence: 1 })).reviewAttemptFailure(store.getRun(run.id)!, 1, "Permission approval required");
    const approval = store.ensureApprovalRequest(run.id, decision.id, decision.rationale);
    const app = createApp({ store, service: new AgentService(store, "/tmp", () => ({
      async prompt() {}, async steer() { return "accepted" as const; }, async followUp() { return "accepted" as const; },
      abort() {}, getMessages() { return []; }, getError() { return undefined; },
    })), logger: false, webRoot: "/tmp" });
    apps.push(app);
    const blocked = await app.inject({ method: "POST", url: `/api/runs/${run.id}/resume` });
    expect(blocked.statusCode).toBe(409);
    const rejected = await app.inject({ method: "POST", url: `/api/approval-requests/${approval.id}/reject`, payload: { resolution: "not allowed" } });
    expect(rejected.statusCode).toBe(200);
    expect(store.getApprovalRequest(approval.id)).toMatchObject({ status: "rejected", resolution: "not allowed" });
  });
});
