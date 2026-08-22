import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  encodeAbi,
  OPERATOR_READ_ENDPOINT_IDS,
  OperatorLatestSessionTaskRunResponseSchema,
  OperatorListQuerySchema,
  OperatorReadCapabilitiesResponseSchema,
  OperatorSessionListResponseSchema,
  OperatorSessionParamsSchema,
  OperatorSessionTaskRunListResponseSchema,
  type OperatorListQuery,
  type OperatorSessionParams,
  type OperatorSessionSummary,
  type OperatorTaskRunSummary,
} from "@tagent/abi";
import type { ChannelV1Dependencies } from "./dependencies.js";
import { assertV1ResourceScope, authorizeV1Scopes, principalOf } from "./auth.js";
import { successEnvelope, V1HttpError } from "./errors.js";
import { decodeQuery, missing } from "./route-support.js";
import {
  decodeOperatorReadCursor,
  encodeOperatorReadCursor,
  encodeOperatorReadSnapshot,
  type OperatorReadCursorKind,
} from "./profile-cursor.js";

const SESSION_LIST_DEFAULT = 50;
const SESSION_LIST_MAX = 200;
const TASK_RUN_LIST_DEFAULT = 50;
const TASK_RUN_LIST_MAX = 200;

function authorizeOperator(dependencies: ChannelV1Dependencies, ...scopes: Array<"sessions:read" | "runs:read">) {
  return async (request: FastifyRequest): Promise<void> => {
    authorizeV1Scopes(request, dependencies.serviceCredentials, scopes, "operator");
  };
}

function authorizedSessionIds(request: FastifyRequest): string[] | undefined {
  const principal = principalOf(request);
  if (principal.localAdmin) return undefined;
  const scopes = principal.resourceScopes.filter((scope) => scope.type === "session" || scope.type === "workspace");
  if (scopes.some((scope) => scope.id === "*")) return undefined;
  return [...new Set(scopes.map((scope) => scope.id))];
}

function listQuery(request: FastifyRequest, maximum: number): OperatorListQuery {
  const raw = request.query as { cursor?: unknown; limit?: unknown };
  if (raw.cursor !== undefined && (typeof raw.cursor !== "string" || raw.cursor.length < 1 || raw.cursor.length > 4096)) {
    throw new V1HttpError(400, "pagination.cursor_invalid", "Pagination cursor is invalid or does not match this query", "validation");
  }
  const limit = raw.limit === undefined ? undefined : Number(raw.limit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum)) {
    throw new V1HttpError(400, "pagination.limit_invalid", `limit must be an integer between 1 and ${maximum}`, "validation");
  }
  return decodeQuery(OperatorListQuerySchema, {
    ...(raw.cursor === undefined ? {} : { cursor: raw.cursor }),
    ...(limit === undefined ? {} : { limit }),
  });
}

function iso(timestamp: number): string;
function iso(timestamp: number | null): string | null;
function iso(timestamp: number | null): string | null {
  return timestamp === null ? null : new Date(timestamp).toISOString();
}

function mapSession(row: ReturnType<ChannelV1Dependencies["persistence"]["operatorRead"]["listSessionsPage"]>["items"][number]): OperatorSessionSummary {
  return {
    id: row.id, title: row.title, modelId: row.modelId, reasoningEffort: row.reasoningEffort,
    createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), latestTaskRunId: row.latestTaskRunId,
    latestTaskRunStatus: row.latestTaskRunStatus, latestTaskRunPhase: row.latestTaskRunPhase,
    latestActivityAt: iso(row.latestActivityAt),
  };
}

function mapTaskRun(row: ReturnType<ChannelV1Dependencies["persistence"]["operatorRead"]["listSessionTaskRunsPage"]>["items"][number]): OperatorTaskRunSummary {
  return {
    id: row.id, sessionId: row.sessionId, status: row.status, phase: row.phase, attempt: row.attempt,
    currentAttemptId: `attempt:${row.id}:${row.attempt}`, goalSummary: row.goalSummary,
    blockedReason: row.blockedReason || null,
    pendingInteractionKinds: [
      ...(row.pendingApproval ? ["approval" as const] : []),
      ...(row.pendingUserInput ? ["user_input" as const] : []),
    ],
    lastEventSequence: row.lastEventSequence, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt),
    completedAt: iso(row.completedAt), resumable: Boolean(row.resumable),
  };
}

function pageState(
  query: OperatorListQuery,
  kind: OperatorReadCursorKind,
  resourceId: string | null,
): { snapshotRowId?: number; after?: { createdAt: number; id: string } } {
  return query.cursor ? decodeOperatorReadCursor(query.cursor, { kind, resourceId }) : {};
}

function pageInfo<T extends { id: string; createdAt: string }>(input: {
  items: T[]; hasMore: boolean; limit: number; kind: OperatorReadCursorKind; resourceId: string | null; snapshotRowId: number;
}) {
  const last = input.items.at(-1);
  return {
    nextCursor: input.hasMore && last ? encodeOperatorReadCursor({
      kind: input.kind, resourceId: input.resourceId, snapshotRowId: input.snapshotRowId,
      after: { createdAt: Date.parse(last.createdAt), id: last.id },
    }) : null,
    hasMore: input.hasMore,
    limit: input.limit,
    snapshot: encodeOperatorReadSnapshot({ kind: input.kind, resourceId: input.resourceId, snapshotRowId: input.snapshotRowId }),
  };
}

export function registerOperatorReadV1Routes(app: FastifyInstance, dependencies: ChannelV1Dependencies): void {
  const { operatorRead } = dependencies.persistence;

  app.get("/api/v1/operator/capabilities", { onRequest: authorizeOperator(dependencies, "sessions:read") }, async (request) =>
    encodeAbi(OperatorReadCapabilitiesResponseSchema, successEnvelope(request, {
      profileVersion: "1.0",
      endpointIds: [...OPERATOR_READ_ENDPOINT_IDS],
      pagination: {
        cursorVersion: "1", cursorOpaque: true, cursorExpiry: false, cursorSurvivesRestart: true,
        membershipConsistency: "snapshot", valueConsistency: "read_committed",
        sessionOrder: "created_at_desc_id_desc", taskRunOrder: "created_at_desc_id_desc",
        cursorBindings: ["endpoint", "resource", "filter", "snapshot"],
      },
      retention: { automaticDeletion: false, tombstones: false, missingResourceStatus: 404 },
      limits: {
        sessionListDefault: SESSION_LIST_DEFAULT, sessionListMax: SESSION_LIST_MAX,
        taskRunListDefault: TASK_RUN_LIST_DEFAULT, taskRunListMax: TASK_RUN_LIST_MAX,
        goalSummaryCharacters: 500, blockedReasonCharacters: 500,
      },
    })));

  app.get("/api/v1/operator/sessions", { onRequest: authorizeOperator(dependencies, "sessions:read") }, async (request) => {
    const query = listQuery(request, SESSION_LIST_MAX);
    const limit = query.limit ?? SESSION_LIST_DEFAULT;
    const state = pageState(query, "sessions", null);
    const page = operatorRead.listSessionsPage({ ...state, sessionIds: authorizedSessionIds(request), limit: limit + 1 });
    const items = page.items.slice(0, limit).map(mapSession);
    const hasMore = page.items.length > limit;
    return encodeAbi(OperatorSessionListResponseSchema, successEnvelope(request, {
      items,
      pageInfo: pageInfo({ items, hasMore, limit, kind: "sessions", resourceId: null, snapshotRowId: page.snapshotRowId }),
    }));
  });

  app.get("/api/v1/operator/sessions/:sessionId/task-runs", {
    onRequest: authorizeOperator(dependencies, "sessions:read", "runs:read"),
    schema: { params: OperatorSessionParamsSchema },
  }, async (request) => {
    const { sessionId } = request.params as OperatorSessionParams;
    assertV1ResourceScope(request, "session", sessionId);
    if (!dependencies.persistence.sessions.getSession(sessionId)) throw missing("session");
    const query = listQuery(request, TASK_RUN_LIST_MAX);
    const limit = query.limit ?? TASK_RUN_LIST_DEFAULT;
    const state = pageState(query, "session_task_runs", sessionId);
    const page = operatorRead.listSessionTaskRunsPage(sessionId, { ...state, limit: limit + 1 });
    const items = page.items.slice(0, limit).map(mapTaskRun);
    const hasMore = page.items.length > limit;
    return encodeAbi(OperatorSessionTaskRunListResponseSchema, successEnvelope(request, {
      items,
      pageInfo: pageInfo({ items, hasMore, limit, kind: "session_task_runs", resourceId: sessionId, snapshotRowId: page.snapshotRowId }),
    }));
  });

  app.get("/api/v1/operator/sessions/:sessionId/task-runs/latest", {
    onRequest: authorizeOperator(dependencies, "sessions:read", "runs:read"),
    schema: { params: OperatorSessionParamsSchema },
  }, async (request) => {
    const { sessionId } = request.params as OperatorSessionParams;
    assertV1ResourceScope(request, "session", sessionId);
    if (!dependencies.persistence.sessions.getSession(sessionId)) throw missing("session");
    const latest = operatorRead.getLatestSessionTaskRun(sessionId);
    return encodeAbi(OperatorLatestSessionTaskRunResponseSchema, successEnvelope(request, latest ? mapTaskRun(latest) : null));
  });
}
