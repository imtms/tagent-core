import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  decodeAbi,
  encodeAbi,
  LearningSettingsResponseSchema,
  LearningSettingsUpdateRequestSchema,
  MemoryRecallResponseSchema,
  PrincipalMemoryRecallRequestSchema,
  type LearningSettings,
  type MemoryKind,
  type MemoryRecallResult,
} from "@tagent/abi";
import type { HttpMemoryAccess, HttpMemoryScope } from "../ports/index.js";
import { authorizeV1, principalOf } from "./auth.js";
import type { V1ApiDependencies } from "./plugin.js";
import { successEnvelope, V1HttpError } from "./errors.js";
import { registerAdminLearningConsoleV1Routes } from "./admin-learning-console-routes.js";
import { registerAdminMemoryConsoleV1Routes } from "./admin-memory-console-routes.js";
import { withRequestAbortSignal } from "./console-route-support.js";

function mapLearningSettings(state: Record<string, unknown>): LearningSettings {
  const updatedAt = Number(state.updatedAt ?? 0);
  return {
    memoryAvailable: Boolean(state.memoryAvailable ?? state.memoryEnabled),
    memoryEnabled: Boolean(state.memoryEnabled),
    learningEnabled: Boolean(state.learningEnabled),
    autoExecutionEnabled: Boolean(state.autoExecutionEnabled),
    passiveLearningEnabled: Boolean(state.passiveLearningEnabled ?? state.learningEnabled),
    activeExecutionRequiresApproval: true,
    updatedAt: new Date(Number.isFinite(updatedAt) && updatedAt >= 0 ? updatedAt : 0).toISOString(),
    reason: String(state.reason ?? "learning_control_unavailable"),
  };
}

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

  app.get("/api/v1/admin/learning/settings", { onRequest: authorize }, async (request) => {
    const state = dependencies.learningControl?.snapshot() ?? {
      memoryAvailable: Boolean(dependencies.memory),
      memoryEnabled: Boolean(dependencies.memory),
      learningEnabled: false,
      autoExecutionEnabled: false,
      passiveLearningEnabled: false,
      updatedAt: 0,
      reason: "learning_control_unavailable",
    };
    return encodeAbi(
      LearningSettingsResponseSchema,
      successEnvelope(request, { settings: mapLearningSettings(state) }),
    );
  });

  app.patch("/api/v1/admin/learning/settings", {
    onRequest: authorize,
    schema: { body: LearningSettingsUpdateRequestSchema },
  }, async (request) => {
    if (!dependencies.learningControl) {
      throw new V1HttpError(503, "learning.control_unavailable", "Learning feature control is unavailable", "unavailable", true);
    }
    const body = decodeAbi(LearningSettingsUpdateRequestSchema, request.body);
    const state = await dependencies.service.updateLearningSettings(body) as Record<string, unknown>;
    return encodeAbi(
      LearningSettingsResponseSchema,
      successEnvelope(request, { settings: mapLearningSettings(state) }),
    );
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
  registerAdminLearningConsoleV1Routes(app, dependencies);

  app.all("/api/v1/admin/*", { onRequest: authorize }, async () => {
    throw new V1HttpError(404, "route.not_found", "Admin v1 route not found", "not_found", false, { surface: "admin" });
  });
}
