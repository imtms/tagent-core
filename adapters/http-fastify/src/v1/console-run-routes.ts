import type { FastifyInstance } from "fastify";
import type { V1ApiDependencies } from "./dependencies.js";
import { successEnvelope } from "./errors.js";
import { authorizeConsole, consoleError } from "./console-route-support.js";

export function registerConsoleRunV1Routes(app: FastifyInstance, dependencies: V1ApiDependencies): void {
  const { persistence } = dependencies;
  const { contextManifests, taskRuns } = persistence;
  const read = authorizeConsole(dependencies, "runs:read");
  app.get("/api/v1/console/task-runs/:id/context-manifests", { onRequest: read }, async (request) => {
    const { id } = request.params as { id: string };
    if (!taskRuns.hasRun(id)) throw consoleError(404, "task_run.not_found", "TaskRun not found");
    const limit = Math.min(100, Math.max(1, Number((request.query as { limit?: string }).limit ?? 20) || 20));
    return successEnvelope(request, contextManifests.listContextManifests(id, limit));
  });

}
