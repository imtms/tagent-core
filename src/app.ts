import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { requiredServiceScope, secureEqual, type ServiceCredential } from "./auth.js";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { PublicRuntimeConfig } from "./config.js";
import type { Store } from "./store/store.js";
import type { AgentService } from "./core/agent-service.js";
import type { MemoryFacade } from "./memory/memory-service.js";
import type { AccessContext, MemoryScope } from "./memory/types.js";

export interface AppDependencies {
  store: Store;
  service: AgentService;
  webRoot?: string;
  logger?: boolean;
  runtimeConfig?: PublicRuntimeConfig;
  serviceCredentials?: ServiceCredential[];
  memory?: MemoryFacade;
}

export function createApp({ store, service, webRoot = path.resolve("dist/web"), logger = true, runtimeConfig, serviceCredentials = [], memory }: AppDependencies) {
  const app = Fastify({ logger });

  if (serviceCredentials.length) app.addHook("onRequest", async (request, reply) => {
    const requiredScope = requiredServiceScope(request.method, request.url);
    if (requiredScope === null) return;
    const authorization = request.headers.authorization ?? "";
    if (authorization.startsWith("Bearer ")) {
      const token = authorization.slice(7);
      const credential = serviceCredentials.find((candidate) => secureEqual(token, candidate.token));
      if (credential && requiredScope !== "admin" && credential.scopes.includes(requiredScope)) return;
      if (credential) return reply.code(403).send({ error: "insufficient service credential scope", requiredScope });
    }
    return reply.code(401).send({ error: "authentication required" });
  });

  app.post("/api/memory/capture", async (request, reply) => {
    if (!memory) return reply.code(503).send({ error: "memory is disabled" });
    const body = request.body as { scope?: MemoryScope; content?: string; idempotencyKey?: string };
    if (!body.scope || !body.content?.trim()) return reply.code(400).send({ error: "scope and content are required" });
    const idempotencyKey = body.idempotencyKey ?? `manual:${Date.now()}`;
    return memory.enqueueCapture({ access: memoryAccess(request, [body.scope], "capture"), sourceRefs: [{ sourceType: "manual", sourceId: idempotencyKey }], content: body.content.trim(), idempotencyKey });
  });
  app.post("/api/memory/jobs", async (request, reply) => {
    if (!memory) return reply.code(503).send({ error: "memory is disabled" });
    const body = request.body as { scopes?: MemoryScope[]; limit?: number };
    if (!body.scopes?.length) return reply.code(400).send({ error: "scopes are required" });
    return memory.listCaptureJobs?.(memoryAccess(request, body.scopes, "memory_admin"), Math.min(500, Math.max(1, body.limit ?? 100))) ?? [];
  });
  app.post("/api/memory/status", async (request, reply) => {
    if (!memory) return reply.code(503).send({ error: "memory is disabled" });
    const body = request.body as { scopes?: MemoryScope[] };
    if (!body.scopes?.length) return reply.code(400).send({ error: "scopes are required" });
    return memory.status(memoryAccess(request, body.scopes, "memory_admin"));
  });
  app.post("/api/memory/recall", async (request, reply) => {
    if (!memory) return reply.code(503).send({ error: "memory is disabled" });
    const body = request.body as { cue?: string; scopes?: MemoryScope[]; kinds?: Array<"fact" | "preference" | "episode" | "procedure">; maxCards?: number; maxColdTopics?: number };
    if (!body.cue?.trim() || !body.scopes?.length) return reply.code(400).send({ error: "cue and scopes are required" });
    return memory.recall({ access: memoryAccess(request, body.scopes, "agent_recall"), cue: body.cue.trim(), kinds: body.kinds, maxCards: body.maxCards, maxColdTopics: body.maxColdTopics });
  });
  app.get("/api/memory/topics/:topicId", async (request, reply) => {
    if (!memory) return reply.code(503).send({ error: "memory is disabled" });
    const { topicId } = request.params as { topicId: string };
    const query = request.query as { scopeType?: MemoryScope["type"]; scopeId?: string };
    if (!query.scopeType || !query.scopeId) return reply.code(400).send({ error: "scopeType and scopeId are required" });
    const topic = await memory.getColdTopic(memoryAccess(request, [{ type: query.scopeType, id: query.scopeId }], "memory_admin"), topicId);
    return topic ?? reply.code(404).send({ error: "topic not found" });
  });
  app.post("/api/memory/records", async (request, reply) => {
    if (!memory) return reply.code(503).send({ error: "memory is disabled" });
    const body = request.body as { scopes?: MemoryScope[]; records?: import("./memory/types.js").WarmMemory[]; topics?: import("./memory/types.js").TopicDescriptor[] };
    if (!body.scopes?.length || !body.records?.length) return reply.code(400).send({ error: "scopes and records are required" });
    return memory.upsert(memoryAccess(request, body.scopes, "memory_admin"), body.records, body.topics);
  });
  app.post("/api/memory/export", async (request, reply) => {
    if (!memory) return reply.code(503).send({ error: "memory is disabled" });
    const body = request.body as { scope?: MemoryScope };
    if (!body.scope) return reply.code(400).send({ error: "scope is required" });
    return memory.export(memoryAccess(request, [body.scope], "memory_admin"), body.scope);
  });
  app.post("/api/memory/forget", async (request, reply) => {
    if (!memory) return reply.code(503).send({ error: "memory is disabled" });
    const body = request.body as { scope?: MemoryScope; ids?: string[]; topicIds?: string[] };
    if (!body.scope) return reply.code(400).send({ error: "scope is required" });
    return memory.forget({ access: memoryAccess(request, [body.scope], "memory_admin"), scope: body.scope, ids: body.ids, topicIds: body.topicIds });
  });

  app.get("/api/health", async () => ({ ok: true, service: "tagent-core" }));
  app.get("/api/config/status", async () => runtimeConfig ?? null);
  app.get("/api/sessions", async () => store.listSessions());
  app.post("/api/sessions", async (request, reply) => {
    const body = (request.body ?? {}) as { title?: string; requestId?: string };
    if (body.requestId != null && (typeof body.requestId !== "string" || !body.requestId.trim() || body.requestId.length > 300)) return reply.code(400).send({ error: "invalid requestId" });
    return store.createSession(body.title?.trim() || "New workspace", body.requestId?.trim());
  });
  app.patch("/api/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { title?: string };
    if (!body.title?.trim()) return reply.code(400).send({ error: "title is required" });
    const session = store.renameSession(id, body.title);
    return session ?? reply.code(404).send({ error: "session not found" });
  });
  app.get("/api/sessions/:id/messages", async (request) => {
    const { id } = request.params as { id: string };
    return store.listMessages(id);
  });
  app.get("/api/sessions/:id/runs", async (request, reply) => {
    const { id } = request.params as { id: string };
    const limit = Math.min(200, Math.max(1, Number((request.query as { limit?: string }).limit ?? 50)));
    if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" });
    return store.listRuns(id, limit).map((run) => ({ ...run, budget: service.getBudget(run.id) }));
  });
  app.get("/api/sessions/:id/run", async (request) => {
    const { id } = request.params as { id: string };
    const run = store.getLatestRun(id);
    return run ? { ...run, budget: service.getBudget(run.id) } : null;
  });
  app.get("/api/sessions/:id/submissions/:requestId", async (request, reply) => {
    const { id, requestId } = request.params as { id: string; requestId: string };
    if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" });
    const item = store.getSessionSubmission(id, requestId);
    if (!item) return reply.code(404).send({ error: "submission not found" });
    return { requestId: item.requestId, sessionId: item.sessionId, inboxItemId: item.id, status: item.status, runId: item.runId, error: item.error, createdAt: item.createdAt, updatedAt: item.updatedAt };
  });
  app.post("/api/sessions/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { content?: string; requestId?: string };
    if (!body?.content?.trim()) return reply.code(400).send({ error: "content is required" });
    if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" });
    const result = service.enqueueSessionInput(id, body.content.trim(), body.requestId);
    return { ...result, receipt: { requestId: result.item.requestId, sessionId: result.item.sessionId, inboxItemId: result.item.id, status: result.item.status, runId: result.item.runId, error: result.item.error, createdAt: result.item.createdAt, updatedAt: result.item.updatedAt } };
  });
  app.get("/api/sessions/:id/inbox", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" });
    return store.listSessionInbox(id);
  });
  app.put("/api/sessions/:id/inbox/order", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { itemIds?: string[] };
    if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" });
    if (!Array.isArray(body?.itemIds) || body.itemIds.some((itemId) => typeof itemId !== "string" || !itemId)) return reply.code(400).send({ error: "itemIds must be an array of ids" });
    const items = service.reorderSessionInputs(id, body.itemIds);
    if (!items) return reply.code(409).send({ error: "queued prompts changed; refresh and try again" });
    return items;
  });
  app.patch("/api/sessions/:id/inbox/:itemId", async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const body = request.body as { content?: string };
    if (!body?.content?.trim()) return reply.code(400).send({ error: "content is required" });
    if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" });
    const item = service.updateSessionInput(id, itemId, body.content);
    if (!item) return reply.code(409).send({ error: "inbox item is not queued" });
    return item;
  });
  app.post("/api/sessions/:id/inbox/:itemId/start", async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" });
    const result = service.startSessionInputNow(id, itemId);
    if (result.status === "started") return result;
    if (result.status === "running") return reply.code(409).send({ error: "session already has a running TaskRun", reason: "running_taskrun", runId: result.runId });
    if (result.status === "continuation") return reply.code(409).send({ error: "a blocked TaskRun has a queued or running continuation", reason: "active_continuation", continuationId: result.continuationId });
    if (result.status === "closing") return reply.code(409).send({ error: "service is shutting down", reason: "service_closing" });
    if (result.status === "failed") return reply.code(500).send({ error: "inbox TaskRun failed to start", reason: "launch_failed" });
    return reply.code(409).send({ error: "inbox item is not queued", reason: "not_queued" });
  });
  app.post("/api/sessions/:id/inbox/:itemId/decision", async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const body = request.body as { decision?: "pending" | "defer" };
    if (!body?.decision || !["pending","defer"].includes(body.decision)) return reply.code(400).send({ error: "invalid decision" });
    if (!service.decideSessionInput(id,itemId,body.decision)) return reply.code(409).send({ error: "inbox item is not queued" });
    return { ok: true };
  });
  app.post("/api/sessions/:id/inbox/:itemId/merge", async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const body = request.body as { targetId?: string };
    if (!body?.targetId) return reply.code(400).send({ error: "targetId is required" });
    if (!service.mergeSessionInputs(id,itemId,body.targetId)) return reply.code(409).send({ error: "items are not mergeable" });
    return { ok: true };
  });
  app.delete("/api/sessions/:id/inbox/:itemId", async (request, reply) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" });
    if (!service.deleteSessionInput(id, itemId)) return reply.code(409).send({ error: "inbox item is not queued" });
    return { ok: true };
  });
  app.post("/api/runs/:id/retry-launch", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!store.getRun(id)) return reply.code(404).send({ error: "run not found" });
    const result = service.retryInboxLaunch(id);
    if (result.status === "started") return result;
    if (result.status === "running") return reply.code(409).send({ error: "session already has a running TaskRun", reason: "running_taskrun", runId: result.runId });
    if (result.status === "continuation") return reply.code(409).send({ error: "a blocked TaskRun has a queued or running continuation", reason: "active_continuation", continuationId: result.continuationId });
    if (result.status === "closing") return reply.code(409).send({ error: "service is shutting down", reason: "service_closing" });
    if (result.status === "failed") return reply.code(500).send({ error: "inbox TaskRun failed to initialize", reason: "launch_failed" });
    return reply.code(409).send({ error: "run does not have a retryable launch failure", reason: "not_retryable" });
  });
  app.post("/api/runs/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!service.cancel(id)) return reply.code(409).send({ error: "run is not active" });
    return { ok: true };
  });
  app.post("/api/runs/:id/steer", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { content?: string; requestId?: string };
    if (!body?.content?.trim()) return reply.code(400).send({ error: "content is required" });
    const result = await service.steer(id, body.content.trim(), body.requestId);
    const status = result.status;
    if (status !== "accepted") return reply.code(status === "full" ? 429 : 409).send({ error: status === "inactive" ? "run is not active" : status === "closing" ? "service is closing" : "control inbox is full", status });
    return { ok: true, ...result };
  });
  app.post("/api/runs/:id/follow-up", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { content?: string; requestId?: string };
    if (!body?.content?.trim()) return reply.code(400).send({ error: "content is required" });
    const result = await service.followUp(id, body.content.trim(), body.requestId);
    const status = result.status;
    if (status !== "accepted") return reply.code(status === "full" ? 429 : 409).send({ error: status === "inactive" ? "run is not active" : status === "closing" ? "service is closing" : "control inbox is full", status });
    return { ok: true, ...result };
  });
  app.post("/api/runs/:id/compact", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { instructions?: string };
    const status = await service.compact(id, body.instructions?.trim() || undefined);
    if (status !== "completed") return reply.code(409).send({ error: status === "inactive" ? "run is not active" : "compaction failed", status });
    return { ok: true, status };
  });
  app.post("/api/runs/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    try { return service.resume(id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.get("/api/runs/:id/supervision", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = service.getRun(id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    return { ...run.supervision, decisions: store.listSupervisorDecisions(id), edges: store.listTaskRunEdges(id) };
  });
  app.post("/api/runs/:id/spawn-proposals", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { goal?: string; acceptanceCriteria?: string[]; relation?: "depends_on" | "follow_up" | "parallel" | "derived" };
    if (!service.getRun(id)) return reply.code(404).send({ error: "run not found" });
    if (!body?.goal?.trim()) return reply.code(400).send({ error: "goal is required" });
    return store.createSpawnProposal(id, body.goal.trim(), body.acceptanceCriteria ?? [], body.relation ?? "follow_up");
  });
  app.post("/api/spawn-proposals/:id/spawn", async (request, reply) => {
    const { id } = request.params as { id: string };
    try { return service.spawnProposal(id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.get("/api/runs/:id/control-inbox", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!service.getRun(id)) return reply.code(404).send({ error: "run not found" });
    return store.listControlInbox(id);
  });
  app.get("/api/runs/:id/operations", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!service.getRun(id)) return reply.code(404).send({ error: "run not found" });
    return store.listOperations(id);
  });
  app.get("/api/runs/:id/transcript", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!service.getRun(id)) return reply.code(404).send({ error: "run not found" });
    return store.listTranscriptEntries(id);
  });
  app.get("/api/runs/:id/transcript-view", async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!service.getRun(id)) return reply.code(404).send({ error: "run not found" });
    return store.listTranscriptView(id);
  });
  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = service.getRun(id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    return { ...run, budget: service.getBudget(id) };
  });
  app.post("/api/runs/:id/consumers/:consumerId/claim", async (request, reply) => {
    const { id, consumerId } = request.params as { id: string; consumerId: string };
    if (!service.getRun(id)) return reply.code(404).send({ error: "run not found" });
    if (!consumerId || consumerId.length > 200) return reply.code(400).send({ error: "invalid consumer id" });
    return store.claimEventConsumer(id, consumerId);
  });
  app.post("/api/runs/:id/consumers/:consumerId/ack", async (request, reply) => {
    const { id, consumerId } = request.params as { id: string; consumerId: string };
    const body = request.body as { generation?: number; seq?: number };
    const status = store.ackEventConsumer(id, consumerId, Number(body?.generation), Number(body?.seq));
    if (status === "missing") return reply.code(404).send({ error: "run not found", status });
    if (status === "stale") return reply.code(409).send({ error: "consumer generation is stale", status });
    if (status === "invalid") return reply.code(400).send({ error: "invalid acknowledgement sequence", status });
    return { ok: true, status };
  });
  app.get("/api/runs/:id/events", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { after?: string; consumerId?: string; generation?: string };
    const after = Number(query.after ?? 0);
    const generation = Number(query.generation);
    if (!service.getRun(id)) return reply.code(404).send({ error: "run not found" });
    const cursor = query.consumerId ? store.getEventConsumer(id, query.consumerId) : undefined;
    if (!cursor || cursor.generation !== generation) return reply.code(409).send({ error: "consumer generation is stale" });
    const replayAfter = Math.max(after, cursor.ackedSeq);
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    let unsubscribe = () => {};
    let replaying = true;
    const buffered: ReturnType<typeof service.replay> = [];
    const send = (event: ReturnType<typeof service.replay>[number]) => {
      if (store.getEventConsumer(id, query.consumerId!)?.generation !== generation) {
        unsubscribe();
        response.end();
        return false;
      }
      return response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    };
    unsubscribe = service.subscribe(id, (event) => { if (replaying) buffered.push(event); else send(event); });
    let deliveredSeq = replayAfter;
    for (const event of service.replay(id, replayAfter)) {
      if (send(event) === false) return;
      deliveredSeq = event.seq;
    }
    replaying = false;
    for (const event of buffered) if (event.seq > deliveredSeq && send(event) === false) return;
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    request.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
  });

  app.all("/api/*", async (request, reply) => reply.code(404).send({ error: `API route not found: ${request.method} ${request.url}` }));

  const mimeTypes: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
  app.get("/*", async (request, reply) => {
    const requested = request.url.split("?")[0] === "/" ? "index.html" : request.url.split("?")[0].slice(1);
    const candidate = path.resolve(webRoot, requested);
    if (!candidate.startsWith(webRoot)) return reply.code(404).send("Not found");
    let filename = candidate;
    try { if ((await stat(filename)).isDirectory()) filename = path.join(filename, "index.html"); }
    catch { filename = path.join(webRoot, "index.html"); }
    try { return reply.type(mimeTypes[path.extname(filename)] ?? "application/octet-stream").send(await readFile(filename)); }
    catch { return reply.code(404).send("Web build not found. Run npm run build."); }
  });

  app.addHook("onClose", async () => { await service.closeRuntimes(); store.close(); });
  return app;
}

function memoryAccess(request: FastifyRequest, scopes: MemoryScope[], purpose: AccessContext["purpose"]): AccessContext {
  return { subjectId: String(request.headers["x-tagent-subject"] ?? "local-admin"), scopes, purpose };
}
