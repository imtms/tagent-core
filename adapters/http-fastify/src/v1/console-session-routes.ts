import type { FastifyInstance } from "fastify";
import type { V1ApiDependencies } from "./plugin.js";
import { successEnvelope } from "./errors.js";
import { authorizeConsole, consoleError } from "./console-route-support.js";

function paginationLimit(value: string | undefined, fallback: number): number {
  if (value == null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1 || parsed > 200) {
    throw consoleError(400, "pagination.limit_invalid", "limit must be an integer between 1 and 200");
  }
  return parsed;
}

export function registerConsoleSessionV1Routes(app: FastifyInstance, dependencies: V1ApiDependencies): void {
  const { sessions } = dependencies.persistence;
  const read = authorizeConsole(dependencies, "sessions:read");

  app.get("/api/v1/console/sessions/:id/messages", { onRequest: read }, async (request) => {
    const { id } = request.params as { id: string };
    if (!sessions.getSession(id)) throw consoleError(404, "session.not_found", "session not found");
    const query = request.query as { limit?: string; beforeId?: string };
    const limit = paginationLimit(query.limit, 80);
    const beforeId = query.beforeId == null ? undefined : Number(query.beforeId);
    if (beforeId != null && (!Number.isFinite(beforeId) || beforeId <= 0)) throw consoleError(400, "message.before_id_invalid", "beforeId must be positive");
    return successEnvelope(request, sessions.listMessages(id, limit, beforeId));
  });

  app.post("/api/v1/console/sessions/:id/inbox/:itemId/parallel-start-request", { onRequest: authorizeConsole(dependencies, "workflows:govern") }, async (request) => {
    const { id, itemId } = request.params as { id: string; itemId: string };
    const body = (request.body ?? {}) as { actor?: string; reason?: string };
    try { return successEnvelope(request, dependencies.service.requestParallelSessionInputApproval(id, itemId, body.actor ?? "session_governor", body.reason)); }
    catch (error) { throw consoleError(409, "inbox.approval_conflict", error instanceof Error ? error.message : String(error)); }
  });

}
