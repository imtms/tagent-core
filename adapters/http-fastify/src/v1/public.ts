import type { FastifyInstance } from "fastify";
import { successEnvelope, V1HttpError } from "./errors.js";
import type { V1ApiDependencies } from "./plugin.js";

/** Stable public v1 discovery/fallback surface. */
export function registerPublicV1Routes(app: FastifyInstance, dependencies: V1ApiDependencies): void {
  app.get("/api/v1/health", async (request, reply) => {
    const writer = dependencies.writerReadiness ? { ready: dependencies.writerReadiness.isWriterReady() } : undefined;
    const learning = dependencies.learningControl?.snapshot();
    const distillation = dependencies.distillationWorker?.snapshot() ?? { running: false, ready: false };
    const generation = dependencies.generationStatus?.() ?? undefined;
    if (writer && !writer.ready) reply.code(503);
    const data = {
      ok: !writer || writer.ready,
      service: "tagent-core",
      ...(writer ? { writer } : {}),
      ...(generation ? { generation } : {}),
      learning,
      distillation,
    };
    return successEnvelope(request, data);
  });
  app.all("/api/v1", async (request) => {
    throw new V1HttpError(404, "route.not_found", "v1 route not found", "not_found", false, {
      method: request.method,
      path: "/api/v1",
      surface: "public",
    });
  });
  app.all("/api/v1/*", async (request) => {
    throw new V1HttpError(404, "route.not_found", "v1 route not found", "not_found", false, {
      method: request.method,
      path: request.url.split("?")[0],
      surface: "public",
    });
  });
}
