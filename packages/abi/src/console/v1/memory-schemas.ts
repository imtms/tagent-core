import { Type, type Static } from "typebox";
import {
  MemorySourceReferenceSchema,
  type MemorySourceReference,
} from "../../admin/v1/memory-schemas.js";
import { TimestampMillisecondsSchema } from "../../shared/primitives.js";

export const ConsoleMemoryKindSchema = Type.Union([
  Type.Literal("fact"), Type.Literal("preference"), Type.Literal("episode"), Type.Literal("procedure"),
]);
export type ConsoleMemoryKind = Static<typeof ConsoleMemoryKindSchema>;

export const ConsoleMemoryTierSchema = Type.Union([Type.Literal("hot"), Type.Literal("warm")]);
export type ConsoleMemoryTier = Static<typeof ConsoleMemoryTierSchema>;

export const ConsoleMemoryStatusSchema = Type.Union([
  Type.Literal("candidate"), Type.Literal("active"), Type.Literal("stale"),
  Type.Literal("superseded"), Type.Literal("disputed"), Type.Literal("quarantined"), Type.Literal("deleted"),
]);
export type ConsoleMemoryStatus = Static<typeof ConsoleMemoryStatusSchema>;

export const ConsoleMemoryScopeSchema = Type.Object({
  type: Type.Union([Type.Literal("user"), Type.Literal("workspace"), Type.Literal("project"), Type.Literal("session")]),
  id: Type.String(),
});
export type ConsoleMemoryScope = Static<typeof ConsoleMemoryScopeSchema>;

export const ConsoleMemorySourceRefSchema = MemorySourceReferenceSchema;
export type ConsoleMemorySourceRef = MemorySourceReference;

export const ConsoleMemoryProvenanceSchema = Type.Object({
  evidenceClass: Type.Union([
    Type.Literal("user_explicit"), Type.Literal("user_context_summary"), Type.Literal("tool_verified_fact"),
    Type.Literal("task_outcome"), Type.Literal("assistant_inference"),
  ]),
  trustLevel: Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low"), Type.Literal("untrusted")]),
  sourceRole: Type.Union([Type.Literal("user"), Type.Literal("tool"), Type.Literal("task"), Type.Literal("assistant"), Type.Literal("system")]),
  verificationState: Type.Union([Type.Literal("explicit"), Type.Literal("verified"), Type.Literal("structured"), Type.Literal("inferred"), Type.Literal("unverified")]),
  sourceReliability: Type.Optional(Type.Number()),
});

export const ConsoleMemorySemanticSchema = Type.Object({
  subject: Type.String(), predicate: Type.String(), object: Type.String(),
  polarity: Type.Union([Type.Literal("positive"), Type.Literal("negative"), Type.Literal("unknown")]),
});

export const ConsoleMemoryLifecycleSchema = Type.Object({
  firstSeenAt: TimestampMillisecondsSchema,
  lastSeenAt: TimestampMillisecondsSchema,
  confirmationCount: Type.Number(),
  lastRecalledAt: Type.Optional(TimestampMillisecondsSchema),
  recallCount: Type.Optional(Type.Number()),
  staleAt: Type.Optional(TimestampMillisecondsSchema),
  deletedAt: Type.Optional(TimestampMillisecondsSchema),
  purgeAfter: Type.Optional(TimestampMillisecondsSchema),
  deleteReason: Type.Optional(Type.String()),
  previousStatus: Type.Optional(ConsoleMemoryStatusSchema),
});

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
  provenance: Type.Optional(ConsoleMemoryProvenanceSchema),
  semantic: Type.Optional(ConsoleMemorySemanticSchema),
  lifecycle: Type.Optional(ConsoleMemoryLifecycleSchema),
  validFrom: Type.Optional(TimestampMillisecondsSchema),
  validTo: Type.Optional(TimestampMillisecondsSchema),
  supersedesId: Type.Optional(Type.String()),
  expiresAt: Type.Optional(TimestampMillisecondsSchema),
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
  provenance: Type.Optional(ConsoleMemoryProvenanceSchema),
  semantic: Type.Optional(ConsoleMemorySemanticSchema),
  lifecycle: Type.Optional(ConsoleMemoryLifecycleSchema),
  supersedesId: Type.Optional(Type.String()),
  expiresAt: Type.Optional(TimestampMillisecondsSchema),
  createdAt: TimestampMillisecondsSchema,
  updatedAt: TimestampMillisecondsSchema,
});
export type ConsolePreferenceRecord = Static<typeof ConsolePreferenceRecordSchema>;

export const ConsoleWarmMemorySchema = Type.Union([ConsoleMemoryRecordSchema, ConsolePreferenceRecordSchema]);
export type ConsoleWarmMemory = Static<typeof ConsoleWarmMemorySchema>;

export const ConsoleMemoryRecordPageSchema=Type.Object({records:Type.Array(ConsoleWarmMemorySchema),snapshotCreatedAt:TimestampMillisecondsSchema});
export type ConsoleMemoryRecordPage=Static<typeof ConsoleMemoryRecordPageSchema>;

export const ConsoleTopicDescriptorSchema = Type.Object({
  topicId: Type.String(), kind: ConsoleMemoryKindSchema, scope: ConsoleMemoryScopeSchema,
  title: Type.String(), description: Type.String(), aliases: Type.Array(Type.String()),
  entityIds: Type.Array(Type.String()), relatedTopicIds: Type.Array(Type.String()),
  coldRevisionId: Type.Optional(Type.String()), status: ConsoleMemoryStatusSchema,
  embeddingText: Type.Optional(Type.String()),
  lifecycle: Type.Optional(Type.Object({
    deletedAt: Type.Optional(TimestampMillisecondsSchema), purgeAfter: Type.Optional(TimestampMillisecondsSchema),
    deleteReason: Type.Optional(Type.String()), previousStatus: Type.Optional(ConsoleMemoryStatusSchema),
  })),
  createdAt: TimestampMillisecondsSchema, updatedAt: TimestampMillisecondsSchema,
});
export type ConsoleTopicDescriptor = Static<typeof ConsoleTopicDescriptorSchema>;

export const ConsoleMemoryTopicPageSchema=Type.Object({topics:Type.Array(ConsoleTopicDescriptorSchema),snapshotCreatedAt:TimestampMillisecondsSchema});
export type ConsoleMemoryTopicPage=Static<typeof ConsoleMemoryTopicPageSchema>;

export const ConsoleColdTopicSchema = Type.Object({
  descriptor: ConsoleTopicDescriptorSchema,
  revision: Type.Object({
    id: Type.String(), revision: Type.Number(), checksum: Type.String(), tokenCount: Type.Number(),
    state: Type.Optional(Type.Union([Type.Literal("staged"), Type.Literal("published"), Type.Literal("superseded")])),
    objectKey: Type.Optional(Type.String()), byteLength: Type.Optional(Type.Number()),
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

export const ConsoleMemoryRetrievalChannelSchema = Type.Union([
  Type.Literal("lexical"), Type.Literal("vector"), Type.Literal("topic"), Type.Literal("graph"), Type.Literal("canonical"),
]);

export const ConsoleMemoryScoreBreakdownSchema = Type.Object({
  route: Type.Number(), confidence: Type.Number(), importance: Type.Number(), recency: Type.Number(),
  scope: Type.Number(), trust: Type.Number(), validity: Type.Number(), currentState: Type.Number(),
  feedback: Type.Number(), final: Type.Number(),
});

export const ConsoleMemoryCardSchema = Type.Object({
  id: Type.String(), kind: ConsoleMemoryKindSchema, tier: ConsoleMemoryTierSchema,
  title: Type.String(), content: Type.String(), score: Type.Number(), topicIds: Type.Array(Type.String()),
  confidence: Type.Number(),
  status: Type.Optional(ConsoleMemoryStatusSchema),
  provenance: Type.Optional(ConsoleMemoryProvenanceSchema),
  semantic: Type.Optional(ConsoleMemorySemanticSchema),
  validFrom: Type.Optional(TimestampMillisecondsSchema), validTo: Type.Optional(TimestampMillisecondsSchema),
  retrievalChannels: Type.Optional(Type.Array(ConsoleMemoryRetrievalChannelSchema)),
  scoreBreakdown: Type.Optional(ConsoleMemoryScoreBreakdownSchema),
});
export type ConsoleMemoryCard = Static<typeof ConsoleMemoryCardSchema>;

export const ConsoleRecallResultSchema = Type.Object({
  cards: Type.Array(ConsoleMemoryCardSchema), coldTopics: Type.Array(ConsoleColdTopicSchema),
  trace: Type.Object({
    topicIds: Type.Array(Type.String()), candidateCount: Type.Number(), deniedCount: Type.Number(),
    version: Type.Optional(Type.Literal(2)),
    embedding: Type.Optional(Type.Object({
      configured: Type.Boolean(), degraded: Type.Boolean(), generation: Type.Optional(Type.String()), error: Type.Optional(Type.String()),
    })),
    policyTransforms: Type.Optional(Type.Number()),
    coldTopicRoutes: Type.Optional(Type.Array(Type.Object({
      topicId: Type.String(), channels: Type.Array(ConsoleMemoryRetrievalChannelSchema), selected: Type.Boolean(), reason: Type.String(),
    }))),
    candidates: Type.Optional(Type.Array(Type.Object({
      id: Type.String(), channels: Type.Array(ConsoleMemoryRetrievalChannelSchema),
      rawScores: Type.Record(Type.String(), Type.Number()), finalScore: Type.Optional(Type.Number()),
      scoreBreakdown: Type.Optional(ConsoleMemoryScoreBreakdownSchema),
      outcome: Type.Union([
        Type.Literal("selected"), Type.Literal("below_threshold"), Type.Literal("domain_filtered"), Type.Literal("duplicate"),
        Type.Literal("conflict"), Type.Literal("policy_denied"), Type.Literal("mmr_dropped"),
      ]),
      reason: Type.Optional(Type.String()),
    }))),
  }),
});
export type ConsoleRecallResult = Static<typeof ConsoleRecallResultSchema>;
