import { Type, type Static } from "typebox";
import { TimestampMillisecondsSchema } from "../../shared/primitives.js";

/** @deprecated Use MemoryKind from admin/v1. */
export const ConsoleMemoryKindSchema = Type.Union([
  Type.Literal("fact"), Type.Literal("preference"), Type.Literal("episode"), Type.Literal("procedure"),
]);
/** @deprecated Use MemoryKind from admin/v1. */
export type ConsoleMemoryKind = Static<typeof ConsoleMemoryKindSchema>;

export const ConsoleMemoryTierSchema = Type.Union([Type.Literal("hot"), Type.Literal("warm")]);
export type ConsoleMemoryTier = Static<typeof ConsoleMemoryTierSchema>;

export const ConsoleMemoryStatusSchema = Type.Union([
  Type.Literal("candidate"), Type.Literal("active"), Type.Literal("stale"),
  Type.Literal("superseded"), Type.Literal("disputed"), Type.Literal("quarantined"), Type.Literal("deleted"),
]);
export type ConsoleMemoryStatus = Static<typeof ConsoleMemoryStatusSchema>;

/** @deprecated Use MemoryScope from admin/v1. */
export const ConsoleMemoryScopeSchema = Type.Object({
  type: Type.Union([Type.Literal("user"), Type.Literal("workspace"), Type.Literal("project"), Type.Literal("session")]),
  id: Type.String(),
});
/** @deprecated Use MemoryScope from admin/v1. */
export type ConsoleMemoryScope = Static<typeof ConsoleMemoryScopeSchema>;

export const ConsoleMemorySourceRefSchema = Type.Object({
  sourceType: Type.Union([Type.Literal("message"), Type.Literal("run"), Type.Literal("transcript"), Type.Literal("manual")]),
  sourceId: Type.String(),
  revision: Type.Optional(Type.String()),
});
export type ConsoleMemorySourceRef = Static<typeof ConsoleMemorySourceRefSchema>;

export const ConsoleMemoryRecordSchema = Type.Object({
  id: Type.String(),
  kind: Type.Union([Type.Literal("fact"), Type.Literal("episode"), Type.Literal("procedure")]),
  tier: ConsoleMemoryTierSchema,
  scope: ConsoleMemoryScopeSchema,
  title: Type.String(),
  content: Type.String(),
  summary: Type.String(),
  topicIds: Type.Array(Type.String()),
  entityIds: Type.Array(Type.String()),
  status: ConsoleMemoryStatusSchema,
  confidence: Type.Number(),
  importance: Type.Number(),
  sourceRefs: Type.Array(ConsoleMemorySourceRefSchema),
  createdAt: TimestampMillisecondsSchema,
  updatedAt: TimestampMillisecondsSchema,
});
export type ConsoleMemoryRecord = Static<typeof ConsoleMemoryRecordSchema>;

export const ConsolePreferenceRecordSchema = Type.Object({
  id: Type.String(),
  kind: Type.Literal("preference"),
  tier: ConsoleMemoryTierSchema,
  scope: ConsoleMemoryScopeSchema,
  dimension: Type.String(),
  value: Type.String(),
  summary: Type.String(),
  topicIds: Type.Array(Type.String()),
  entityIds: Type.Array(Type.String()),
  applicability: Type.Union([Type.Literal("global"), Type.Literal("workspace"), Type.Literal("project"), Type.Literal("task")]),
  strength: Type.Number(),
  origin: Type.Union([Type.Literal("explicit"), Type.Literal("repeated"), Type.Literal("inferred")]),
  status: ConsoleMemoryStatusSchema,
  confidence: Type.Number(),
  sourceRefs: Type.Array(ConsoleMemorySourceRefSchema),
  createdAt: TimestampMillisecondsSchema,
  updatedAt: TimestampMillisecondsSchema,
});
export type ConsolePreferenceRecord = Static<typeof ConsolePreferenceRecordSchema>;

export const ConsoleWarmMemorySchema = Type.Union([ConsoleMemoryRecordSchema, ConsolePreferenceRecordSchema]);
export type ConsoleWarmMemory = Static<typeof ConsoleWarmMemorySchema>;

export const ConsoleTopicDescriptorSchema = Type.Object({
  topicId: Type.String(), kind: ConsoleMemoryKindSchema, scope: ConsoleMemoryScopeSchema,
  title: Type.String(), description: Type.String(), aliases: Type.Array(Type.String()),
  entityIds: Type.Array(Type.String()), relatedTopicIds: Type.Array(Type.String()),
  coldRevisionId: Type.Optional(Type.String()), status: ConsoleMemoryStatusSchema,
  updatedAt: TimestampMillisecondsSchema,
});
export type ConsoleTopicDescriptor = Static<typeof ConsoleTopicDescriptorSchema>;

export const ConsoleColdTopicSchema = Type.Object({
  descriptor: ConsoleTopicDescriptorSchema,
  revision: Type.Object({
    id: Type.String(), revision: Type.Number(), checksum: Type.String(), tokenCount: Type.Number(),
    createdAt: TimestampMillisecondsSchema, publishedAt: Type.Optional(TimestampMillisecondsSchema),
  }),
  body: Type.String(),
});
export type ConsoleColdTopic = Static<typeof ConsoleColdTopicSchema>;

export const ConsoleCaptureJobSchema = Type.Object({
  id: Type.String(),
  status: Type.Union([
    Type.Literal("queued"), Type.Literal("running"), Type.Literal("completed"),
    Type.Literal("completed_empty"), Type.Literal("retryable_failed"), Type.Literal("dead_letter"),
  ]),
  attempts: Type.Number(), errorCode: Type.Optional(Type.String()), proposalCount: Type.Optional(Type.Number()),
  persistedCount: Type.Optional(Type.Number()), createdAt: TimestampMillisecondsSchema, updatedAt: TimestampMillisecondsSchema,
  request: Type.Object({
    sourceRefs: Type.Array(ConsoleMemorySourceRefSchema),
    captureSource: Type.Optional(Type.Object({ kind: Type.String(), role: Type.String() })),
  }),
});
export type ConsoleCaptureJob = Static<typeof ConsoleCaptureJobSchema>;

export const ConsoleMemoryStatusResultSchema = Type.Object({
  records: Type.Object({ hot: Type.Number(), warm: Type.Number(), candidate: Type.Number(), active: Type.Number(), disputed: Type.Number() }),
  topics: Type.Number(), coldTopics: Type.Number(), readiness: Type.Optional(Type.Unknown()),
});
export type ConsoleMemoryStatusResult = Static<typeof ConsoleMemoryStatusResultSchema>;

export const ConsoleReindexJobSchema = Type.Object({
  id: Type.String(), generation: Type.String(), status: Type.String(),
  checkpoint: Type.Object({
    processed: Type.Number(), indexed: Type.Number(), skipped: Type.Number(), failed: Type.Number(),
    total: Type.Optional(Type.Number()), phase: Type.String(),
  }),
  createdAt: TimestampMillisecondsSchema, updatedAt: TimestampMillisecondsSchema,
});
export type ConsoleReindexJob = Static<typeof ConsoleReindexJobSchema>;

export const ConsoleCoreMemorySnapshotSchema = Type.Object({
  revision: Type.Number(), markdown: Type.String(), sourceRecordIds: Type.Array(Type.String()),
  tokenCount: Type.Number(), generatedAt: TimestampMillisecondsSchema, editedAt: Type.Optional(TimestampMillisecondsSchema),
});
export type ConsoleCoreMemorySnapshot = Static<typeof ConsoleCoreMemorySnapshotSchema>;

export const ConsoleMemoryExportSchema = Type.Object({
  records: Type.Array(ConsoleWarmMemorySchema), topics: Type.Array(ConsoleColdTopicSchema),
});
export type ConsoleMemoryExport = Static<typeof ConsoleMemoryExportSchema>;

export const ConsoleMemoryCardSchema = Type.Object({
  id: Type.String(), kind: ConsoleMemoryKindSchema, tier: ConsoleMemoryTierSchema,
  title: Type.String(), content: Type.String(), score: Type.Number(), topicIds: Type.Array(Type.String()),
  confidence: Type.Number(),
});
export type ConsoleMemoryCard = Static<typeof ConsoleMemoryCardSchema>;

export const ConsoleRecallResultSchema = Type.Object({
  cards: Type.Array(ConsoleMemoryCardSchema), coldTopics: Type.Array(ConsoleColdTopicSchema),
  trace: Type.Object({ topicIds: Type.Array(Type.String()), candidateCount: Type.Number(), deniedCount: Type.Number() }),
});
export type ConsoleRecallResult = Static<typeof ConsoleRecallResultSchema>;
