import type { FastifyInstance } from "fastify";
import type { V1ApiDependencies } from "./plugin.js";
import { successEnvelope } from "./errors.js";
import { authorizeConsole, consoleError } from "./console-route-support.js";

function skillError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "Session not found") throw consoleError(404, "session.not_found", message);
  if (message === "Skill not found") throw consoleError(404, "skill.not_found", message);
  if (message.includes("already exists")) throw consoleError(409, "skill.name_conflict", message);
  throw consoleError(400, "skill.invalid", message);
}

export function registerConsoleSkillV1Routes(app: FastifyInstance, dependencies: V1ApiDependencies): void {
  const read = authorizeConsole(dependencies, "sessions:read");
  const write = authorizeConsole(dependencies, "sessions:write");

  app.get("/api/v1/console/skills", { onRequest: read }, async (request) =>
    successEnvelope(request, dependencies.service.listSkills()));

  app.get("/api/v1/console/skills/:id", { onRequest: read }, async (request) => {
    try { return successEnvelope(request, dependencies.service.getSkill((request.params as { id: string }).id)); }
    catch (error) { return skillError(error); }
  });

  app.get("/api/v1/console/skills/:id/revisions", { onRequest: read }, async (request) => {
    try { return successEnvelope(request, dependencies.service.listSkillRevisions((request.params as { id: string }).id)); }
    catch (error) { return skillError(error); }
  });

  app.post("/api/v1/console/skills", { onRequest: write, bodyLimit: 12 * 1024 * 1024 }, async (request) => {
    const body = (request.body ?? {}) as { filename?: unknown; contentBase64?: unknown };
    if (typeof body.filename !== "string" || typeof body.contentBase64 !== "string") {
      throw consoleError(400, "skill.upload_invalid", "filename and contentBase64 are required");
    }
    try { return successEnvelope(request, await dependencies.service.uploadSkill({ filename: body.filename, contentBase64: body.contentBase64 })); }
    catch (error) { return skillError(error); }
  });

  app.patch("/api/v1/console/skills/:id", { onRequest: write, bodyLimit: 768 * 1024 }, async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.name !== "string" || typeof body.description !== "string" || typeof body.content !== "string"
      || (body.disableModelInvocation !== undefined && typeof body.disableModelInvocation !== "boolean")) {
      throw consoleError(400, "skill.update_invalid", "name, description, and content are required");
    }
    try {
      return successEnvelope(request, await dependencies.service.updateSkill((request.params as { id: string }).id, {
        name: body.name, description: body.description, content: body.content,
        disableModelInvocation: body.disableModelInvocation as boolean | undefined,
      }));
    } catch (error) { return skillError(error); }
  });

  app.delete("/api/v1/console/skills/:id", { onRequest: write }, async (request) => {
    try { return successEnvelope(request, dependencies.service.deleteSkill((request.params as { id: string }).id)); }
    catch (error) { return skillError(error); }
  });

  app.get("/api/v1/console/workspaces/:id/skills", { onRequest: read }, async (request) => {
    try { return successEnvelope(request, dependencies.service.listWorkspaceSkills((request.params as { id: string }).id)); }
    catch (error) { return skillError(error); }
  });

  app.put("/api/v1/console/workspaces/:id/skills", { onRequest: write }, async (request) => {
    const skillIds = (request.body as { skillIds?: unknown } | undefined)?.skillIds;
    if (!Array.isArray(skillIds) || skillIds.some((id) => typeof id !== "string" || !id.trim())) {
      throw consoleError(400, "skill.references_invalid", "skillIds must be an array of Skill ids");
    }
    try { return successEnvelope(request, dependencies.service.replaceWorkspaceSkills((request.params as { id: string }).id, skillIds as string[])); }
    catch (error) { return skillError(error); }
  });
}
