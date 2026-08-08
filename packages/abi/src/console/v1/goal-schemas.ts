import { Type, type Static } from "typebox";
import { JsonObjectSchema, TimestampMillisecondsSchema } from "../../shared/primitives.js";

export const ConsoleWorkspaceGoalStatusSchema = Type.Union([
  Type.Literal("draft"), Type.Literal("active"), Type.Literal("paused"),
  Type.Literal("ready_to_close"), Type.Literal("completed"), Type.Literal("cancelled"),
]);
export const ConsoleWorkspaceGoalNextActionSchema = Type.Object({
  actor: Type.Union([Type.Literal("user"), Type.Literal("system"), Type.Literal("none")]),
  kind: Type.Union([
    Type.Literal("review_goal"), Type.Literal("generate_roadmap"), Type.Literal("review_roadmap"),
    Type.Literal("run_roadmap_item"), Type.Literal("view_running_task"), Type.Literal("resolve_problem"),
    Type.Literal("resume"), Type.Literal("view_result"),
  ]),
  title: Type.String(), explanation: Type.String(), primaryActionLabel: Type.String(), roadmapItemId: Type.Union([Type.String(), Type.Null()]),
});
export const ConsoleWorkspaceGoalCriterionSchema = Type.Object({ key: Type.String(), title: Type.String(), required: Type.Boolean() });
export const ConsoleWorkspaceGoalDefinitionSchema = Type.Object({
  title: Type.String(), outcome: Type.String(), scope: Type.Array(Type.String()), nonGoals: Type.Array(Type.String()),
  criteria: Type.Array(ConsoleWorkspaceGoalCriterionSchema), completionPolicy: Type.Literal("user_confirm"),
});
export const ConsoleWorkspaceGoalRoadmapItemSchema = Type.Object({
  id: Type.String(), title: Type.String(), outcome: Type.String(), verification: Type.String(), criterionKeys: Type.Array(Type.String()),
});
export const ConsoleWorkspaceGoalRoadmapSchema = Type.Object({
  summary: Type.String(), items: Type.Array(ConsoleWorkspaceGoalRoadmapItemSchema),
});
export const ConsoleWorkspaceGoalRevisionSchema = Type.Object({
  id: Type.String(), goalId: Type.String(), kind: Type.Union([Type.Literal("definition"), Type.Literal("roadmap")]),
  revision: Type.Number(), content: Type.Union([ConsoleWorkspaceGoalDefinitionSchema, ConsoleWorkspaceGoalRoadmapSchema]),
  contentHash: Type.String(), sourceArtifactId: Type.Union([Type.String(), Type.Null()]), createdBy: Type.String(), createdAt: TimestampMillisecondsSchema,
});
export const ConsoleWorkspaceGoalDecisionSchema = Type.Object({
  id: Type.String(), requestId: Type.String(), payloadHash: Type.String(), goalId: Type.String(), targetRevisionId: Type.String(), targetHash: Type.String(),
  kind: Type.Union([Type.Literal("approve_goal"), Type.Literal("approve_roadmap"), Type.Literal("request_change"), Type.Literal("pause"), Type.Literal("resume"), Type.Literal("close"), Type.Literal("cancel")]),
  approvedItemIds: Type.Array(Type.String()), reason: Type.String(), actorId: Type.String(), createdAt: TimestampMillisecondsSchema,
});
export const ConsoleWorkspaceGoalRunLinkSchema = Type.Object({
  goalId: Type.String(), runId: Type.String(), goalRevision: Type.Number(), roadmapRevisionId: Type.Union([Type.String(), Type.Null()]),
  roadmapItemIds: Type.Array(Type.String()), criterionKeys: Type.Array(Type.String()), mode: Type.Union([Type.Literal("workspace"), Type.Literal("roadmap")]), createdAt: TimestampMillisecondsSchema,
});
export const ConsoleWorkspaceGoalRoadmapProgressSchema = Type.Object({
  goalId: Type.String(), roadmapRevisionId: Type.String(), itemId: Type.String(),
  status: Type.Union([Type.Literal("unapproved"), Type.Literal("pending"), Type.Literal("running"), Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("skipped")]),
  runId: Type.Union([Type.String(), Type.Null()]), updatedAt: TimestampMillisecondsSchema, completedAt: Type.Union([TimestampMillisecondsSchema, Type.Null()]),
});
export const ConsoleWorkspaceGoalEvidenceLinkSchema = Type.Object({
  id: Type.String(), goalId: Type.String(), goalRevision: Type.Number(), criterionKey: Type.String(), runId: Type.String(),
  checkKey: Type.Union([Type.String(), Type.Null()]), artifactId: Type.Union([Type.String(), Type.Null()]), operationId: Type.Union([Type.String(), Type.Null()]),
  sourceDigest: Type.String(), status: Type.Union([Type.Literal("valid"), Type.Literal("stale"), Type.Literal("contradicted")]),
  createdAt: TimestampMillisecondsSchema, updatedAt: TimestampMillisecondsSchema,
});
export const ConsoleWorkspaceGoalSummarySchema = Type.Object({
  id: Type.String(), workspaceId: Type.String(), status: ConsoleWorkspaceGoalStatusSchema, title: Type.String(), outcome: Type.String(),
  requiredCriteria: Type.Number(), verifiedCriteria: Type.Number(), currentRunId: Type.Union([Type.String(), Type.Null()]),
  nextAction: ConsoleWorkspaceGoalNextActionSchema, createdAt: TimestampMillisecondsSchema, updatedAt: TimestampMillisecondsSchema,
});
export const ConsoleWorkspaceGoalSchema = Type.Object({
  id: Type.String(), workspaceId: Type.String(), status: ConsoleWorkspaceGoalStatusSchema,
  activeDefinitionRevisionId: Type.Union([Type.String(), Type.Null()]), activeRoadmapRevisionId: Type.Union([Type.String(), Type.Null()]),
  currentRunId: Type.Union([Type.String(), Type.Null()]), createdAt: TimestampMillisecondsSchema, updatedAt: TimestampMillisecondsSchema,
  completedAt: Type.Union([TimestampMillisecondsSchema, Type.Null()]), definition: Type.Union([ConsoleWorkspaceGoalRevisionSchema, Type.Null()]),
  roadmap: Type.Union([ConsoleWorkspaceGoalRevisionSchema, Type.Null()]), decisions: Type.Array(ConsoleWorkspaceGoalDecisionSchema),
  runLinks: Type.Array(ConsoleWorkspaceGoalRunLinkSchema), roadmapProgress: Type.Array(ConsoleWorkspaceGoalRoadmapProgressSchema), evidenceLinks: Type.Array(ConsoleWorkspaceGoalEvidenceLinkSchema),
  requiredCriteria: Type.Number(), verifiedCriteria: Type.Number(), nextAction: ConsoleWorkspaceGoalNextActionSchema,
});

export const ConsoleWorkspaceGoalSummariesSchema = Type.Array(ConsoleWorkspaceGoalSummarySchema);

export const ConsoleGenerateWorkspaceGoalRoadmapRequestSchema = Type.Object({
  requestId: Type.String({ minLength: 1, maxLength: 300 }),
  actorId: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
}, { additionalProperties: false });

const ConsoleGoalRequestIdSchema = Type.String({ minLength: 1, maxLength: 300 });
const ConsoleGoalActorIdSchema = Type.Optional(Type.String({ minLength: 1, maxLength: 300 }));

export const ConsoleCreateWorkspaceGoalRequestSchema = Type.Object({
  definition: ConsoleWorkspaceGoalDefinitionSchema,
  requestId: ConsoleGoalRequestIdSchema,
  actorId: ConsoleGoalActorIdSchema,
}, { additionalProperties: false });

export const ConsoleReviseWorkspaceGoalDefinitionRequestSchema = Type.Object({
  definition: ConsoleWorkspaceGoalDefinitionSchema,
  requestId: ConsoleGoalRequestIdSchema,
  actorId: ConsoleGoalActorIdSchema,
}, { additionalProperties: false });

export const ConsoleReviseWorkspaceGoalRoadmapRequestSchema = Type.Object({
  content: ConsoleWorkspaceGoalRoadmapSchema,
  requestId: ConsoleGoalRequestIdSchema,
  sourceArtifactId: Type.Optional(Type.Union([Type.String({ minLength: 1, maxLength: 300 }), Type.Null()])),
  actorId: ConsoleGoalActorIdSchema,
}, { additionalProperties: false });

export const ConsoleDecideWorkspaceGoalRequestSchema = Type.Object({
  requestId: ConsoleGoalRequestIdSchema,
  targetRevisionId: Type.String({ minLength: 1, maxLength: 300 }),
  targetHash: Type.String({ minLength: 1, maxLength: 128 }),
  kind: Type.Union([
    Type.Literal("approve_goal"), Type.Literal("approve_roadmap"), Type.Literal("request_change"),
    Type.Literal("pause"), Type.Literal("resume"), Type.Literal("close"), Type.Literal("cancel"),
  ]),
  approvedItemIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 200 })),
  reason: Type.Optional(Type.String({ maxLength: 4000 })),
  actorId: ConsoleGoalActorIdSchema,
}, { additionalProperties: false });

export const ConsoleStartWorkspaceGoalTaskRunRequestSchema = Type.Object({
  roadmapItemId: Type.String({ minLength: 1, maxLength: 300 }),
  requestId: ConsoleGoalRequestIdSchema,
}, { additionalProperties: false });

export const ConsoleStartWorkspaceGoalTaskRunResultSchema = Type.Object({
  goal: ConsoleWorkspaceGoalSchema,
  inboxItemId: Type.String({ minLength: 1 }),
  runId: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
}, { additionalProperties: false });

export const ConsoleWorkspaceGoalOperationReceiptSchema = Type.Object({
  goalId: Type.String({ minLength: 1 }), requestId: Type.String({ minLength: 1 }), operationType: Type.String({ minLength: 1 }),
  payloadHash: Type.String({ minLength: 1 }), payload: JsonObjectSchema,
  state: Type.Union([Type.Literal("started"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("outcome_unknown")]),
  result: Type.Union([JsonObjectSchema, Type.Null()]), error: Type.Union([JsonObjectSchema, Type.Null()]),
  createdAt: TimestampMillisecondsSchema, updatedAt: TimestampMillisecondsSchema, completedAt: Type.Union([TimestampMillisecondsSchema, Type.Null()]),
}, { additionalProperties: false });

export type ConsoleWorkspaceGoal = Static<typeof ConsoleWorkspaceGoalSchema>;
export type ConsoleWorkspaceGoalSummary = Static<typeof ConsoleWorkspaceGoalSummarySchema>;
export type ConsoleWorkspaceGoalDefinition = Static<typeof ConsoleWorkspaceGoalDefinitionSchema>;
export type ConsoleWorkspaceGoalRoadmap = Static<typeof ConsoleWorkspaceGoalRoadmapSchema>;
export type ConsoleWorkspaceGoalRoadmapItem = Static<typeof ConsoleWorkspaceGoalRoadmapItemSchema>;
export type ConsoleWorkspaceGoalRevision = Static<typeof ConsoleWorkspaceGoalRevisionSchema>;
export type ConsoleWorkspaceGoalDecision = Static<typeof ConsoleWorkspaceGoalDecisionSchema>;
export type ConsoleGenerateWorkspaceGoalRoadmapRequest = Static<typeof ConsoleGenerateWorkspaceGoalRoadmapRequestSchema>;
export type ConsoleCreateWorkspaceGoalRequest = Static<typeof ConsoleCreateWorkspaceGoalRequestSchema>;
export type ConsoleReviseWorkspaceGoalDefinitionRequest = Static<typeof ConsoleReviseWorkspaceGoalDefinitionRequestSchema>;
export type ConsoleReviseWorkspaceGoalRoadmapRequest = Static<typeof ConsoleReviseWorkspaceGoalRoadmapRequestSchema>;
export type ConsoleDecideWorkspaceGoalRequest = Static<typeof ConsoleDecideWorkspaceGoalRequestSchema>;
export type ConsoleStartWorkspaceGoalTaskRunRequest = Static<typeof ConsoleStartWorkspaceGoalTaskRunRequestSchema>;
export type ConsoleStartWorkspaceGoalTaskRunResult = Static<typeof ConsoleStartWorkspaceGoalTaskRunResultSchema>;
export type ConsoleWorkspaceGoalOperationReceipt = Static<typeof ConsoleWorkspaceGoalOperationReceiptSchema>;
