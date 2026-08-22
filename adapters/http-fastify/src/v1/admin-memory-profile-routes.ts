import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  AdminMemoryCaptureRequestSchema,
  AdminMemoryForgetRequestSchema,
  AdminMemoryGovernRequestSchema,
  AdminMemoryRecordsResponseSchema,
  AdminMemoryStatusResponseSchema,
  decodeAbi,
  encodeAbi,
  MemoryRecallResponseSchema,
  PrincipalMemoryRecallRequestSchema,
  ProfileOperationResponseSchema,
  type AdminMemoryRecord,
  type MemoryKind,
  type MemoryRecallResult,
} from "@tagent/abi";
import type { HttpMemoryAccess, HttpMemoryScope } from "../ports/index.js";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { principalOf } from "./auth.js";
import { successEnvelope, V1HttpError } from "./errors.js";
import { withRequestAbortSignal } from "./console-route-support.js";
import { decodeProfileCursor, encodeProfileCursor, encodeProfileSnapshot } from "./profile-cursor.js";
import { assertProfileResourceScope, authorizeProfile, profileListQuery } from "./profile-route-support.js";
import { profileRevision, runAdminProfileOperation } from "./profile-operation-support.js";

const memoryKinds = new Set<MemoryKind>(["fact", "preference", "episode", "procedure"]);

function memory(dependencies: ChannelV1Dependencies) {
  if (!dependencies.memory) throw new V1HttpError(503, "memory.unavailable", "Memory is unavailable", "unavailable", true);
  return dependencies.memory;
}

function access(request: FastifyRequest, scopes: HttpMemoryScope[], purpose: HttpMemoryAccess["purpose"]): HttpMemoryAccess {
  const principal = principalOf(request);
  for (const scope of scopes) assertProfileResourceScope(request, scope.type, scope.id);
  return { subjectId: principal.subjectId, scopes, purpose };
}

function principalAccess(request: FastifyRequest, purpose: HttpMemoryAccess["purpose"]): HttpMemoryAccess {
  const principal = principalOf(request);
  if (!principal.localAdmin && !principal.resourceScopes.length) {
    throw new V1HttpError(403, "auth.resource_scope_required", "The authenticated principal has no Memory resource scope", "permission_denied");
  }
  const scopes = principal.localAdmin ? [{ type: "workspace" as const, id: "*" }] : principal.resourceScopes;
  return { subjectId: principal.subjectId, scopes: scopes.map((scope) => ({ ...scope })), purpose };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function recallResult(value: unknown): MemoryRecallResult {
  const result = object(value);
  const cards = Array.isArray(result.cards) ? result.cards : [];
  const items = cards.flatMap((candidate) => {
    const card = object(candidate);
    if (typeof card.id !== "string" || !card.id) return [];
    const rawKind = typeof card.kind === "string" ? card.kind : "fact";
    const kind = memoryKinds.has(rawKind as MemoryKind) ? rawKind as MemoryKind : "fact";
    const score = Number(card.score ?? 0);
    return [{
      id: card.id,
      kind,
      title: typeof card.title === "string" ? card.title.slice(0, 500) : "",
      content: typeof card.content === "string" ? card.content.slice(0, 200_000) : "",
      score: Number.isFinite(score) ? Math.min(1, Math.max(0, score)) : 0,
    }];
  });
  return { items, total: items.length, coldTopicCount: Array.isArray(result.coldTopics) ? result.coldTopics.length : 0 };
}

function mapRecord(value: unknown): AdminMemoryRecord | undefined {
  const record = object(value);
  if (typeof record.id !== "string" || !record.id) return undefined;
  const scope = object(record.scope);
  if (!["user", "workspace", "project", "session"].includes(String(scope.type)) || typeof scope.id !== "string") return undefined;
  const kind = memoryKinds.has(record.kind as MemoryKind) ? record.kind as MemoryKind : "fact";
  const createdAt = Number(record.createdAt ?? 0);
  const updatedAt = Number(record.updatedAt ?? createdAt);
  const confidence = Number(record.confidence ?? 0);
  const refs = Array.isArray(record.sourceRefs) ? record.sourceRefs : [];
  return {
    id: record.id,
    kind,
    tier: record.tier === "warm" ? "warm" : "hot",
    scope: { type: scope.type as AdminMemoryRecord["scope"]["type"], id: scope.id },
    title: String(kind === "preference" ? record.dimension ?? "" : record.title ?? "").slice(0, 500),
    content: String(kind === "preference" ? record.value ?? "" : record.content ?? "").slice(0, 200_000),
    summary: String(record.summary ?? "").slice(0, 5_000),
    status: (["candidate", "active", "stale", "superseded", "disputed", "quarantined", "deleted"].includes(String(record.status))
      ? record.status : "candidate") as AdminMemoryRecord["status"],
    confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0,
    sourceRefs: refs.slice(0, 100).map((candidate) => {
      const ref = object(candidate);
      return {
        sourceType: String(ref.sourceType ?? "unknown").slice(0, 64),
        sourceRef: createHash("sha256").update(String(ref.sourceId ?? "")).digest("hex").slice(0, 32),
      };
    }),
    resourceRevision: profileRevision(updatedAt),
    createdAt: new Date(Math.max(0, createdAt)).toISOString(),
    updatedAt: new Date(Math.max(0, updatedAt)).toISOString(),
  };
}

export function registerAdminMemoryProfileV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): void {
  const read = authorizeProfile(dependencies, "admin:memory:read", "admin");
  const write = authorizeProfile(dependencies, "admin:memory:write", "admin");

  app.get("/api/v1/admin/profiles/memory/status", { onRequest: read }, async (request) => {
    const port = memory(dependencies);
    const readiness = await port.readiness(principalAccess(request, "memory_admin"));
    return encodeAbi(AdminMemoryStatusResponseSchema, successEnvelope(request, {
      status: { available: true, ready: Boolean(readiness.ready), degraded: Boolean(readiness.degraded),
        reasons: readiness.reasons.map((reason) => String(reason).slice(0, 500)).slice(0, 50) },
    }));
  });

  app.post("/api/v1/admin/profiles/memory/recall", {
    onRequest: read,
    schema: { body: PrincipalMemoryRecallRequestSchema },
  }, async (request, reply) => {
    const body = decodeAbi(PrincipalMemoryRecallRequestSchema, request.body);
    const result = recallResult(await withRequestAbortSignal(request, reply, (signal) => memory(dependencies).recall({
      access: principalAccess(request, "memory_admin"), cue: body.cue.trim(), kinds: body.kinds,
      maxCards: body.maxCards, maxColdTopics: body.maxColdTopics,
    }, signal)));
    return encodeAbi(MemoryRecallResponseSchema, successEnvelope(request, { result }));
  });

  app.get("/api/v1/admin/profiles/memory/records", { onRequest: read }, async (request) => {
    const raw = request.query as { scopeType?: unknown; scopeId?: unknown };
    if (!["user", "workspace", "project", "session"].includes(String(raw.scopeType))
      || typeof raw.scopeId !== "string" || !raw.scopeId || raw.scopeId.length > 256) {
      throw new V1HttpError(400, "request.validation_failed", "scopeType and scopeId are required", "validation");
    }
    const scope = { type: raw.scopeType as HttpMemoryScope["type"], id: raw.scopeId };
    const query = profileListQuery(request);
    const limit = query.limit ?? 50;
    const resourceId = `${scope.type}:${scope.id}`;
    const state: { snapshotRowId?: number; after?: { createdAt: number; id: string } } = query.cursor
      ? decodeProfileCursor(query.cursor, { kind: "admin_collection", resourceId }) : {};
    const page = object(await memory(dependencies).listRecordsPage(
      access(request, [scope], "memory_admin"), scope, {
        snapshotCreatedAt: state.snapshotRowId,
        after: state.after,
        limit: limit + 1,
      },
    ));
    const all = (Array.isArray(page.records) ? page.records : []).map(mapRecord)
      .filter((item): item is AdminMemoryRecord => Boolean(item));
    const snapshotRowId = Number(page.snapshotCreatedAt ?? state.snapshotRowId ?? 0);
    const items = all.slice(0, limit);
    const hasMore = all.length > limit;
    const last = items.at(-1);
    return encodeAbi(AdminMemoryRecordsResponseSchema, successEnvelope(request, {
      items,
      pageInfo: {
        nextCursor: hasMore && last ? encodeProfileCursor({ kind: "admin_collection", resourceId, snapshotRowId,
          after: { createdAt: Date.parse(last.createdAt), id: last.id } }) : null,
        hasMore, limit,
        snapshot: encodeProfileSnapshot({ kind: "admin_collection", resourceId, snapshotRowId }),
      },
    }));
  });

  app.post("/api/v1/admin/profiles/memory/captures", {
    onRequest: write,
    schema: { body: AdminMemoryCaptureRequestSchema },
  }, async (request, reply) => {
    const body = decodeAbi(AdminMemoryCaptureRequestSchema, request.body);
    const scoped = access(request, [body.scope], "capture");
    const operation = await runAdminProfileOperation(request, reply, dependencies, {
      profileId: "admin.memory.v1", endpointId: "admin.memory.capture", resourceType: "memory_scope",
      resourceId: body.scope.id, operation: "capture", payload: body,
      effect: async () => object(await memory(dependencies).enqueueCapture({
        access: scoped,
        sourceRefs: [{ sourceType: "manual", sourceId: `profile:${principalOf(request).subjectId}` }],
        content: body.content.trim(),
        idempotencyKey: request.headers["idempotency-key"],
        captureSource: { kind: "manual_input", role: "user", explicitIntent: true },
      })),
    });
    return encodeAbi(ProfileOperationResponseSchema, successEnvelope(request, { operation }));
  });

  app.post("/api/v1/admin/profiles/memory/records/:memoryId/govern", {
    onRequest: write,
    schema: { body: AdminMemoryGovernRequestSchema },
  }, async (request, reply) => {
    const memoryId = (request.params as { memoryId: string }).memoryId;
    const body = decodeAbi(AdminMemoryGovernRequestSchema, request.body);
    const port = memory(dependencies);
    if (!port.govern) throw new V1HttpError(503, "memory.governance_unavailable", "Memory governance is unavailable", "unavailable", true);
    const scoped = access(request, [body.scope], "memory_admin");
    const operation = await runAdminProfileOperation(request, reply, dependencies, {
      profileId: "admin.memory.v1", endpointId: "admin.memory.govern", resourceType: "memory", resourceId: memoryId,
      operation: "govern", payload: { memoryId, ...body },
      effect: async () => object(await port.govern!({ ...body, access: scoped, scope: body.scope, id: memoryId })),
    });
    return encodeAbi(ProfileOperationResponseSchema, successEnvelope(request, { operation }));
  });

  app.delete("/api/v1/admin/profiles/memory/records/:memoryId", {
    onRequest: write,
    schema: { body: AdminMemoryForgetRequestSchema },
  }, async (request, reply) => {
    const memoryId = (request.params as { memoryId: string }).memoryId;
    const body = decodeAbi(AdminMemoryForgetRequestSchema, request.body);
    const scoped = access(request, [body.scope], "memory_admin");
    const operation = await runAdminProfileOperation(request, reply, dependencies, {
      profileId: "admin.memory.v1", endpointId: "admin.memory.forget", resourceType: "memory", resourceId: memoryId,
      operation: "forget", payload: { memoryId, ...body },
      effect: async () => object(await memory(dependencies).forget({
        access: scoped, scope: body.scope, ids: [memoryId], reason: body.reason, gracePeriodMs: body.gracePeriodMs,
      })),
    });
    return encodeAbi(ProfileOperationResponseSchema, successEnvelope(request, { operation }));
  });
}
