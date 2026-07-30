import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { PublicRuntimeConfig } from "./config.js";
import type { Store } from "./store/store.js";
import type { AgentService } from "./core/agent-service.js";

export interface AppDependencies {
  store: Store;
  service: AgentService;
  webRoot?: string;
  logger?: boolean;
  runtimeConfig?: PublicRuntimeConfig;
}

export function createApp({ store, service, webRoot = path.resolve("dist/web"), logger = true, runtimeConfig }: AppDependencies) {
  const app = Fastify({ logger });

  app.get("/api/health", async () => ({ ok: true, service: "tagent-core" }));
  app.get("/api/config/status", async () => runtimeConfig ?? null);
  app.get("/api/sessions", async () => store.listSessions());
  app.post("/api/sessions", async (request) => {
    const body = (request.body ?? {}) as { title?: string };
    return store.createSession(body.title?.trim() || "New workspace");
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
  app.post("/api/sessions/:id/messages", async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { content?: string; requestId?: string };
    if (!body?.content?.trim()) return reply.code(400).send({ error: "content is required" });
    if (!store.getSession(id)) return reply.code(404).send({ error: "session not found" });
    return service.start(id, body.content.trim(), body.requestId);
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
