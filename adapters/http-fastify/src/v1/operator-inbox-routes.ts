import type { FastifyInstance } from "fastify";
import {
  decodeAbi,
  encodeAbi,
  OperatorInboxDecisionRequestSchema,
  OperatorInboxItemParamsSchema,
  OperatorInboxItemResponseSchema,
  OperatorInboxListResponseSchema,
  OperatorInboxMergeRequestSchema,
  OperatorInboxMutationResponseSchema,
  OperatorInboxParamsSchema,
  OperatorInboxReorderRequestSchema,
  OperatorInboxUpdateRequestSchema,
  type OperatorInboxItem,
} from "@tagent/abi";
import type { ProfileInboxItemRecord } from "@tagent/admission/ports";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { successEnvelope, V1HttpError } from "./errors.js";
import { decodeProfileCursor, encodeProfileCursor, encodeProfileSnapshot } from "./profile-cursor.js";
import { registerOperatorInboxOperationV1Routes } from "./operator-inbox-operation-routes.js";
import {
  assertProfileResourceScope,
  authorizeProfile,
  profileListQuery,
  profileMutationContext,
  profileMutationHeaders,
  profileMutationValue,
  setRevisionEtag,
} from "./profile-route-support.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function mapItem(item: ProfileInboxItemRecord): OperatorInboxItem {
  return {
    id: item.id,
    sessionId: item.sessionId,
    content: item.content,
    status: item.status,
    decision: item.decision,
    runId: item.runId,
    position: item.position,
    summary: item.summary.slice(0, 500),
    intent: item.intent,
    targetRunId: item.targetRunId,
    priority: item.priority,
    urgency: item.urgency,
    relation: item.relation,
    acceptanceCriteria: item.acceptanceCriteria,
    confidence: item.confidence,
    reason: item.reason ? "Classified by Core" : "",
    gateProfile: item.executionPolicy?.gateProfile ?? "strict",
    revision: item.revision,
    createdAt: new Date(item.createdAt).toISOString(),
    updatedAt: new Date(item.updatedAt).toISOString(),
  };
}

export function registerOperatorInboxV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): void {
  const read = authorizeProfile(dependencies, "operator:inbox:read", "operator");
  const write = authorizeProfile(dependencies, "operator:inbox:write", "operator");

  app.get("/api/v1/operator/sessions/:sessionId/inbox", {
    onRequest: read,
    schema: { params: OperatorInboxParamsSchema },
  }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    assertProfileResourceScope(request, "session", sessionId);
    const query = profileListQuery(request, MAX_LIMIT);
    const limit = query.limit ?? DEFAULT_LIMIT;
    const state = query.cursor ? decodeProfileCursor(query.cursor, { kind: "session_inbox", resourceId: sessionId }) : {};
    const page = dependencies.persistence.profileContracts.listInboxPage(sessionId, { ...state, limit: limit + 1 });
    if (!page) throw new V1HttpError(404, "resource.not_found", "Session not found", "not_found");
    const items = page.items.slice(0, limit).map(mapItem);
    const hasMore = page.items.length > limit;
    const last = items.at(-1);
    setRevisionEtag(reply, page.collectionRevision);
    return encodeAbi(OperatorInboxListResponseSchema, successEnvelope(request, {
      items,
      collectionRevision: page.collectionRevision,
      pageInfo: {
        nextCursor: hasMore && last ? encodeProfileCursor({
          kind: "session_inbox", resourceId: sessionId, snapshotRowId: page.snapshotRowId,
          after: { createdAt: Date.parse(last.createdAt), id: last.id },
        }) : null,
        hasMore,
        limit,
        snapshot: encodeProfileSnapshot({ kind: "session_inbox", resourceId: sessionId, snapshotRowId: page.snapshotRowId }),
      },
    }));
  });

  app.put("/api/v1/operator/sessions/:sessionId/inbox/order", {
    onRequest: write,
    schema: { params: OperatorInboxParamsSchema, body: OperatorInboxReorderRequestSchema },
  }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    assertProfileResourceScope(request, "session", sessionId);
    const body = decodeAbi(OperatorInboxReorderRequestSchema, request.body);
    const headers = profileMutationHeaders(request);
    const result = profileMutationValue(dependencies.service.reorderSessionInputsProfile(
      sessionId,
      body.itemIds,
      profileMutationContext(request, headers, body),
    ));
    const items = result.value.itemIds.map((itemId) => dependencies.persistence.profileContracts.getInboxItem(sessionId, itemId))
      .filter((item): item is ProfileInboxItemRecord => Boolean(item)).map(mapItem);
    setRevisionEtag(reply, result.value.collectionRevision);
    if (result.replayed) reply.header("Idempotency-Replayed", "true");
    return encodeAbi(OperatorInboxMutationResponseSchema, successEnvelope(request, {
      ok: true,
      items,
      collectionRevision: result.value.collectionRevision,
    }));
  });

  app.patch("/api/v1/operator/sessions/:sessionId/inbox/:itemId", {
    onRequest: write,
    schema: { params: OperatorInboxItemParamsSchema, body: OperatorInboxUpdateRequestSchema },
  }, async (request, reply) => {
    const { sessionId, itemId } = request.params as { sessionId: string; itemId: string };
    assertProfileResourceScope(request, "session", sessionId);
    const body = decodeAbi(OperatorInboxUpdateRequestSchema, request.body);
    const normalized = { content: body.content.trim() };
    const headers = profileMutationHeaders(request);
    const result = profileMutationValue(await dependencies.service.updateSessionInputProfile(
      sessionId,
      itemId,
      normalized.content,
      profileMutationContext(request, headers, normalized),
    ));
    const item = dependencies.persistence.profileContracts.getInboxItem(sessionId, itemId);
    if (!item) throw new V1HttpError(404, "resource.not_found", "Inbox item not found", "not_found");
    setRevisionEtag(reply, result.value.collectionRevision);
    if (result.replayed) reply.header("Idempotency-Replayed", "true");
    return encodeAbi(OperatorInboxItemResponseSchema, successEnvelope(request, {
      item: mapItem(item),
      collectionRevision: result.value.collectionRevision,
    }));
  });

  app.post("/api/v1/operator/sessions/:sessionId/inbox/:itemId/decision", {
    onRequest: write,
    schema: { params: OperatorInboxItemParamsSchema, body: OperatorInboxDecisionRequestSchema },
  }, async (request, reply) => {
    const { sessionId, itemId } = request.params as { sessionId: string; itemId: string };
    assertProfileResourceScope(request, "session", sessionId);
    const body = decodeAbi(OperatorInboxDecisionRequestSchema, request.body);
    const headers = profileMutationHeaders(request);
    const result = profileMutationValue(dependencies.service.decideSessionInputProfile(
      sessionId,
      itemId,
      body.decision,
      profileMutationContext(request, headers, body),
    ));
    const item = dependencies.persistence.profileContracts.getInboxItem(sessionId, itemId);
    if (!item) throw new V1HttpError(404, "resource.not_found", "Inbox item not found", "not_found");
    setRevisionEtag(reply, result.value.collectionRevision);
    if (result.replayed) reply.header("Idempotency-Replayed", "true");
    return encodeAbi(OperatorInboxItemResponseSchema, successEnvelope(request, {
      item: mapItem(item),
      collectionRevision: result.value.collectionRevision,
    }));
  });

  app.post("/api/v1/operator/sessions/:sessionId/inbox/:itemId/merge", {
    onRequest: write,
    schema: { params: OperatorInboxItemParamsSchema, body: OperatorInboxMergeRequestSchema },
  }, async (request, reply) => {
    const { sessionId, itemId } = request.params as { sessionId: string; itemId: string };
    assertProfileResourceScope(request, "session", sessionId);
    const body = decodeAbi(OperatorInboxMergeRequestSchema, request.body);
    const headers = profileMutationHeaders(request);
    const result = profileMutationValue(dependencies.service.mergeSessionInputsProfile(
      sessionId,
      itemId,
      body.targetId,
      profileMutationContext(request, headers, body),
    ));
    const items = result.value.itemIds.map((candidateId) => dependencies.persistence.profileContracts.getInboxItem(sessionId, candidateId))
      .filter((item): item is ProfileInboxItemRecord => Boolean(item)).map(mapItem);
    setRevisionEtag(reply, result.value.collectionRevision);
    if (result.replayed) reply.header("Idempotency-Replayed", "true");
    return encodeAbi(OperatorInboxMutationResponseSchema, successEnvelope(request, {
      ok: true,
      items,
      collectionRevision: result.value.collectionRevision,
    }));
  });

  app.delete("/api/v1/operator/sessions/:sessionId/inbox/:itemId", {
    onRequest: write,
    schema: { params: OperatorInboxItemParamsSchema },
  }, async (request, reply) => {
    const { sessionId, itemId } = request.params as { sessionId: string; itemId: string };
    assertProfileResourceScope(request, "session", sessionId);
    const headers = profileMutationHeaders(request);
    const result = profileMutationValue(dependencies.service.deleteSessionInputProfile(
      sessionId,
      itemId,
      profileMutationContext(request, headers, {}),
    ));
    const item = dependencies.persistence.profileContracts.getInboxItem(sessionId, itemId);
    const items = item ? [mapItem(item)] : [];
    setRevisionEtag(reply, result.value.collectionRevision);
    if (result.replayed) reply.header("Idempotency-Replayed", "true");
    return encodeAbi(OperatorInboxMutationResponseSchema, successEnvelope(request, {
      ok: true,
      items,
      collectionRevision: result.value.collectionRevision,
    }));
  });

  registerOperatorInboxOperationV1Routes(app, dependencies);
}
