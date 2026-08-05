import type { FastifyInstance } from "fastify";
import type { V1ApiDependencies } from "./plugin.js";
import { successEnvelope, V1HttpError } from "./errors.js";
import { authorizeConsole, consoleError } from "./console-route-support.js";

export function registerConsoleRunV1Routes(app: FastifyInstance, dependencies: V1ApiDependencies): void {
  const { service, persistence, artifacts, workspaceRoot } = dependencies;
  const { contextManifests, evidence, transcript } = persistence;
  const read = authorizeConsole(dependencies, "runs:read");
  const control = authorizeConsole(dependencies, "runs:control");

  app.get("/api/v1/console/task-runs/:id", { onRequest: read }, async (request) => {
    const run = service.getRun((request.params as { id: string }).id);
    if (!run) throw consoleError(404, "task_run.not_found", "TaskRun not found");
    return successEnvelope(request, run);
  });

  app.post("/api/v1/console/task-runs/:id/cancel", { onRequest: control }, async (request) => {
    if (!service.cancel((request.params as { id: string }).id)) throw consoleError(409, "task_run.inactive", "TaskRun is not active");
    return successEnvelope(request, { ok: true });
  });

  app.post("/api/v1/console/task-runs/:id/steer", { onRequest: control }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { content?: string; requestId?: string };
    const content = body?.content?.trim();
    if (!content) throw consoleError(400, "task_run.content_required", "content is required");
    const result = await service.steer(id, content, body.requestId);
    if (result.status !== "accepted") {
      throw consoleError(result.status === "full" ? 429 : 409, `task_run.${result.status}`, `TaskRun command ${result.status}`);
    }
    return successEnvelope(request, { ok: true, ...result });
  });

  app.post("/api/v1/console/task-runs/:id/resume", { onRequest: control }, async (request) => {
    try { return successEnvelope(request, await service.resume((request.params as { id: string }).id)); }
    catch (error) { throw consoleError(409, "task_run.resume_conflict", error instanceof Error ? error.message : String(error)); }
  });

  app.post("/api/v1/console/user-input-requests/:id/submit", { onRequest: control }, async (request) => {
    const { id } = request.params as { id: string };
    const response = (request.body as { response?: Record<string, unknown> })?.response;
    if (!response || typeof response !== "object" || Array.isArray(response)) throw consoleError(400, "user_input.response_required", "response is required");
    try {
      const normalized = Object.fromEntries(Object.entries(response).map(([key, value]) => [key, typeof value === "string" ? value : String(value ?? "")]));
      return successEnvelope(request, await service.submitUserInput(id, normalized));
    } catch (error) {
      throw consoleError(409, "user_input.conflict", error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/v1/console/approval-requests/:id/approve", { onRequest: control }, async (request) => {
    const { id } = request.params as { id: string };
    const resolution = (request.body as { resolution?: string } | undefined)?.resolution?.trim();
    try { return successEnvelope(request, await service.approveRunApproval(id, resolution)); }
    catch (error) { throw consoleError(409, "approval.conflict", error instanceof Error ? error.message : String(error)); }
  });

  app.post("/api/v1/console/approval-requests/:id/reject", { onRequest: control }, async (request) => {
    const { id } = request.params as { id: string };
    const resolution = (request.body as { resolution?: string } | undefined)?.resolution?.trim();
    try { return successEnvelope(request, service.rejectRunApproval(id, resolution)); }
    catch (error) { throw consoleError(409, "approval.conflict", error instanceof Error ? error.message : String(error)); }
  });

  app.get("/api/v1/console/task-runs/:id/context-manifests", { onRequest: read }, async (request) => {
    const { id } = request.params as { id: string };
    if (!service.getRun(id)) throw consoleError(404, "task_run.not_found", "TaskRun not found");
    const limit = Math.min(100, Math.max(1, Number((request.query as { limit?: string }).limit ?? 20) || 20));
    return successEnvelope(request, contextManifests.listContextManifests(id, limit));
  });

  app.get("/api/v1/console/task-runs/:id/transcript", { onRequest: read }, async (request) => {
    const { id } = request.params as { id: string };
    if (!service.getRun(id)) throw consoleError(404, "task_run.not_found", "TaskRun not found");
    return successEnvelope(request, transcript.listTranscriptView(id));
  });

  app.get("/api/v1/console/task-runs/:id/artifacts/:artifactId/content", { onRequest: read }, async (request) => {
    const { id, artifactId } = request.params as { id: string; artifactId: string };
    if (!service.getRun(id)) throw consoleError(404, "task_run.not_found", "TaskRun not found");
    const artifact = evidence.getArtifact(id, artifactId);
    if (!artifact) throw consoleError(404, "artifact.not_found", "artifact not found");
    try {
      const source = await artifacts.loadSource(artifact.content, artifact.uri, workspaceRoot);
      if (!artifacts.isText(artifact.kind, artifact.title, artifact.uri, source.content)) throw consoleError(415, "artifact.unsupported", "artifact is not text");
      return successEnvelope(request, {
        id: artifact.id,
        title: artifact.title,
        kind: artifact.kind,
        uri: artifact.uri,
        content: source.content,
        format: artifacts.isMarkdown(artifact.kind, artifact.title, artifact.uri) ? "markdown" : "text",
        bytes: Buffer.byteLength(source.content),
        source: source.source,
      });
    } catch (error) {
      if (error instanceof V1HttpError) throw error;
      throw artifactError(error);
    }
  });

  app.get("/api/v1/console/task-runs/:id/artifacts/:artifactId/download", { onRequest: read }, async (request, reply) => {
    const { id, artifactId } = request.params as { id: string; artifactId: string };
    if (!service.getRun(id)) throw consoleError(404, "task_run.not_found", "TaskRun not found");
    const artifact = evidence.getArtifact(id, artifactId);
    if (!artifact) throw consoleError(404, "artifact.not_found", "artifact not found");
    try {
      const source = await artifacts.loadDownload(artifact.content, artifact.uri, workspaceRoot);
      reply.header("Content-Type", "application/octet-stream");
      reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(artifacts.filename(artifact.title, artifact.uri))}`);
      return reply.send(source.buffer);
    } catch (error) {
      throw artifactError(error);
    }
  });
}

function artifactError(error: unknown): V1HttpError {
  const cause = error as NodeJS.ErrnoException & { code?: string };
  if (cause.code === "ENOENT") return consoleError(404, "artifact.not_found", "artifact not found");
  if (cause.code === "EACCES" || cause.code === "EISDIR") return consoleError(422, "artifact.unreadable", cause.message);
  if (cause.code === "ARTIFACT_PATH_REJECTED") return consoleError(400, "artifact.path_rejected", cause.message);
  return consoleError(500, "artifact.unavailable", "artifact could not be read");
}
