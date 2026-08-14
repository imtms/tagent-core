import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  encodeAbi,
  OperatorContextManifestListResponseSchema,
  OperatorContextManifestParamsSchema,
  type PublicContextManifest,
} from "@tagent/abi";
import type { ProfileContextManifestRecord } from "@tagent/admission/ports";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { successEnvelope, V1HttpError } from "./errors.js";
import { decodeProfileCursor, encodeProfileCursor, encodeProfileSnapshot } from "./profile-cursor.js";
import { assertProfileResourceScope, authorizeProfile, profileListQuery } from "./profile-route-support.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function opaqueSource(sourceId: string): string {
  return createHash("sha256").update("context-source\0").update(sourceId).digest("hex").slice(0, 32);
}

function mapManifest(manifest: ProfileContextManifestRecord): PublicContextManifest {
  const items = manifest.items.map((item) => ({
    kind: item.kind,
    sourceRef: opaqueSource(item.sourceId),
    selected: item.selected,
    estimatedTokens: item.estimatedTokens,
  }));
  return {
    id: manifest.id,
    taskRunId: manifest.taskRunId,
    attempt: manifest.attempt,
    source: manifest.source,
    manifestHash: manifest.manifestHash,
    items,
    stats: {
      itemCount: items.length,
      selectedItemCount: items.filter((item) => item.selected).length,
      estimatedTokens: items.filter((item) => item.selected).reduce((total, item) => total + item.estimatedTokens, 0),
    },
    createdAt: new Date(manifest.createdAt).toISOString(),
  };
}

export function registerOperatorContextManifestV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): void {
  const read = authorizeProfile(dependencies, "operator:context-manifests:read", "operator");

  app.get("/api/v1/operator/task-runs/:taskRunId/context-manifests", {
    onRequest: read,
    schema: { params: OperatorContextManifestParamsSchema },
  }, async (request) => {
    const { taskRunId } = request.params as { taskRunId: string };
    const sessionId = dependencies.persistence.profileContracts.getTaskRunSessionId(taskRunId);
    if (!sessionId) throw new V1HttpError(404, "resource.not_found", "TaskRun not found", "not_found");
    assertProfileResourceScope(request, "session", sessionId);
    const query = profileListQuery(request, MAX_LIMIT);
    const limit = query.limit ?? DEFAULT_LIMIT;
    const state = query.cursor ? decodeProfileCursor(query.cursor, { kind: "context_manifests", resourceId: taskRunId }) : {};
    const page = dependencies.persistence.profileContracts.listContextManifestPage(taskRunId, { ...state, limit: limit + 1 });
    const items = page.items.slice(0, limit).map(mapManifest);
    const hasMore = page.items.length > limit;
    const last = items.at(-1);
    return encodeAbi(OperatorContextManifestListResponseSchema, successEnvelope(request, {
      items,
      pageInfo: {
        nextCursor: hasMore && last ? encodeProfileCursor({
          kind: "context_manifests", resourceId: taskRunId, snapshotRowId: page.snapshotRowId,
          after: { createdAt: Date.parse(last.createdAt), id: last.id },
        }) : null,
        hasMore,
        limit,
        snapshot: encodeProfileSnapshot({ kind: "context_manifests", resourceId: taskRunId, snapshotRowId: page.snapshotRowId }),
      },
    }));
  });
}
