import type { FastifyInstance } from "fastify";
import { canonicalizeSessionCreateRequest, canonicalizeSubmissionRequest } from "@tagent/abi";
import type { V1ApiDependencies } from "./plugin.js";
import { successEnvelope } from "./errors.js";
import { authorizeConsole, consoleError } from "./console-route-support.js";
import { principalOf } from "./auth.js";

function opaqueAutomationMarker(content: string): boolean {
  return /^(?:(?:final-)?ui-sync|release)-[a-z0-9._-]*\d{10,}$/i.test(content) && !/[\s：:，,。.!?？]/.test(content);
}

function paginationLimit(value: string | undefined, fallback: number): number {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw consoleError(400, "pagination.limit_invalid", "limit must be an integer between 1 and 200");
  }
  return parsed;
}

export function registerConsoleSessionV1Routes(app: FastifyInstance, dependencies: V1ApiDependencies): void {
  const { sessions, submissions, taskRuns } = dependencies.persistence;
  const { service } = dependencies;
  const read = authorizeConsole(dependencies, "sessions:read");
  const write = authorizeConsole(dependencies, "sessions:write");
  const control = authorizeConsole(dependencies, "runs:control");

  app.get("/api/v1/console/sessions", { onRequest: read }, async (request) =>
    successEnvelope(request, sessions.listSessions()));

  app.post("/api/v1/console/sessions", { onRequest: write }, async (request) => {
    const body = (request.body ?? {}) as { title?: string; requestId?: string };
    if (body.requestId != null && (typeof body.requestId !== "string" || !body.requestId.trim() || body.requestId.length > 300)) {
      throw consoleError(400, "session.request_id_invalid", "requestId is invalid");
    }
    const title = body.title?.trim() || "New workspace";
    const result = sessions.createSessionIdempotent({
      title,
      principalId: principalOf(request).subjectId,
      idempotencyKey: body.requestId?.trim() || request.id,
      canonicalPayload: canonicalizeSessionCreateRequest({ title }),
      provenance: { surface: "web_console" },
    });
    return successEnvelope(request, result.session);
  });

  app.patch("/api/v1/console/sessions/:id", { onRequest: write }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { title?: unknown; modelId?: unknown; reasoningEffort?: unknown };
    const settings: { title?: string; modelId?: string; reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max" } = {};
    if (body.title !== undefined) {
      if (typeof body.title !== "string" || !body.title.trim() || body.title.length > 256) throw consoleError(400, "session.title_invalid", "title must be a non-empty string of at most 256 characters");
      settings.title = body.title.trim();
    }
    if (body.modelId !== undefined) {
      if (typeof body.modelId !== "string" || !body.modelId.trim()) throw consoleError(400, "session.model_invalid", "modelId must be a non-empty string");
      const runtime = dependencies.runtimeConfig as { modelId?: unknown; fallbackModelIds?: unknown } | undefined;
      const allowed = [runtime?.modelId, ...(Array.isArray(runtime?.fallbackModelIds) ? runtime.fallbackModelIds : [])]
        .filter((value): value is string => typeof value === "string" && Boolean(value));
      if (!allowed.includes(body.modelId.trim())) throw consoleError(400, "session.model_not_allowed", "modelId is not configured for this Core");
      settings.modelId = body.modelId.trim();
    }
    if (body.reasoningEffort !== undefined) {
      const allowed = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
      if (typeof body.reasoningEffort !== "string" || !allowed.includes(body.reasoningEffort as typeof allowed[number])) throw consoleError(400, "session.reasoning_effort_invalid", "reasoningEffort is invalid");
      settings.reasoningEffort = body.reasoningEffort as typeof allowed[number];
    }
    if (!Object.keys(settings).length) throw consoleError(400, "session.settings_required", "at least one session setting is required");
    const session = sessions.updateSession(id, settings);
    if (!session) throw consoleError(404, "session.not_found", "session not found");
    return successEnvelope(request, session);
  });

  app.get("/api/v1/console/sessions/:id/messages", { onRequest: read }, async (request) => {
    const { id } = request.params as { id: string };
    if (!sessions.getSession(id)) throw consoleError(404, "session.not_found", "session not found");
    const query = request.query as { limit?: string; beforeId?: string };
    const limit = paginationLimit(query.limit, 80);
    const beforeId = query.beforeId == null ? undefined : Number(query.beforeId);
    if (beforeId != null && (!Number.isFinite(beforeId) || beforeId <= 0)) throw consoleError(400, "message.before_id_invalid", "beforeId must be positive");
    return successEnvelope(request, sessions.listMessages(id, limit, beforeId));
  });

  app.get("/api/v1/console/sessions/:id/task-runs", { onRequest: read }, async (request) => {
    const { id } = request.params as { id: string };
    if (!sessions.getSession(id)) throw consoleError(404, "session.not_found", "session not found");
    const limit = paginationLimit((request.query as { limit?: string }).limit, 50);
    return successEnvelope(request, taskRuns.listRunSummaries?.(id, limit) ?? taskRuns.listRuns(id, limit));
  });

  app.get("/api/v1/console/sessions/:id/task-run", { onRequest: read }, async (request) =>
    successEnvelope(request, taskRuns.getLatestRun((request.params as { id: string }).id) ?? null));

  app.post("/api/v1/console/sessions/:id/messages", { onRequest: write }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { content?: string; requestId?: string };
    const content = body?.content?.trim();
    if (!content) throw consoleError(400, "submission.content_required", "content is required");
    if (opaqueAutomationMarker(content)) throw consoleError(422, "submission.non_actionable", "opaque automation marker is not executable");
    if (!sessions.getSession(id)) throw consoleError(404, "session.not_found", "session not found");
    try {
      const result = await service.enqueueSessionInput(id, content, body.requestId, {
        principalId: principalOf(request).subjectId,
        canonicalPayload: canonicalizeSubmissionRequest({ content }),
        provenance: { surface: "web_console" },
      });
      return successEnvelope(request, result);
    } catch (error) {
      if (error instanceof Error && error.message.toLowerCase().includes("idempotency conflict")) {
        throw consoleError(409, "submission.idempotency_conflict", "requestId was already used with a different payload");
      }
      throw error;
    }
  });

  app.get("/api/v1/console/sessions/:id/inbox", { onRequest: read }, async (request) => {
    const { id } = request.params as { id: string };
    if (!sessions.getSession(id)) throw consoleError(404, "session.not_found", "session not found");
    return successEnvelope(request, submissions.listSessionInbox(id));
  });

  app.put("/api/v1/console/sessions/:id/inbox/order", { onRequest: write }, async (request) => {
    const { id } = request.params as { id: string };
    const itemIds = (request.body as { itemIds?: string[] })?.itemIds;
    if (!Array.isArray(itemIds) || itemIds.some((itemId) => typeof itemId !== "string" || !itemId)) throw consoleError(400, "inbox.order_invalid", "itemIds must be ids");
    const items = service.reorderSessionInputs(id, itemIds);
    if (!items) throw consoleError(409, "inbox.changed", "queued prompts changed");
    return successEnvelope(request, items);
  });

  app.patch("/api/v1/console/sessions/:id/inbox/:itemId", { onRequest: write }, async (request) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const content = (request.body as { content?: string })?.content?.trim();
    if (!content) throw consoleError(400, "inbox.content_required", "content is required");
    const item = await service.updateSessionInput(id, itemId, content);
    if (!item) throw consoleError(409, "inbox.not_queued", "inbox item is not queued");
    return successEnvelope(request, item);
  });

  app.post("/api/v1/console/sessions/:id/inbox/:itemId/start", { onRequest: control }, async (request) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const result = service.startSessionInputNow(id, itemId);
    if (result.status !== "started") throw consoleError(result.status === "failed" ? 500 : 409, `inbox.${result.status}`, `inbox TaskRun start ${result.status}`);
    return successEnvelope(request, result);
  });

  app.post("/api/v1/console/sessions/:id/inbox/:itemId/decision", { onRequest: write }, async (request) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const decision = (request.body as { decision?: "pending" | "defer" })?.decision;
    if (!decision || !["pending", "defer"].includes(decision)) throw consoleError(400, "inbox.decision_invalid", "invalid decision");
    if (!service.decideSessionInput(id, itemId, decision)) throw consoleError(409, "inbox.not_queued", "inbox item is not queued");
    return successEnvelope(request, { ok: true });
  });

  app.post("/api/v1/console/sessions/:id/inbox/:itemId/merge", { onRequest: write }, async (request) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const targetId = (request.body as { targetId?: string })?.targetId;
    if (!targetId) throw consoleError(400, "inbox.target_required", "targetId is required");
    if (!service.mergeSessionInputs(id, itemId, targetId)) throw consoleError(409, "inbox.not_mergeable", "items are not mergeable");
    return successEnvelope(request, { ok: true });
  });

  app.delete("/api/v1/console/sessions/:id/inbox/:itemId", { onRequest: write }, async (request) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    if (!service.deleteSessionInput(id, itemId)) throw consoleError(409, "inbox.not_queued", "inbox item is not queued");
    return successEnvelope(request, { ok: true });
  });

  app.post("/api/v1/console/sessions/:id/inbox/:itemId/parallel-start-request", { onRequest: authorizeConsole(dependencies, "workflows:govern") }, async (request) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const body = (request.body ?? {}) as { actor?: string; reason?: string };
    try { return successEnvelope(request, service.requestParallelSessionInputApproval(id, itemId, body.actor ?? "session_governor", body.reason)); }
    catch (error) { throw consoleError(409, "inbox.approval_conflict", error instanceof Error ? error.message : String(error)); }
  });

  app.post("/api/v1/console/task-runs/:id/retry-launch", { onRequest: control }, async (request) => {
    const result = service.retryInboxLaunch((request.params as { id: string }).id);
    if (result.status !== "started") throw consoleError(result.status === "failed" ? 500 : 409, `task_run.${result.status}`, `TaskRun retry ${result.status}`);
    return successEnvelope(request, result);
  });
}
