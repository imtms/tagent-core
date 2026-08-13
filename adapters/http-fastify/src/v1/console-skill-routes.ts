import type { FastifyInstance } from "fastify";
import type { V1ApiDependencies } from "./plugin.js";
import { successEnvelope } from "./errors.js";
import { authorizeConsole, consoleError } from "./console-route-support.js";

function skillError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Session not found") throw consoleError(404, "session.not_found", message);
  if (message === "Skill revision not found") throw consoleError(404, "skill.revision_not_found", message);
  throw consoleError(400, "skill.invalid", message);
}

export function registerConsoleSkillV1Routes(app: FastifyInstance, dependencies: V1ApiDependencies): void {
  const read = authorizeConsole(dependencies, "sessions:read");
  const write = authorizeConsole(dependencies, "sessions:write");

  app.get("/api/v1/console/skills", { onRequest: read }, async (request) =>
    successEnvelope(request, dependencies.service.listSkills()));

  app.get("/api/v1/console/sessions/:id/skill", { onRequest: read }, async (request) => {
    const { id } = request.params as { id: string };
    if (!dependencies.persistence.sessions.getSession(id)) throw consoleError(404, "session.not_found", "session not found");
    return successEnvelope(request, dependencies.service.getSessionSkill(id));
  });

  app.post("/api/v1/console/sessions/:id/skill/upload", {
    onRequest: write,
    bodyLimit: 12 * 1024 * 1024,
  }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { filename?: unknown; contentBase64?: unknown };
    if (typeof body.filename !== "string" || typeof body.contentBase64 !== "string") {
      throw consoleError(400, "skill.upload_invalid", "filename and contentBase64 are required");
    }
    try { return successEnvelope(request, await dependencies.service.uploadSkill(id, { filename: body.filename, contentBase64: body.contentBase64 })); }
    catch (error) { return skillError(error); }
  });

  app.put("/api/v1/console/sessions/:id/skill", { onRequest: write }, async (request) => {
    const { id } = request.params as { id: string };
    const revisionId = (request.body as { revisionId?: unknown } | undefined)?.revisionId;
    if (typeof revisionId !== "string" || !revisionId.trim()) throw consoleError(400, "skill.revision_required", "revisionId is required");
    try { return successEnvelope(request, dependencies.service.bindSessionSkill(id, revisionId)); }
    catch (error) { return skillError(error); }
  });

  app.delete("/api/v1/console/sessions/:id/skill", { onRequest: write }, async (request) => {
    try { return successEnvelope(request, dependencies.service.unbindSessionSkill((request.params as { id: string }).id)); }
    catch (error) { return skillError(error); }
  });
}
