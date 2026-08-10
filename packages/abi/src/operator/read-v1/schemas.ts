import { Type, type Static } from "typebox";
import { IdentifierSchema, IsoDateTimeSchema, RequestIdSchema } from "../../shared/primitives.js";
import { TaskRunPhaseSchema, TaskRunStatusSchema } from "../../channel/v1/session-schemas.js";

export const OPERATOR_READ_PROFILE_VERSION = "1.0" as const;
export const OPERATOR_READ_ENDPOINT_IDS = [
  "operator.read.capabilities.get",
  "operator.sessions.list",
  "operator.sessions.task_runs.list",
  "operator.sessions.task_runs.latest",
] as const;

export const OperatorReadEndpointIdSchema = Type.Union([
  Type.Literal("operator.read.capabilities.get"),
  Type.Literal("operator.sessions.list"),
  Type.Literal("operator.sessions.task_runs.list"),
  Type.Literal("operator.sessions.task_runs.latest"),
]);
export type OperatorReadEndpointId = Static<typeof OperatorReadEndpointIdSchema>;

export const OperatorReadCapabilitiesSchema = Type.Object({
  profileVersion: Type.Literal(OPERATOR_READ_PROFILE_VERSION),
  endpointIds: Type.Array(OperatorReadEndpointIdSchema),
  pagination: Type.Object({
    cursorVersion: Type.Literal("1"),
    cursorOpaque: Type.Literal(true),
    cursorExpiry: Type.Literal(false),
    cursorSurvivesRestart: Type.Literal(true),
    membershipConsistency: Type.Literal("snapshot"),
    valueConsistency: Type.Literal("read_committed"),
    sessionOrder: Type.Literal("created_at_desc_id_desc"),
    taskRunOrder: Type.Literal("created_at_desc_id_desc"),
    cursorBindings: Type.Array(Type.Union([
      Type.Literal("endpoint"), Type.Literal("resource"), Type.Literal("filter"), Type.Literal("snapshot"),
    ])),
  }, { additionalProperties: false }),
  retention: Type.Object({
    automaticDeletion: Type.Literal(false),
    tombstones: Type.Literal(false),
    missingResourceStatus: Type.Literal(404),
  }, { additionalProperties: false }),
  limits: Type.Object({
    sessionListDefault: Type.Integer({ minimum: 1 }),
    sessionListMax: Type.Integer({ minimum: 1 }),
    taskRunListDefault: Type.Integer({ minimum: 1 }),
    taskRunListMax: Type.Integer({ minimum: 1 }),
    goalSummaryCharacters: Type.Integer({ minimum: 1 }),
    blockedReasonCharacters: Type.Integer({ minimum: 1 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export type OperatorReadCapabilities = Static<typeof OperatorReadCapabilitiesSchema>;

export const OperatorReadCapabilitiesResponseSchema = Type.Object({
  data: OperatorReadCapabilitiesSchema,
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type OperatorReadCapabilitiesResponse = Static<typeof OperatorReadCapabilitiesResponseSchema>;

export const OperatorListQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
}, { additionalProperties: false });
export type OperatorListQuery = Static<typeof OperatorListQuerySchema>;

export const OperatorSessionParamsSchema = Type.Object({ sessionId: IdentifierSchema }, { additionalProperties: false });
export type OperatorSessionParams = Static<typeof OperatorSessionParamsSchema>;

export const OperatorPageInfoSchema = Type.Object({
  nextCursor: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
  hasMore: Type.Boolean(),
  limit: Type.Integer({ minimum: 1, maximum: 200 }),
  snapshot: Type.String({ minLength: 1, maxLength: 4096 }),
}, { additionalProperties: false });

export const OperatorSessionSummarySchema = Type.Object({
  id: IdentifierSchema,
  title: Type.String({ minLength: 1, maxLength: 256 }),
  modelId: Type.String({ minLength: 1 }),
  reasoningEffort: Type.Union([
    Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"),
    Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
  ]),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  latestTaskRunId: Type.Union([IdentifierSchema, Type.Null()]),
  latestTaskRunStatus: Type.Union([TaskRunStatusSchema, Type.Null()]),
  latestTaskRunPhase: Type.Union([TaskRunPhaseSchema, Type.Null()]),
  latestActivityAt: IsoDateTimeSchema,
}, { additionalProperties: false });
export type OperatorSessionSummary = Static<typeof OperatorSessionSummarySchema>;

export const OperatorTaskRunSummarySchema = Type.Object({
  id: IdentifierSchema,
  sessionId: IdentifierSchema,
  status: TaskRunStatusSchema,
  phase: TaskRunPhaseSchema,
  attempt: Type.Integer({ minimum: 1 }),
  currentAttemptId: IdentifierSchema,
  goalSummary: Type.String({ maxLength: 500 }),
  blockedReason: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  pendingInteractionKinds: Type.Array(Type.Union([Type.Literal("approval"), Type.Literal("user_input")])),
  lastEventSequence: Type.Integer({ minimum: 0 }),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  completedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  resumable: Type.Boolean(),
}, { additionalProperties: false });
export type OperatorTaskRunSummary = Static<typeof OperatorTaskRunSummarySchema>;

export const OperatorSessionListResponseSchema = Type.Object({
  data: Type.Object({ items: Type.Array(OperatorSessionSummarySchema), pageInfo: OperatorPageInfoSchema }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type OperatorSessionListResponse = Static<typeof OperatorSessionListResponseSchema>;

export const OperatorSessionTaskRunListResponseSchema = Type.Object({
  data: Type.Object({ items: Type.Array(OperatorTaskRunSummarySchema), pageInfo: OperatorPageInfoSchema }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type OperatorSessionTaskRunListResponse = Static<typeof OperatorSessionTaskRunListResponseSchema>;

export const OperatorLatestSessionTaskRunResponseSchema = Type.Object({
  data: Type.Union([OperatorTaskRunSummarySchema, Type.Null()]),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type OperatorLatestSessionTaskRunResponse = Static<typeof OperatorLatestSessionTaskRunResponseSchema>;
