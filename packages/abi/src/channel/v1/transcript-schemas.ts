import { Type, type Static } from "typebox";
import { IdentifierSchema, IsoDateTimeSchema, RequestIdSchema } from "../../shared/primitives.js";
import { TaskRunArtifactSchema } from "./task-run-schemas.js";

const TranscriptBase = {
  sequence: Type.Integer({ minimum: 1 }),
  partIndex: Type.Optional(Type.Integer({ minimum: 0 })),
  attempt: Type.Integer({ minimum: 1 }),
  occurredAt: IsoDateTimeSchema,
};

export const TranscriptItemSchema = Type.Union([
  Type.Object({
    ...TranscriptBase,
    kind: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    text: Type.String(),
  }),
  Type.Object({
    ...TranscriptBase,
    kind: Type.Literal("thinking"),
    text: Type.String(),
    redacted: Type.Boolean(),
  }),
  Type.Object({
    ...TranscriptBase,
    kind: Type.Literal("tool"),
    toolCallId: IdentifierSchema,
    toolName: Type.String({ minLength: 1 }),
    arguments: Type.Unknown(),
    result: Type.String(),
    isError: Type.Boolean(),
    status: Type.String({ minLength: 1 }),
  }),
]);
export type TranscriptItem = Static<typeof TranscriptItemSchema>;

export const TranscriptQuerySchema = Type.Object({
  after: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
}, { additionalProperties: false });
export type TranscriptQuery = Static<typeof TranscriptQuerySchema>;

export const TranscriptResponseSchema = Type.Object({
  data: Type.Object({
    items: Type.Array(TranscriptItemSchema),
    pageInfo: Type.Object({
      nextCursor: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
      hasMore: Type.Boolean(),
      limit: Type.Integer({ minimum: 1, maximum: 500 }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type TranscriptResponse = Static<typeof TranscriptResponseSchema>;

export const ArtifactContentSchema = Type.Object({
  ...TaskRunArtifactSchema.properties,
  content: Type.String(),
  format: Type.Union([Type.Literal("markdown"), Type.Literal("text")]),
  bytes: Type.Integer({ minimum: 0 }),
  source: Type.Union([Type.Literal("inline"), Type.Literal("file")]),
});
export type ArtifactContent = Static<typeof ArtifactContentSchema>;

export const ArtifactListQuerySchema = Type.Object({
  after: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
}, { additionalProperties: false });
export type ArtifactListQuery = Static<typeof ArtifactListQuerySchema>;

export const ArtifactListResponseSchema = Type.Object({
  data: Type.Object({
    items: Type.Array(TaskRunArtifactSchema),
    pageInfo: Type.Object({
      nextCursor: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
      hasMore: Type.Boolean(),
      limit: Type.Integer({ minimum: 1, maximum: 200 }),
    }, { additionalProperties: false }),
  }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type ArtifactListResponse = Static<typeof ArtifactListResponseSchema>;

export const ArtifactContentResponseSchema = Type.Object({
  data: Type.Object({ artifact: ArtifactContentSchema }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type ArtifactContentResponse = Static<typeof ArtifactContentResponseSchema>;
