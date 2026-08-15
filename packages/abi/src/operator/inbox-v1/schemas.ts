import { Type, type Static } from "typebox";
import { IdentifierSchema, IsoDateTimeSchema, RequestIdSchema } from "../../shared/primitives.js";
import { ProfilePageInfoSchema, ResourceRevisionSchema } from "../../profiles/v1/schemas.js";

export const OperatorInboxItemSchema = Type.Object({
  id: IdentifierSchema,
  sessionId: IdentifierSchema,
  content: Type.String({ minLength: 1, maxLength: 200_000 }),
  status: Type.Union([
    Type.Literal("queued"), Type.Literal("claimed"), Type.Literal("started"),
    Type.Literal("routed"), Type.Literal("deleted"), Type.Literal("failed"),
  ]),
  decision: Type.Union([
    Type.Literal("pending"), Type.Literal("start_taskrun"), Type.Literal("steer"),
    Type.Literal("follow_up"), Type.Literal("discussion"), Type.Literal("defer"),
    Type.Literal("merge"), Type.Literal("delete"),
  ]),
  runId: Type.Union([IdentifierSchema, Type.Null()]),
  position: Type.Integer({ minimum: 0 }),
  summary: Type.String({ maxLength: 500 }),
  intent: Type.Union([
    Type.Literal("steer_active"), Type.Literal("follow_up_active"), Type.Literal("update_active_context"),
    Type.Literal("new_task"), Type.Literal("parallel_task"), Type.Literal("merge_candidate"),
    Type.Literal("discussion"), Type.Literal("clarification"), Type.Literal("defer"),
  ]),
  targetRunId: Type.Union([IdentifierSchema, Type.Null()]),
  priority: Type.Integer(),
  urgency: Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high"), Type.Literal("critical")]),
  relation: Type.Union([
    Type.Literal("independent"), Type.Literal("same_goal"), Type.Literal("correction"),
    Type.Literal("constraint"), Type.Literal("follow_up"), Type.Literal("parallel"),
    Type.Literal("depends_on"), Type.Literal("derived"),
  ]),
  acceptanceCriteria: Type.Array(Type.String(), { maxItems: 100 }),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  reason: Type.String({ maxLength: 4_000 }),
  gateProfile: Type.Union([Type.Literal("off"), Type.Literal("relaxed"), Type.Literal("strict")]),
  revision: ResourceRevisionSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}, { additionalProperties: false });
export type OperatorInboxItem = Static<typeof OperatorInboxItemSchema>;

export const OperatorInboxParamsSchema = Type.Object({ sessionId: IdentifierSchema }, { additionalProperties: false });
export const OperatorInboxItemParamsSchema = Type.Object({
  sessionId: IdentifierSchema,
  itemId: IdentifierSchema,
}, { additionalProperties: false });
export const OperatorInboxRetryParamsSchema = Type.Object({ taskRunId: IdentifierSchema }, { additionalProperties: false });

export const OperatorInboxReorderRequestSchema = Type.Object({
  itemIds: Type.Array(IdentifierSchema, { maxItems: 200 }),
}, { additionalProperties: false });
export type OperatorInboxReorderRequest = Static<typeof OperatorInboxReorderRequestSchema>;

export const OperatorInboxUpdateRequestSchema = Type.Object({
  content: Type.String({ minLength: 1, maxLength: 200_000 }),
}, { additionalProperties: false });
export type OperatorInboxUpdateRequest = Static<typeof OperatorInboxUpdateRequestSchema>;

export const OperatorInboxDecisionRequestSchema = Type.Object({
  decision: Type.Union([Type.Literal("pending"), Type.Literal("defer")]),
}, { additionalProperties: false });
export type OperatorInboxDecisionRequest = Static<typeof OperatorInboxDecisionRequestSchema>;

export const OperatorInboxMergeRequestSchema = Type.Object({ targetId: IdentifierSchema }, { additionalProperties: false });
export type OperatorInboxMergeRequest = Static<typeof OperatorInboxMergeRequestSchema>;

export const OperatorInboxListResponseSchema = Type.Object({
  data: Type.Object({
    items: Type.Array(OperatorInboxItemSchema),
    pageInfo: ProfilePageInfoSchema,
    collectionRevision: ResourceRevisionSchema,
  }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type OperatorInboxListResponse = Static<typeof OperatorInboxListResponseSchema>;

export const OperatorInboxItemResponseSchema = Type.Object({
  data: Type.Object({ item: OperatorInboxItemSchema, collectionRevision: ResourceRevisionSchema }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type OperatorInboxItemResponse = Static<typeof OperatorInboxItemResponseSchema>;

export const OperatorInboxMutationResponseSchema = Type.Object({
  data: Type.Object({
    ok: Type.Literal(true),
    items: Type.Array(OperatorInboxItemSchema),
    collectionRevision: ResourceRevisionSchema,
  }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type OperatorInboxMutationResponse = Static<typeof OperatorInboxMutationResponseSchema>;
