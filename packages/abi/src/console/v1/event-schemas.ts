import { Type, type Static } from "typebox";
import { JsonObjectSchema, TimestampMillisecondsSchema } from "../../shared/primitives.js";
import { ConsoleArtifactSchema } from "./core-schemas.js";

/** @deprecated Use EventConsumerCursor from channel/v1. */
export const ConsoleEventConsumerCursorSchema = Type.Object({
  runId: Type.String(),
  consumerId: Type.String(),
  generation: Type.Number(),
  ackedSeq: Type.Number(),
  terminalAckedSeq: Type.Union([Type.Number(), Type.Null()]),
  claimedAt: TimestampMillisecondsSchema,
  updatedAt: TimestampMillisecondsSchema,
});
/** @deprecated Use EventConsumerCursor from channel/v1. */
export type ConsoleEventConsumerCursor = Static<typeof ConsoleEventConsumerCursorSchema>;

/** @deprecated Use TaskRunEvent from channel/v1. */
export const ConsoleRunEventSchema = Type.Object({
  runId: Type.String(),
  seq: Type.Number(),
  type: Type.String(),
  data: JsonObjectSchema,
  createdAt: TimestampMillisecondsSchema,
});
/** @deprecated Use TaskRunEvent from channel/v1. */
export type ConsoleRunEvent = Static<typeof ConsoleRunEventSchema>;

/** @deprecated Use TranscriptItem from channel/v1. */
export const ConsoleTranscriptItemSchema = Type.Union([
  Type.Object({
    seq: Type.Number(), index: Type.Optional(Type.Number()), attempt: Type.Number(),
    kind: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    text: Type.String(), createdAt: TimestampMillisecondsSchema,
  }),
  Type.Object({
    seq: Type.Number(), index: Type.Number(), attempt: Type.Number(), kind: Type.Literal("thinking"),
    text: Type.String(), redacted: Type.Boolean(), createdAt: TimestampMillisecondsSchema,
  }),
  Type.Object({
    seq: Type.Number(), index: Type.Number(), attempt: Type.Number(), kind: Type.Literal("tool"),
    toolCallId: Type.String(), toolName: Type.String(), arguments: Type.Unknown(), result: Type.String(),
    isError: Type.Boolean(), status: Type.String(), createdAt: TimestampMillisecondsSchema,
  }),
]);
/** @deprecated Use TranscriptItem from channel/v1. */
export type ConsoleTranscriptItem = Static<typeof ConsoleTranscriptItemSchema>;

/** @deprecated Use ArtifactContent from channel/v1. */
export const ConsoleArtifactContentSchema = Type.Object({
  ...ConsoleArtifactSchema.properties,
  content: Type.String(),
  format: Type.Union([Type.Literal("markdown"), Type.Literal("text")]),
  bytes: Type.Number(),
  source: Type.Union([Type.Literal("inline"), Type.Literal("file")]),
});
/** @deprecated Use ArtifactContent from channel/v1. */
export type ConsoleArtifactContent = Static<typeof ConsoleArtifactContentSchema>;
