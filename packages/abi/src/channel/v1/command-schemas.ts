import { Type, type Static } from "typebox";
import { ApiErrorSchema } from "../../shared/envelopes.js";
import { IdentifierSchema, IsoDateTimeSchema, RequestIdSchema } from "../../shared/primitives.js";

export const TaskRunCommandTypeSchema = Type.Union([
  Type.Literal("task_run.steer"),
  Type.Literal("task_run.follow_up"),
  Type.Literal("task_run.cancel"),
  Type.Literal("task_run.resume"),
  Type.Literal("task_run.compact"),
]);
export type TaskRunCommandType = Static<typeof TaskRunCommandTypeSchema>;

const TaskRunCommandBase = {
  commandId: IdentifierSchema,
  expectedAttemptId: Type.Union([IdentifierSchema, Type.Null()]),
};

export const TaskRunSteerCommandSchema = Type.Object({
  ...TaskRunCommandBase,
  type: Type.Literal("task_run.steer"),
  payload: Type.Object({ content: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
}, { additionalProperties: false });
export type TaskRunSteerCommand = Static<typeof TaskRunSteerCommandSchema>;

export const TaskRunFollowUpCommandSchema = Type.Object({
  ...TaskRunCommandBase,
  type: Type.Literal("task_run.follow_up"),
  payload: Type.Object({ content: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
}, { additionalProperties: false });
export type TaskRunFollowUpCommand = Static<typeof TaskRunFollowUpCommandSchema>;

export const TaskRunCancelCommandSchema = Type.Object({
  ...TaskRunCommandBase,
  type: Type.Literal("task_run.cancel"),
  payload: Type.Object({ reason: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
}, { additionalProperties: false });
export type TaskRunCancelCommand = Static<typeof TaskRunCancelCommandSchema>;

export const TaskRunResumeCommandSchema = Type.Object({
  ...TaskRunCommandBase,
  type: Type.Literal("task_run.resume"),
  payload: Type.Object({ reason: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
}, { additionalProperties: false });
export type TaskRunResumeCommand = Static<typeof TaskRunResumeCommandSchema>;

export const TaskRunCompactCommandSchema = Type.Object({
  ...TaskRunCommandBase,
  type: Type.Literal("task_run.compact"),
  payload: Type.Object({ reason: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
}, { additionalProperties: false });
export type TaskRunCompactCommand = Static<typeof TaskRunCompactCommandSchema>;

export const TaskRunCommandSchema = Type.Union([
  TaskRunSteerCommandSchema,
  TaskRunFollowUpCommandSchema,
  TaskRunCancelCommandSchema,
  TaskRunResumeCommandSchema,
  TaskRunCompactCommandSchema,
]);
export type TaskRunCommand = Static<typeof TaskRunCommandSchema>;

export const CommandReceiptSchema = Type.Object({
  commandId: IdentifierSchema,
  taskRunId: IdentifierSchema,
  type: TaskRunCommandTypeSchema,
  status: Type.Union([Type.Literal("accepted"), Type.Literal("duplicate"), Type.Literal("rejected")]),
  requestId: RequestIdSchema,
  error: Type.Union([ApiErrorSchema, Type.Null()]),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type CommandReceipt = Static<typeof CommandReceiptSchema>;

export const CommandResponseSchema = Type.Object({
  data: Type.Object({ receipt: CommandReceiptSchema }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type CommandResponse = Static<typeof CommandResponseSchema>;
