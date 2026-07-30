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
  app.get("/api/sessions/:id/run", async (request) => {
    const { id } = request.params as { id: string };
    return store.getActiveRun(id) ?? null;
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
    const body = request.body as { content?: string };
    if (!body?.content?.trim()) return reply.code(400).send({ error: "content is required" });
    if (!service.steer(id, body.content.trim())) return reply.code(409).send({ error: "run is not active" });
    return { ok: true };
  });
  app.post("/api/runs/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    try { return service.resume(id); }
    catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.get("/api/runs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const run = service.getRun(id);
    if (!run) return reply.code(404).send({ error: "run not found" });
    return run;
  });
  app.get("/api/runs/:id/events", async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string };
    const after = Number((request.query as { after?: string }).after ?? 0);
    if (!service.getRun(id)) return reply.code(404).send({ error: "run not found" });
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    const send = (event: ReturnType<typeof service.replay>[number]) => response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
    for (const event of service.replay(id, after)) send(event);
    const unsubscribe = service.subscribe(id, send);
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

  app.addHook("onClose", async () => store.close());
  return app;
}
