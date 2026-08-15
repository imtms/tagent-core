import type { FastifyReply, FastifyRequest } from "fastify";
import {
  canonicalJson,
  decodeAbi,
  ProfileMutationHeadersSchema,
  ProfileOperationHeadersSchema,
  type ProfileMutationHeaders,
  type ProfileOperationHeaders,
  type ProfileOperationReceipt,
  type ProfileServiceScope,
  ProfileListQuerySchema,
  type ProfileListQuery,
} from "@tagent/abi";
import type { ProfileMutationContext, ProfileMutationResult } from "@tagent/admission/ports";
import type { ProfileOperationReceiptRecord } from "@tagent/admission/ports";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { authorizeV1, principalOf } from "./auth.js";
import { requestIdOf, V1HttpError } from "./errors.js";

export function authorizeProfile(dependencies: ChannelV1Dependencies, scope: ProfileServiceScope, surface: "operator" | "admin") {
  return async (request: FastifyRequest): Promise<void> => authorizeV1(request, dependencies.serviceCredentials, scope, surface);
}

export function assertProfileResourceScope(request: FastifyRequest, type: "session" | "workspace" | "project" | "user", id: string): void {
  const principal = principalOf(request);
  if (principal.localAdmin) return;
  const allowed = principal.resourceScopes.some((scope) =>
    (scope.type === type || (type === "session" && scope.type === "workspace"))
      && (scope.id === id || scope.id === "*"));
  if (!allowed) {
    throw new V1HttpError(403, "auth.resource_scope_denied", "Resource scope is not authorized", "permission_denied", false, {
      resourceType: type,
      resourceId: id,
    });
  }
}

export function profileMutationHeaders(request: FastifyRequest): ProfileMutationHeaders {
  try {
    return decodeAbi(ProfileMutationHeadersSchema, {
      "idempotency-key": request.headers["idempotency-key"],
      "if-match": request.headers["if-match"],
      ...(request.headers["x-tagent-delegated-actor"] === undefined
        ? {} : { "x-tagent-delegated-actor": request.headers["x-tagent-delegated-actor"] }),
      ...(request.headers["x-tagent-delegated-request-id"] === undefined
        ? {} : { "x-tagent-delegated-request-id": request.headers["x-tagent-delegated-request-id"] }),
    });
  } catch (error) {
    throw new V1HttpError(400, "request.validation_failed", "Idempotency-Key and a valid If-Match revision are required", "validation", false, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export function profileOperationHeaders(request: FastifyRequest): ProfileOperationHeaders {
  try {
    return decodeAbi(ProfileOperationHeadersSchema, {
      "idempotency-key": request.headers["idempotency-key"],
      ...(request.headers["x-tagent-delegated-actor"] === undefined
        ? {} : { "x-tagent-delegated-actor": request.headers["x-tagent-delegated-actor"] }),
      ...(request.headers["x-tagent-delegated-request-id"] === undefined
        ? {} : { "x-tagent-delegated-request-id": request.headers["x-tagent-delegated-request-id"] }),
    });
  } catch (error) {
    throw new V1HttpError(400, "request.validation_failed", "A valid Idempotency-Key is required", "validation", false, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

export function mapProfileOperationReceipt(receipt: ProfileOperationReceiptRecord): ProfileOperationReceipt {
  return {
    requestId: receipt.idempotencyKey,
    profileId: receipt.profileId as ProfileOperationReceipt["profileId"],
    endpointId: receipt.endpointId,
    status: receipt.status,
    resource: { type: receipt.resourceType, id: receipt.resourceId },
    result: receipt.result,
    error: receipt.error,
    createdAt: new Date(receipt.createdAt).toISOString(),
    updatedAt: new Date(receipt.updatedAt).toISOString(),
    completedAt: receipt.completedAt === null ? null : new Date(receipt.completedAt).toISOString(),
  };
}

function revisionFromEtag(etag: string): number {
  const match = /^"r([1-9][0-9]*)"$/.exec(etag);
  if (!match) throw new V1HttpError(400, "request.validation_failed", "If-Match revision is invalid", "validation");
  const revision = Number(match[1]);
  if (!Number.isSafeInteger(revision)) throw new V1HttpError(400, "request.validation_failed", "If-Match revision is invalid", "validation");
  return revision;
}

function revisionEtag(revision: number): string {
  return `"r${revision}"`;
}

export function setRevisionEtag(reply: FastifyReply, revision: number): void {
  reply.header("ETag", revisionEtag(revision));
}

export function profileMutationContext(request: FastifyRequest, headers: ProfileMutationHeaders, payload: unknown): ProfileMutationContext {
  const principal = principalOf(request);
  const expectedRevision = revisionFromEtag(headers["if-match"]);
  return {
    principalId: principal.subjectId,
    grantedScopes: principal.grantedScopes,
    delegatedActorId: headers["x-tagent-delegated-actor"],
    delegatedRequestId: headers["x-tagent-delegated-request-id"],
    requestId: requestIdOf(request),
    idempotencyKey: headers["idempotency-key"],
    canonicalPayload: canonicalJson({ expectedRevision, payload }),
    expectedRevision,
  };
}

export function replayProfileMutation<T>(
  dependencies: ChannelV1Dependencies,
  identity: { profileId: string; endpointId: string; resourceType: string; resourceId: string },
  mutation: ProfileMutationContext,
): ProfileMutationResult<T> | undefined {
  return dependencies.persistence.profileContracts.replaySynchronousMutation<T>({ ...identity, mutation });
}

export function profileMutationValue<T>(result: ProfileMutationResult<T>): { value: T; replayed: boolean } {
  switch (result.status) {
    case "succeeded": return result;
    case "not_found":
      throw new V1HttpError(404, "resource.not_found", "Resource not found", "not_found");
    case "idempotency_conflict":
      throw new V1HttpError(409, "idempotency.conflict", "Idempotency key is bound to a different canonical request", "conflict");
    case "concurrency_conflict":
      throw new V1HttpError(409, "concurrency.conflict", "Resource revision is stale", "conflict", false, {
        currentRevision: result.currentRevision,
        currentEtag: revisionEtag(result.currentRevision),
      });
    case "state_conflict":
      throw new V1HttpError(409, "resource.state_conflict", "Resource state does not allow this operation", "conflict");
  }
}

export function profileListQuery(request: FastifyRequest, maximum = 200): ProfileListQuery {
  const raw = request.query as { cursor?: unknown; limit?: unknown };
  if (raw.cursor !== undefined && (typeof raw.cursor !== "string" || raw.cursor.length < 1 || raw.cursor.length > 4096)) {
    throw new V1HttpError(400, "pagination.cursor_invalid", "Pagination cursor is invalid", "validation");
  }
  const limit = raw.limit === undefined ? undefined : Number(raw.limit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum)) {
    throw new V1HttpError(400, "pagination.limit_invalid", `limit must be an integer between 1 and ${maximum}`, "validation");
  }
  try {
    return decodeAbi(ProfileListQuerySchema, {
      ...(raw.cursor === undefined ? {} : { cursor: raw.cursor }),
      ...(limit === undefined ? {} : { limit }),
    });
  } catch (error) {
    throw new V1HttpError(400, "request.validation_failed", "Pagination query is invalid", "validation", false, {
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}
