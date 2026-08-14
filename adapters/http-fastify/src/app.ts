import Fastify from "fastify";
import { unavailableArtifactContent } from "./artifacts.js";
import type { AppDependencies } from "./dependencies.js";
import { v1ApiPlugin } from "./v1/plugin.js";
import { ensureRequestId, errorEnvelope, V1HttpError } from "./v1/errors.js";

export type { AppDependencies } from "./dependencies.js";

/** API-only composition root for channel, admin, and internal v1 surfaces. */
export function createApp({
  persistence,
  service,
  workspaceRoot = process.cwd(),
  logger = true,
  runtimeConfig,
  serviceCredentials = [],
  memory,
  artifacts = unavailableArtifactContent,
  closeResources,
  distillationWorker,
  learningControl,
  writerReadiness,
  onClose,
}: AppDependencies) {
  const corsAllowedOrigins = allowedCorsOrigins(process.env.TAGENT_CORS_ALLOWED_ORIGINS);
  if (corsAllowedOrigins.size > 0 && serviceCredentials.length === 0) {
    throw new Error("TAGENT_CORS_ALLOWED_ORIGINS requires at least one Core service credential");
  }
  const app = Fastify({ logger });

  app.addHook("onRequest", async (request, reply) => {
    const pathname = request.url.split("?")[0];
    if (!pathname.startsWith("/api/") && pathname !== "/api/v1") return;
    const origin = request.headers.origin;
    if (!origin) return;
    if (!corsAllowedOrigins.has(origin)) {
      if (pathname === "/api/v1" || pathname.startsWith("/api/v1/")) {
        const error = new V1HttpError(403, "cors.origin_denied", "Cross-origin request is not allowed", "permission_denied");
        ensureRequestId(request, reply);
        return reply.code(error.statusCode).send(errorEnvelope(request, error));
      }
      return reply.code(403).send({ error: "cross-origin request is not allowed", code: "cors_origin_denied" });
    }
    reply.header("Access-Control-Allow-Origin", origin);
    reply.header("Vary", "Origin");
    reply.header("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, If-Match, X-Request-Id, X-TAgent-Delegated-Actor, X-TAgent-Delegated-Request-Id");
    reply.header("Access-Control-Expose-Headers", "Deprecation, ETag, Idempotency-Replayed, Link, X-Request-Id");
    if (request.method === "OPTIONS") return reply.code(204).send();
  });

  app.register(v1ApiPlugin, {
    persistence,
    service,
    workspaceRoot,
    serviceCredentials,
    artifacts,
    memory,
    runtimeConfig,
    learningControl,
    writerReadiness,
    distillationWorker,
  });
  app.addHook("onClose", async () => {
    if (onClose) return onClose();
    await service.closeRuntimes();
    await closeResources?.();
  });
  return app;
}

function allowedCorsOrigins(configured: string | undefined): Set<string> {
  if (configured === undefined || configured.trim() === "") return new Set();
  return new Set(configured.split(",").map((entry, index) => {
    const candidate = entry.trim();
    const comparable = candidate.endsWith("/") ? candidate.slice(0, -1) : candidate;
    let parsed: URL;
    try { parsed = new URL(candidate); }
    catch { throw new Error(`Invalid TAGENT_CORS_ALLOWED_ORIGINS entry at index ${index}`); }
    if (!candidate
      || !["http:", "https:"].includes(parsed.protocol)
      || parsed.origin === "null"
      || parsed.username
      || parsed.password
      || parsed.pathname !== "/"
      || parsed.search
      || parsed.hash
      || comparable !== parsed.origin) {
      throw new Error(`Invalid TAGENT_CORS_ALLOWED_ORIGINS entry at index ${index}`);
    }
    return parsed.origin;
  }));
}
