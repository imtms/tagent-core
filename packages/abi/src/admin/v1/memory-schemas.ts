import { Type, type Static } from "typebox";
import { IdempotencyKeySchema } from "../../shared/idempotency.js";
import { IdentifierSchema, IsoDateTimeSchema, JsonObjectSchema, RequestIdSchema } from "../../shared/primitives.js";

export const MemoryKindSchema = Type.Union([
  Type.Literal("fact"), Type.Literal("preference"), Type.Literal("episode"), Type.Literal("procedure"),
]);
export type MemoryKind = Static<typeof MemoryKindSchema>;

export const MemoryScopeSchema = Type.Object({
  type: Type.Union([Type.Literal("user"), Type.Literal("workspace"), Type.Literal("project"), Type.Literal("session")]),
  id: IdentifierSchema,
});
export type MemoryScope = Static<typeof MemoryScopeSchema>;

export const MEMORY_SOURCE_TYPES = ["message", "run", "transcript", "manual", "check", "artifact", "operation"] as const;
export const MemorySourceTypeSchema = Type.Union([
  Type.Literal("message"),
  Type.Literal("run"),
  Type.Literal("transcript"),
  Type.Literal("manual"),
  Type.Literal("check"),
  Type.Literal("artifact"),
  Type.Literal("operation"),
]);
export type MemorySourceType = Static<typeof MemorySourceTypeSchema>;

export const MemorySourceReferenceSchema = Type.Object({
  sourceType: MemorySourceTypeSchema,
  sourceId: IdentifierSchema,
  revision: Type.Optional(Type.String({ minLength: 1 })),
});
export type MemorySourceReference = Static<typeof MemorySourceReferenceSchema>;

export const MemoryStatusSchema = Type.Union([
  Type.Literal("candidate"), Type.Literal("active"), Type.Literal("stale"),
  Type.Literal("superseded"), Type.Literal("disputed"), Type.Literal("quarantined"), Type.Literal("deleted"),
]);
export type MemoryStatus = Static<typeof MemoryStatusSchema>;

const MemoryRecordBase = {
  id: IdentifierSchema,
  tier: Type.Union([Type.Literal("hot"), Type.Literal("warm")]),
  scope: MemoryScopeSchema,
  summary: Type.String(),
  topicIds: Type.Array(IdentifierSchema),
  entityIds: Type.Array(IdentifierSchema),
  status: MemoryStatusSchema,
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  sourceRefs: Type.Array(MemorySourceReferenceSchema),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
};

export const MemoryRecordSchema = Type.Union([
  Type.Object({
    ...MemoryRecordBase,
    kind: Type.Union([Type.Literal("fact"), Type.Literal("episode"), Type.Literal("procedure")]),
    title: Type.String(),
    content: Type.String(),
    importance: Type.Number({ minimum: 0, maximum: 1 }),
  }),
  Type.Object({
    ...MemoryRecordBase,
    kind: Type.Literal("preference"),
    dimension: Type.String(),
    value: Type.String(),
    applicability: Type.Union([
      Type.Literal("global"), Type.Literal("workspace"), Type.Literal("project"), Type.Literal("task"),
    ]),
    strength: Type.Number({ minimum: 0, maximum: 1 }),
    origin: Type.Union([Type.Literal("explicit"), Type.Literal("repeated"), Type.Literal("inferred")]),
  }),
]);
export type MemoryRecord = Static<typeof MemoryRecordSchema>;

export const MemoryCaptureRequestSchema = Type.Object({
  scope: MemoryScopeSchema,
  content: Type.String({ minLength: 1 }),
  idempotencyKey: IdempotencyKeySchema,
}, { additionalProperties: false });
export type MemoryCaptureRequest = Static<typeof MemoryCaptureRequestSchema>;

export const MemoryRecallRequestSchema = Type.Object({
  scopes: Type.Array(MemoryScopeSchema, { minItems: 1 }),
  cue: Type.String({ minLength: 1 }),
  kinds: Type.Optional(Type.Array(MemoryKindSchema)),
  maxCards: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  maxColdTopics: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
}, { additionalProperties: false });
export type MemoryRecallRequest = Static<typeof MemoryRecallRequestSchema>;

/**
 * v1 admin recall derives scopes from the authenticated principal. Supplying a
 * scope in the payload is rejected by `additionalProperties: false`.
 */
export const PrincipalMemoryRecallRequestSchema = Type.Object({
  cue: Type.String({ minLength: 1 }),
  kinds: Type.Optional(Type.Array(MemoryKindSchema)),
  maxCards: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  maxColdTopics: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
}, { additionalProperties: false });
export type PrincipalMemoryRecallRequest = Static<typeof PrincipalMemoryRecallRequestSchema>;

export const MemoryRecallItemSchema = Type.Object({
  id: IdentifierSchema,
  kind: MemoryKindSchema,
  title: Type.String(),
  content: Type.String(),
  score: Type.Number({ minimum: 0, maximum: 1 }),
}, { additionalProperties: false });
export type MemoryRecallItem = Static<typeof MemoryRecallItemSchema>;

export const MemoryRecallResultSchema = Type.Object({
  items: Type.Array(MemoryRecallItemSchema),
  total: Type.Integer({ minimum: 0 }),
  coldTopicCount: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type MemoryRecallResult = Static<typeof MemoryRecallResultSchema>;

export const MemoryRecallResponseSchema = Type.Object({
  data: Type.Object({ result: MemoryRecallResultSchema }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type MemoryRecallResponse = Static<typeof MemoryRecallResponseSchema>;

export const MemoryGovernRequestSchema = Type.Object({
  scope: MemoryScopeSchema,
  memoryId: IdentifierSchema,
  action: Type.Union([Type.Literal("approve"), Type.Literal("reject"), Type.Literal("correct"), Type.Literal("resolve")]),
  reason: Type.String({ minLength: 1 }),
  changes: Type.Optional(JsonObjectSchema),
}, { additionalProperties: false });
export type MemoryGovernRequest = Static<typeof MemoryGovernRequestSchema>;

export const MemoryForgetRequestSchema = Type.Object({
  scope: MemoryScopeSchema,
  ids: Type.Optional(Type.Array(IdentifierSchema)),
  topicIds: Type.Optional(Type.Array(IdentifierSchema)),
  reason: Type.String({ minLength: 1 }),
  gracePeriodMs: Type.Optional(Type.Integer({ minimum: 1 })),
}, { additionalProperties: false });
export type MemoryForgetRequest = Static<typeof MemoryForgetRequestSchema>;

export const MemoryRecordResponseSchema = Type.Object({
  data: Type.Object({ record: MemoryRecordSchema }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type MemoryRecordResponse = Static<typeof MemoryRecordResponseSchema>;
