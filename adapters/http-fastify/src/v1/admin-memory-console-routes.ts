import type { FastifyInstance, FastifyRequest } from "fastify";
import type { HttpMemoryAccess, HttpMemoryScope } from "../ports/index.js";
import type { V1ApiDependencies } from "./plugin.js";
import { successEnvelope } from "./errors.js";
import { authorizeConsole, consoleError, memoryAccess, withRequestAbortSignal } from "./console-route-support.js";

type GovernAction = "approve" | "reject" | "correct" | "resolve";
type FeedbackSignal = "cited" | "helpful" | "confirmed" | "corrected" | "harmful" | "task_success" | "task_failure";

export function registerAdminMemoryConsoleV1Routes(app: FastifyInstance, dependencies: V1ApiDependencies): void {
  const memory = dependencies.memory;
  const authorize = authorizeConsole(dependencies, "admin", "admin");
  const requireMemory = () => {
    if (!memory) throw consoleError(503, "memory.unavailable", "memory is disabled");
    return memory;
  };
  const access = (request: FastifyRequest, scopes: HttpMemoryScope[], purpose: HttpMemoryAccess["purpose"]) =>
    memoryAccess(request, scopes, purpose);

  app.post("/api/v1/admin/memory/capture", { onRequest: authorize }, async (request) => {
    const body = request.body as { scope?: HttpMemoryScope; content?: string; idempotencyKey?: string };
    if (!body.scope || !body.content?.trim()) throw consoleError(400, "memory.capture_invalid", "scope and content are required");
    const idempotencyKey = body.idempotencyKey ?? `manual:${Date.now()}`;
    const result = await requireMemory().enqueueCapture({
      access: access(request, [body.scope], "capture"),
      sourceRefs: [{ sourceType: "manual", sourceId: idempotencyKey }],
      content: body.content.trim(),
      idempotencyKey,
      captureSource: { kind: "manual_input", role: "user", explicitIntent: true },
    });
    return successEnvelope(request, result);
  });

  app.post("/api/v1/admin/memory/jobs", { onRequest: authorize }, async (request) => {
    const body = request.body as { scopes?: HttpMemoryScope[]; limit?: number };
    if (!body.scopes?.length) throw consoleError(400, "memory.scopes_required", "scopes are required");
    const result = await requireMemory().listCaptureJobs?.(access(request, body.scopes, "memory_admin"), Math.min(500, Math.max(1, body.limit ?? 100))) ?? [];
    return successEnvelope(request, result);
  });

  app.post("/api/v1/admin/memory/status", { onRequest: authorize }, async (request) => {
    const body = request.body as { scopes?: HttpMemoryScope[] };
    if (!body.scopes?.length) throw consoleError(400, "memory.scopes_required", "scopes are required");
    return successEnvelope(request, await requireMemory().status(access(request, body.scopes, "memory_admin")));
  });

  app.post("/api/v1/admin/memory/recall-console", { onRequest: authorize }, async (request, reply) => {
    const body = request.body as { cue?: string; scopes?: HttpMemoryScope[]; kinds?: Array<"fact" | "preference" | "episode" | "procedure">; maxCards?: number; maxColdTopics?: number };
    const cue = body.cue?.trim();
    const scopes = body.scopes;
    if (!cue || !scopes?.length) throw consoleError(400, "memory.recall_invalid", "cue and scopes are required");
    const result = await withRequestAbortSignal(request, reply, (signal) => requireMemory().recall({
      access: access(request, scopes, "agent_recall"),
      cue,
      kinds: body.kinds,
      maxCards: body.maxCards,
      maxColdTopics: body.maxColdTopics,
    }, signal));
    return successEnvelope(request, result);
  });

  app.post("/api/v1/admin/memory/export", { onRequest: authorize }, async (request) => {
    const body = request.body as { scope?: HttpMemoryScope; limit?: number };
    if (!body.scope) throw consoleError(400, "memory.scope_required", "scope is required");
    return successEnvelope(request, await requireMemory().export(access(request, [body.scope], "memory_admin"), body.scope, body.limit));
  });

  app.post("/api/v1/admin/memory/forget", { onRequest: authorize }, async (request) => {
    const body = request.body as { scope?: HttpMemoryScope; ids?: string[]; topicIds?: string[]; reason?: string; gracePeriodMs?: number };
    if (!body.scope || (!body.ids?.length && !body.topicIds?.length)) throw consoleError(400, "memory.forget_invalid", "scope and ids or topicIds are required");
    const result = await requireMemory().forget({ access: access(request, [body.scope], "memory_admin"), ...body, scope: body.scope });
    return successEnvelope(request, result);
  });

  app.post("/api/v1/admin/memory/restore", { onRequest: authorize }, async (request) => {
    const body = request.body as { scope?: HttpMemoryScope; ids?: string[]; topicIds?: string[] };
    if (!body.scope || (!body.ids?.length && !body.topicIds?.length)) throw consoleError(400, "memory.restore_invalid", "scope and ids or topicIds are required");
    return successEnvelope(request, await requireMemory().restore({ access: access(request, [body.scope], "memory_admin"), scope: body.scope, ids: body.ids, topicIds: body.topicIds }));
  });

  app.post("/api/v1/admin/memory/reindex", { onRequest: authorize }, async (request) => {
    const body = request.body as { scope?: HttpMemoryScope };
    const operation = requireMemory().enqueueReindex;
    if (!operation) throw consoleError(503, "memory.reindex_unavailable", "durable reindex is unavailable");
    if (!body.scope) throw consoleError(400, "memory.scope_required", "scope is required");
    return successEnvelope(request, await operation(access(request, [body.scope], "memory_admin")));
  });

  app.post("/api/v1/admin/memory/reindex/jobs", { onRequest: authorize }, async (request) => {
    const body = request.body as { scopes?: HttpMemoryScope[]; limit?: number };
    const operation = requireMemory().listReindexJobs;
    if (!operation) throw consoleError(503, "memory.reindex_unavailable", "durable reindex is unavailable");
    if (!body.scopes?.length) throw consoleError(400, "memory.scopes_required", "scopes are required");
    return successEnvelope(request, await operation(access(request, body.scopes, "memory_admin"), body.limit));
  });

  app.post("/api/v1/admin/memory/govern", { onRequest: authorize }, async (request) => {
    const body = request.body as { scope?: HttpMemoryScope; id?: string; action?: GovernAction; content?: string; title?: string; reason?: string; resolution?: "accept" | "reject" };
    const operation = requireMemory().govern;
    if (!operation) throw consoleError(503, "memory.governance_unavailable", "memory governance is unavailable");
    if (!body.scope || !body.id || !body.action) throw consoleError(400, "memory.governance_invalid", "scope, id and action are required");
    return successEnvelope(request, await operation({ access: access(request, [body.scope], "memory_admin"), ...body, scope: body.scope, id: body.id, action: body.action }));
  });

  app.post("/api/v1/admin/memory/feedback", { onRequest: authorize }, async (request) => {
    const body = request.body as { scope?: HttpMemoryScope; recordId?: string; signal?: FeedbackSignal; runId?: string; note?: string };
    const operation = requireMemory().feedback;
    if (!operation) throw consoleError(503, "memory.feedback_unavailable", "memory feedback is unavailable");
    if (!body.scope || !body.recordId || !body.signal) throw consoleError(400, "memory.feedback_invalid", "scope, recordId and signal are required");
    const result = await operation(access(request, [body.scope], "memory_admin"), body.scope, body.recordId, body.signal, { runId: body.runId, note: body.note });
    return successEnvelope(request, result);
  });

  app.post("/api/v1/admin/memory/core-snapshot", { onRequest: authorize }, async (request, reply) => {
    const body = request.body as { scope?: HttpMemoryScope; generate?: boolean; markdown?: string };
    const port = requireMemory();
    if (!port.getCoreSnapshot) throw consoleError(503, "memory.snapshot_unavailable", "core snapshot is unavailable");
    if (!body.scope) throw consoleError(400, "memory.scope_required", "scope is required");
    const scoped = access(request, [body.scope], "memory_admin");
    const result = typeof body.markdown === "string" ? await port.updateCoreSnapshot!(scoped, body.markdown)
      : body.generate ? await port.generateCoreSnapshot!(scoped)
      : await withRequestAbortSignal(request, reply, (signal) => port.getCoreSnapshot!(scoped, signal));
    return successEnvelope(request, result);
  });
}
