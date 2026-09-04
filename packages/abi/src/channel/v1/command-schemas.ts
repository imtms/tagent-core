import { Type, type Static } from "typebox";
import { ApiErrorSchema } from "../../shared/envelopes.js";
import { IdentifierSchema, IsoDateTimeSchema, JsonObjectSchema, RequestIdSchema } from "../../shared/primitives.js";
import { GatewayProvenanceSchema, GatewayRequestAuditSchema } from "./provenance-schemas.js";
import { canonicalJson } from "../../shared/canonical-json.js";

export const TASK_RUN_COMMAND_TYPES = [
  "task_run.steer",
  "task_run.follow_up",
  "task_run.cancel",
  "task_run.resume",
  "task_run.compact",
  "task_run.submit_user_input",
  "task_run.resolve_approval",
  "task_run.accept_uncertainty",
] as const;

export const TaskRunCommandTypeSchema = Type.Union([
  Type.Literal("task_run.steer"),
  Type.Literal("task_run.follow_up"),
  Type.Literal("task_run.cancel"),
  Type.Literal("task_run.resume"),
  Type.Literal("task_run.compact"),
  Type.Literal("task_run.submit_user_input"),
  Type.Literal("task_run.resolve_approval"),
  Type.Literal("task_run.accept_uncertainty"),
]);
export type TaskRunCommandType = Static<typeof TaskRunCommandTypeSchema>;

const TaskRunCommandBase = {
  commandId: IdentifierSchema,
  expectedAttemptId: Type.Union([IdentifierSchema, Type.Null()]),
  origin: Type.Optional(GatewayProvenanceSchema),
};

export const TaskRunSteerCommandSchema = Type.Object({
  ...TaskRunCommandBase,
  type: Type.Literal("task_run.steer"),
  payload: Type.Object({ content: Type.String({ minLength: 1, maxLength: 200_000 }) }, { additionalProperties: false }),
}, { additionalProperties: false });
export type TaskRunSteerCommand = Static<typeof TaskRunSteerCommandSchema>;

export const TaskRunFollowUpCommandSchema = Type.Object({
  ...TaskRunCommandBase,
  type: Type.Literal("task_run.follow_up"),
  payload: Type.Object({ content: Type.String({ minLength: 1, maxLength: 200_000 }) }, { additionalProperties: false }),
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

export const TaskRunSubmitUserInputCommandSchema = Type.Object({
  ...TaskRunCommandBase,
  type: Type.Literal("task_run.submit_user_input"),
  payload: Type.Object({
    requestId: IdentifierSchema,
    response: Type.Record(Type.String({ minLength: 1, maxLength: 200 }), Type.String({ maxLength: 20_000 })),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export type TaskRunSubmitUserInputCommand = Static<typeof TaskRunSubmitUserInputCommandSchema>;

export const TaskRunResolveApprovalCommandSchema = Type.Object({
  ...TaskRunCommandBase,
  type: Type.Literal("task_run.resolve_approval"),
  payload: Type.Object({
    approvalRequestId: IdentifierSchema,
    decision: Type.Union([Type.Literal("approved"), Type.Literal("rejected")]),
    resolution: Type.Optional(Type.String({ minLength: 1, maxLength: 4_000 })),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export type TaskRunResolveApprovalCommand = Static<typeof TaskRunResolveApprovalCommandSchema>;

export const TaskRunAcceptUncertaintyCommandSchema = Type.Object({
  ...TaskRunCommandBase,
  type: Type.Literal("task_run.accept_uncertainty"),
  payload: Type.Object({
    criterionId: Type.String({ minLength: 4, maxLength: 256, pattern: "^ac-[1-9][0-9]*$" }),
    rationale: Type.String({ minLength: 1, maxLength: 4_000, pattern: "^[^\\u0000]+$" }),
    scope: Type.String({ minLength: 1, maxLength: 2_000, pattern: "^[^\\u0000]+$" }),
    evidenceRefs: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2_000, pattern: "^[^\\u0000]+$" }), { maxItems: 100 })),
    expiresAt: Type.Optional(Type.Union([IsoDateTimeSchema, Type.Null()])),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export type TaskRunAcceptUncertaintyCommand = Static<typeof TaskRunAcceptUncertaintyCommandSchema>;

export const TaskRunCommandSchema = Type.Union([
  TaskRunSteerCommandSchema,
  TaskRunFollowUpCommandSchema,
  TaskRunCancelCommandSchema,
  TaskRunResumeCommandSchema,
  TaskRunCompactCommandSchema,
  TaskRunSubmitUserInputCommandSchema,
  TaskRunResolveApprovalCommandSchema,
  TaskRunAcceptUncertaintyCommandSchema,
]);
export type TaskRunCommand = Static<typeof TaskRunCommandSchema>;

export function canonicalizeTaskRunCommand(command: TaskRunCommand): string {
  return canonicalJson(command);
}

export const CommandReceiptSchema = Type.Object({
  commandId: IdentifierSchema,
  taskRunId: IdentifierSchema,
  type: TaskRunCommandTypeSchema,
  state: Type.Union([Type.Literal("started"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("outcome_unknown")]),
  outcome: Type.Union([Type.Literal("accepted"), Type.Literal("rejected"), Type.Literal("unknown")]),
  replayed: Type.Boolean(),
  requestId: RequestIdSchema,
  result: Type.Union([JsonObjectSchema, Type.Null()]),
  error: Type.Union([ApiErrorSchema, Type.Null()]),
  audit: GatewayRequestAuditSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type CommandReceipt = Static<typeof CommandReceiptSchema>;

export const CommandResponseSchema = Type.Object({
  data: Type.Object({ receipt: CommandReceiptSchema }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type CommandResponse = Static<typeof CommandResponseSchema>;
