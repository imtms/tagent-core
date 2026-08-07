import { Type, type Static } from "typebox";
import { TimestampMillisecondsSchema } from "../../shared/primitives.js";

export const ConsoleWorkspaceGoalStatusSchema = Type.Union([
  Type.Literal("draft"), Type.Literal("active"), Type.Literal("paused"),
  Type.Literal("ready_to_close"), Type.Literal("completed"), Type.Literal("cancelled"),
]);
export const ConsoleWorkspaceGoalNextActionSchema = Type.Object({
  actor: Type.Union([Type.Literal("user"), Type.Literal("system"), Type.Literal("none")]),
  kind: Type.Union([
    Type.Literal("review_goal"), Type.Literal("create_plan"), Type.Literal("review_plan"),
    Type.Literal("run_task"), Type.Literal("view_running_task"), Type.Literal("resolve_problem"),
    Type.Literal("resume"), Type.Literal("view_result"),
  ]),
  title: Type.String(), explanation: Type.String(), primaryActionLabel: Type.String(),
});
export const ConsoleWorkspaceGoalCriterionSchema = Type.Object({ key: Type.String(), title: Type.String(), required: Type.Boolean() });
export const ConsoleWorkspaceGoalDefinitionSchema = Type.Object({
  title: Type.String(), outcome: Type.String(), scope: Type.Array(Type.String()), nonGoals: Type.Array(Type.String()),
  criteria: Type.Array(ConsoleWorkspaceGoalCriterionSchema), completionPolicy: Type.Literal("user_confirm"),
});
export const ConsoleWorkspaceGoalPlanItemSchema = Type.Object({
  id: Type.String(), title: Type.String(), outcome: Type.String(), verification: Type.String(),
});
export const ConsoleWorkspaceGoalPlanSchema = Type.Object({
  summary: Type.String(), items: Type.Array(ConsoleWorkspaceGoalPlanItemSchema),
});
export const ConsoleWorkspaceGoalRevisionSchema = Type.Object({
  id: Type.String(), goalId: Type.String(), kind: Type.Union([Type.Literal("definition"), Type.Literal("plan")]),
  revision: Type.Number(), content: Type.Union([ConsoleWorkspaceGoalDefinitionSchema, ConsoleWorkspaceGoalPlanSchema]),
  contentHash: Type.String(), sourceArtifactId: Type.Union([Type.String(), Type.Null()]), createdBy: Type.String(), createdAt: TimestampMillisecondsSchema,
});
export const ConsoleWorkspaceGoalDecisionSchema = Type.Object({
  id: Type.String(), requestId: Type.String(), payloadHash: Type.String(), goalId: Type.String(), targetRevisionId: Type.String(), targetHash: Type.String(),
  kind: Type.Union([Type.Literal("approve_goal"), Type.Literal("approve_plan"), Type.Literal("request_change"), Type.Literal("pause"), Type.Literal("resume"), Type.Literal("close"), Type.Literal("cancel")]),
  approvedItemIds: Type.Array(Type.String()), reason: Type.String(), actorId: Type.String(), createdAt: TimestampMillisecondsSchema,
});
export const ConsoleWorkspaceGoalRunLinkSchema = Type.Object({
  goalId: Type.String(), runId: Type.String(), goalRevision: Type.Number(), planRevisionId: Type.Union([Type.String(), Type.Null()]),
  approvedItemIds: Type.Array(Type.String()), criterionKeys: Type.Array(Type.String()), createdAt: TimestampMillisecondsSchema,
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
  activeDefinitionRevisionId: Type.Union([Type.String(), Type.Null()]), activePlanRevisionId: Type.Union([Type.String(), Type.Null()]),
  currentRunId: Type.Union([Type.String(), Type.Null()]), createdAt: TimestampMillisecondsSchema, updatedAt: TimestampMillisecondsSchema,
  completedAt: Type.Union([TimestampMillisecondsSchema, Type.Null()]), definition: Type.Union([ConsoleWorkspaceGoalRevisionSchema, Type.Null()]),
  plan: Type.Union([ConsoleWorkspaceGoalRevisionSchema, Type.Null()]), decisions: Type.Array(ConsoleWorkspaceGoalDecisionSchema),
  runLinks: Type.Array(ConsoleWorkspaceGoalRunLinkSchema), evidenceLinks: Type.Array(ConsoleWorkspaceGoalEvidenceLinkSchema),
  requiredCriteria: Type.Number(), verifiedCriteria: Type.Number(), nextAction: ConsoleWorkspaceGoalNextActionSchema,
});

export const ConsoleWorkspaceGoalSummariesSchema = Type.Array(ConsoleWorkspaceGoalSummarySchema);

export type ConsoleWorkspaceGoal = Static<typeof ConsoleWorkspaceGoalSchema>;
export type ConsoleWorkspaceGoalSummary = Static<typeof ConsoleWorkspaceGoalSummarySchema>;
export type ConsoleWorkspaceGoalDefinition = Static<typeof ConsoleWorkspaceGoalDefinitionSchema>;
export type ConsoleWorkspaceGoalPlan = Static<typeof ConsoleWorkspaceGoalPlanSchema>;
export type ConsoleWorkspaceGoalPlanItem = Static<typeof ConsoleWorkspaceGoalPlanItemSchema>;
export type ConsoleWorkspaceGoalDecision = Static<typeof ConsoleWorkspaceGoalDecisionSchema>;
