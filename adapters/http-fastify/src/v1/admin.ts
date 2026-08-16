import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  AdminConfigStatusResponseSchema,
  decodeAbi,
  encodeAbi,
  MemoryRecallResponseSchema,
  PrincipalMemoryRecallRequestSchema,
  type MemoryKind,
  type MemoryRecallResult,
} from "@tagent/abi";
import type { HttpMemoryAccess, HttpMemoryScope } from "../ports/index.js";
import { authorizeV1, principalOf } from "./auth.js";
import type { V1ApiDependencies } from "./plugin.js";
import { successEnvelope, V1HttpError } from "./errors.js";
import { registerAdminMemoryConsoleV1Routes } from "./admin-memory-console-routes.js";
import { withRequestAbortSignal } from "./console-route-support.js";
import { registerAdminMemoryProfileV1Routes } from "./admin-memory-profile-routes.js";
import { registerAdminOperationV1Routes } from "./admin-operation-routes.js";

function principalMemoryAccess(
  request: FastifyRequest,
  dependencies: V1ApiDependencies,
  purpose: HttpMemoryAccess["purpose"],
): HttpMemoryAccess {
  const principal = principalOf(request);
  const configuredScope = dependencies.runtimeConfig?.memoryWorkspaceScopeId;
  const scopes: HttpMemoryScope[] = principal.resourceScopes.length
    ? principal.resourceScopes.map((scope) => ({ ...scope }))
    : configuredScope
      ? [{ type: "workspace", id: configuredScope }]
      : [];
  if (!scopes.length) {
    throw new V1HttpError(
      403,
      "auth.resource_scope_required",
      "The authenticated principal has no Memory resource scope",
      "permission_denied",
      false,
      { surface: "admin" },
    );
  }
  return { subjectId: principal.subjectId, scopes, purpose };
}

const memoryKinds = new Set<MemoryKind>(["fact", "preference", "episode", "procedure"]);

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function mapMemoryRecallResult(value: unknown): MemoryRecallResult {
  const result = objectValue(value);
  const cards = Array.isArray(result.cards) ? result.cards : [];
  const items = cards.flatMap((candidate) => {
    const card = objectValue(candidate);
    if (typeof card.id !== "string" || !card.id) return [];
    const rawKind = typeof card.kind === "string" ? card.kind : "fact";
    const kind: MemoryKind = memoryKinds.has(rawKind as MemoryKind)
      ? rawKind as MemoryKind
      : "fact";
    const rawScore = Number(card.score ?? 0);
    return [{
      id: card.id,
      kind,
      title: typeof card.title === "string" ? card.title : "",
      content: typeof card.content === "string"
        ? card.content
        : typeof card.summary === "string"
          ? card.summary
          : "",
      score: Number.isFinite(rawScore) ? Math.min(1, Math.max(0, rawScore)) : 0,
    }];
  });
  return {
    items,
    total: items.length,
    coldTopicCount: Array.isArray(result.coldTopics) ? result.coldTopics.length : 0,
  };
}

export function registerAdminV1Routes(app: FastifyInstance, dependencies: V1ApiDependencies): void {
  const authorize = async (request: FastifyRequest): Promise<void> => {
    authorizeV1(request, dependencies.serviceCredentials, "admin", "admin");
  };

  app.get("/api/v1/admin/config/status", { onRequest: authorize }, async (request) => {
    if (!dependencies.runtimeConfig) {
      throw new V1HttpError(503, "runtime.config_unavailable", "Runtime configuration is unavailable", "unavailable", true);
    }
    return encodeAbi(AdminConfigStatusResponseSchema, successEnvelope(
      request,
      dependencies.runtimeConfig as import("@tagent/abi").AdminConfigStatus,
    ));
  });

  app.post("/api/v1/admin/memory/recall", {
    onRequest: authorize,
    schema: { body: PrincipalMemoryRecallRequestSchema },
  }, async (request, reply) => {
    if (!dependencies.memory) {
      throw new V1HttpError(503, "memory.unavailable", "Memory is unavailable", "unavailable", true);
    }
    const body = decodeAbi(PrincipalMemoryRecallRequestSchema, request.body);
    const result = mapMemoryRecallResult(await withRequestAbortSignal(request, reply, (signal) => dependencies.memory!.recall({
      access: principalMemoryAccess(request, dependencies, "memory_admin"),
      cue: body.cue.trim(),
      kinds: body.kinds,
      maxCards: body.maxCards,
      maxColdTopics: body.maxColdTopics,
    }, signal)));
    return encodeAbi(
      MemoryRecallResponseSchema,
      successEnvelope(request, { result }),
    );
  });

  registerAdminMemoryConsoleV1Routes(app, dependencies);
  registerAdminMemoryProfileV1Routes(app, dependencies);
  registerAdminOperationV1Routes(app, dependencies);

  app.all("/api/v1/admin/*", { onRequest: authorize }, async () => {
    throw new V1HttpError(404, "route.not_found", "Admin v1 route not found", "not_found", false, { surface: "admin" });
  });
}
