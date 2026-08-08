import { Type, type Static } from "typebox";
import { IdentifierSchema, IsoDateTimeSchema, JsonObjectSchema } from "../../shared/primitives.js";
import { TaskRunPhaseSchema, TaskRunStatusSchema } from "./session-schemas.js";

export const TaskObjectiveSchema = Type.Object({
  id: IdentifierSchema,
  summary: Type.String({ minLength: 1 }),
  timing: Type.Union([Type.Literal("current"), Type.Literal("follow_up"), Type.Literal("parallel")]),
  kind: Type.Union([
    Type.Literal("change"), Type.Literal("investigate"), Type.Literal("verify"),
    Type.Literal("document"), Type.Literal("release"), Type.Literal("answer"), Type.Literal("other"),
  ]),
});
export type TaskObjective = Static<typeof TaskObjectiveSchema>;

export const TaskRunContractSchema = Type.Object({
  sourceInput: Type.String(),
  summary: Type.String(),
  objectives: Type.Array(TaskObjectiveSchema),
  acceptanceCriteria: Type.Array(Type.String()),
  scope: Type.String(),
  nonGoals: Type.Array(Type.String()),
  sourceSubmissionIds: Type.Array(IdentifierSchema),
  parentTaskRunId: Type.Union([IdentifierSchema, Type.Null()]),
  relation: Type.Union([
    Type.Literal("same_goal"), Type.Literal("correction"), Type.Literal("constraint"),
    Type.Literal("follow_up"), Type.Literal("parallel"), Type.Literal("derived"),
    Type.Literal("depends_on"), Type.Literal("independent"),
  ]),
  intent: Type.Union([
    Type.Literal("steer_active"), Type.Literal("follow_up_active"), Type.Literal("update_active_context"),
    Type.Literal("new_task"), Type.Literal("parallel_task"), Type.Literal("merge_candidate"),
    Type.Literal("discussion"), Type.Literal("clarification"), Type.Literal("defer"),
  ]),
  decisionReason: Type.String(),
  routerVersion: Type.String(),
});
export type TaskRunContract = Static<typeof TaskRunContractSchema>;

export const TaskRunPlanItemSchema = Type.Object({
  key: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  status: Type.Union([
    Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done"),
    Type.Literal("blocked"), Type.Literal("skipped"),
  ]),
  required: Type.Boolean(),
  position: Type.Integer({ minimum: 0 }),
});
export type TaskRunPlanItem = Static<typeof TaskRunPlanItemSchema>;

export const TaskRunCheckSchema = Type.Object({
  key: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  status: Type.Union([
    Type.Literal("pending"), Type.Literal("running"), Type.Literal("passed"),
    Type.Literal("failed"), Type.Literal("blocked"), Type.Literal("skipped"),
  ]),
  required: Type.Boolean(),
  command: Type.String(),
  evidence: Type.String(),
  stale: Type.Boolean(),
  sourceOperationId: Type.Union([IdentifierSchema, Type.Null()]),
  observedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
});
export type TaskRunCheck = Static<typeof TaskRunCheckSchema>;

export const TaskRunCheckpointSchema = Type.Object({
  taskRunId: IdentifierSchema,
  attempt: Type.Integer({ minimum: 1 }),
  active: Type.Boolean(),
  assistantPartial: Type.String(),
  currentTool: Type.Union([
    Type.Object({
      toolCallId: IdentifierSchema,
      toolName: Type.String({ minLength: 1 }),
      startedAt: Type.Optional(IsoDateTimeSchema),
      lastActivityAt: Type.Optional(IsoDateTimeSchema),
    }),
    Type.Null(),
  ]),
  lastEventSequence: Type.Integer({ minimum: 0 }),
  lastTranscriptSequence: Type.Integer({ minimum: 0 }),
  updatedAt: IsoDateTimeSchema,
});
export type TaskRunCheckpoint = Static<typeof TaskRunCheckpointSchema>;

export const TaskRunContinuationSchema = Type.Object({
  id: IdentifierSchema,
  ordinal: Type.Integer({ minimum: 1 }),
  status: Type.Union([
    Type.Literal("queued"), Type.Literal("running"), Type.Literal("completed"),
    Type.Literal("blocked"), Type.Literal("failed"), Type.Literal("cancelled"),
  ]),
  reason: Type.String(),
  error: Type.String(),
  createdAt: IsoDateTimeSchema,
  startedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  completedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
});
export type TaskRunContinuation = Static<typeof TaskRunContinuationSchema>;

export const TaskRunArtifactSchema = Type.Object({
  id: IdentifierSchema,
  taskRunId: IdentifierSchema,
  kind: Type.String({ minLength: 1 }),
  title: Type.String({ minLength: 1 }),
  uri: Type.String(),
  createdAt: IsoDateTimeSchema,
});
export type TaskRunArtifact = Static<typeof TaskRunArtifactSchema>;

export const TaskRunSchema = Type.Object({
  id: IdentifierSchema,
  sessionId: IdentifierSchema,
  submissionId: IdentifierSchema,
  status: TaskRunStatusSchema,
  phase: TaskRunPhaseSchema,
  goal: Type.String(),
  modelId: Type.String({ minLength: 1 }),
  reasoningEffort: Type.Union([
    Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"),
    Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
  ]),
  contract: Type.Union([TaskRunContractSchema, Type.Null()]),
  blockedReason: Type.String(),
  lastEventSequence: Type.Integer({ minimum: 0 }),
  attempt: Type.Integer({ minimum: 1 }),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  completedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  resumedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  usage: Type.Object({
    input: Type.Number({ minimum: 0 }),
    output: Type.Number({ minimum: 0 }),
    cacheRead: Type.Number({ minimum: 0 }),
    cacheWrite: Type.Number({ minimum: 0 }),
    totalTokens: Type.Number({ minimum: 0 }),
    cost: Type.Number({ minimum: 0 }),
  }),
  transcriptCount: Type.Integer({ minimum: 0 }),
  checkpoint: Type.Union([TaskRunCheckpointSchema, Type.Null()]),
  continuations: Type.Array(TaskRunContinuationSchema),
  plan: Type.Array(TaskRunPlanItemSchema),
  checks: Type.Array(TaskRunCheckSchema),
  artifacts: Type.Array(TaskRunArtifactSchema),
  completionGate: Type.Object({
    passed: Type.Boolean(),
    failures: Type.Array(Type.Object({
      kind: Type.String(),
      key: Type.String(),
      reason: Type.String(),
    })),
  }),
  supervision: JsonObjectSchema,
  launchRetryable: Type.Boolean(),
  resumable: Type.Boolean(),
});
export type TaskRun = Static<typeof TaskRunSchema>;
