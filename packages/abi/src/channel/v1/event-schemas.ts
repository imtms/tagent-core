import { Type, type Static, type TSchema } from "typebox";
import { IdentifierSchema, IsoDateTimeSchema, JsonObjectSchema, RequestIdSchema } from "../../shared/primitives.js";
import { ToolErrorSchema } from "./transcript-schemas.js";

export const PROJECTION_CRITICAL_TASK_RUN_EVENT_TYPES = [
  "task_run.started", "task_run.waiting_input", "task_run.blocked", "task_run.resumed",
  "task_run.completed", "task_run.failed", "task_run.cancelled", "task_run.interrupted",
  "message.started", "message.delta", "message.completed", "tool.started", "tool.progress",
  "tool.completed", "tool.failed", "provider.failure", "approval.requested", "approval.resolved",
  "user_input.submitted", "diagnostic.internal",
] as const;

export const KnownTaskRunEventTypeSchema = Type.Union([
  Type.Literal("task_run.started"), Type.Literal("task_run.waiting_input"),
  Type.Literal("task_run.blocked"), Type.Literal("task_run.resumed"),
  Type.Literal("task_run.completed"), Type.Literal("task_run.failed"),
  Type.Literal("task_run.cancelled"), Type.Literal("task_run.interrupted"),
  Type.Literal("message.started"), Type.Literal("message.delta"), Type.Literal("message.completed"),
  Type.Literal("tool.started"), Type.Literal("tool.progress"),
  Type.Literal("tool.completed"), Type.Literal("tool.failed"),
  Type.Literal("provider.failure"), Type.Literal("approval.requested"),
  Type.Literal("approval.resolved"), Type.Literal("user_input.submitted"),
  Type.Literal("diagnostic.internal"),
]);
export type KnownTaskRunEventType = Static<typeof KnownTaskRunEventTypeSchema>;

const EventBase = {
  specVersion: Type.Literal("1.0"),
  eventId: Type.String({ minLength: 1, pattern: "^task_run:.+:[1-9][0-9]*$" }),
  aggregateType: Type.Literal("task_run"), aggregateId: IdentifierSchema,
  sequence: Type.Integer({ minimum: 1 }), occurredAt: IsoDateTimeSchema,
  correlationId: Type.Union([IdentifierSchema, Type.Null()]),
  causationId: Type.Union([IdentifierSchema, Type.Null()]),
};

function eventSchema<TType extends string, TPayload extends TSchema>(type: TType, payload: TPayload) {
  return Type.Object({ ...EventBase, type: Type.Literal(type), payload }, { additionalProperties: false });
}

const UserInputFieldSchema = Type.Object({
  key: Type.String({ minLength: 1 }), label: Type.String(), description: Type.String(),
  inputType: Type.Union([Type.Literal("text"), Type.Literal("textarea")]),
  required: Type.Boolean(), placeholder: Type.String(),
}, { additionalProperties: false });
const ToolPayloadSchema = Type.Object({
  toolCallId: IdentifierSchema, toolName: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export const TaskRunStartedEventSchema = eventSchema("task_run.started", Type.Object({ goal: Type.Optional(Type.String()), attempt: Type.Optional(Type.Integer({ minimum: 1 })) }, { additionalProperties: false }));
export const TaskRunWaitingInputEventSchema = eventSchema("task_run.waiting_input", Type.Object({ requestId: IdentifierSchema, prompt: Type.String(), fields: Type.Array(UserInputFieldSchema) }, { additionalProperties: false }));
export const TaskRunBlockedEventSchema = eventSchema("task_run.blocked", Type.Object({ reason: Type.String(), action: Type.Optional(Type.String()) }, { additionalProperties: false }));
export const TaskRunResumedEventSchema = eventSchema("task_run.resumed", Type.Object({ attempt: Type.Integer({ minimum: 1 }), mode: Type.Optional(Type.String()) }, { additionalProperties: false }));
export const TaskRunCompletedEventSchema = eventSchema("task_run.completed", Type.Object({}, { additionalProperties: false }));
export const TaskRunFailedEventSchema = eventSchema("task_run.failed", Type.Object({ reason: Type.String(), retryable: Type.Boolean() }, { additionalProperties: false }));
export const TaskRunCancelledEventSchema = eventSchema("task_run.cancelled", Type.Object({ reason: Type.String() }, { additionalProperties: false }));
export const TaskRunInterruptedEventSchema = eventSchema("task_run.interrupted", Type.Object({ reason: Type.String() }, { additionalProperties: false }));
export const MessageStartedEventSchema = eventSchema("message.started", Type.Object({ ordinal: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }));
export const MessageDeltaEventSchema = eventSchema("message.delta", Type.Object({ delta: Type.String(), ordinal: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }));
export const MessageCompletedEventSchema = eventSchema("message.completed", Type.Object({ content: Type.String(), ordinal: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }));
export const ToolStartedEventSchema = eventSchema("tool.started", ToolPayloadSchema);
export const ToolProgressEventSchema = eventSchema("tool.progress", ToolPayloadSchema);
export const ToolCompletedEventSchema = eventSchema("tool.completed", Type.Object({ ...ToolPayloadSchema.properties, isError: Type.Boolean(), error: Type.Optional(ToolErrorSchema) }, { additionalProperties: false }));
export const ToolFailedEventSchema = eventSchema("tool.failed", Type.Object({ ...ToolPayloadSchema.properties, reason: Type.String(), error: Type.Optional(ToolErrorSchema) }, { additionalProperties: false }));
export const ProviderFailureEventSchema = eventSchema("provider.failure", Type.Object({ kind: Type.String(), retryable: Type.Boolean(), stopReason: Type.Optional(Type.String()) }, { additionalProperties: false }));
export const ApprovalRequestedEventSchema = eventSchema("approval.requested", Type.Object({ approvalRequestId: IdentifierSchema, reason: Type.String() }, { additionalProperties: false }));
export const ApprovalResolvedEventSchema = eventSchema("approval.resolved", Type.Object({ approvalRequestId: IdentifierSchema, decision: Type.Union([Type.Literal("approved"), Type.Literal("rejected")]), resolution: Type.String() }, { additionalProperties: false }));
export const UserInputSubmittedEventSchema = eventSchema("user_input.submitted", Type.Object({ userInputRequestId: IdentifierSchema, fieldKeys: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false }));
export const DiagnosticTaskRunEventSchema = eventSchema("diagnostic.internal", Type.Object({ sourceType: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false }));

/** Avoids repeatedly traversing the full union when encoding high-volume event streams. */
export const ProjectionCriticalTaskRunEventSchemaByType = {
  "task_run.started": TaskRunStartedEventSchema,
  "task_run.waiting_input": TaskRunWaitingInputEventSchema,
  "task_run.blocked": TaskRunBlockedEventSchema,
  "task_run.resumed": TaskRunResumedEventSchema,
  "task_run.completed": TaskRunCompletedEventSchema,
  "task_run.failed": TaskRunFailedEventSchema,
  "task_run.cancelled": TaskRunCancelledEventSchema,
  "task_run.interrupted": TaskRunInterruptedEventSchema,
  "message.started": MessageStartedEventSchema,
  "message.delta": MessageDeltaEventSchema,
  "message.completed": MessageCompletedEventSchema,
  "tool.started": ToolStartedEventSchema,
  "tool.progress": ToolProgressEventSchema,
  "tool.completed": ToolCompletedEventSchema,
  "tool.failed": ToolFailedEventSchema,
  "provider.failure": ProviderFailureEventSchema,
  "approval.requested": ApprovalRequestedEventSchema,
  "approval.resolved": ApprovalResolvedEventSchema,
  "user_input.submitted": UserInputSubmittedEventSchema,
  "diagnostic.internal": DiagnosticTaskRunEventSchema,
} as const satisfies Record<KnownTaskRunEventType, TSchema>;

/** Public producer contract. Internal events must be reduced to the diagnostic schema. */
export const ProjectionCriticalTaskRunEventSchema = Type.Union([
  TaskRunStartedEventSchema, TaskRunWaitingInputEventSchema, TaskRunBlockedEventSchema,
  TaskRunResumedEventSchema, TaskRunCompletedEventSchema, TaskRunFailedEventSchema,
  TaskRunCancelledEventSchema, TaskRunInterruptedEventSchema, MessageStartedEventSchema,
  MessageDeltaEventSchema, MessageCompletedEventSchema, ToolStartedEventSchema,
  ToolProgressEventSchema, ToolCompletedEventSchema, ToolFailedEventSchema,
  ProviderFailureEventSchema, ApprovalRequestedEventSchema, ApprovalResolvedEventSchema,
  UserInputSubmittedEventSchema, DiagnosticTaskRunEventSchema,
]);
export type ProjectionCriticalTaskRunEvent = Static<typeof ProjectionCriticalTaskRunEventSchema>;

/** Forward-compatible consumer envelope; producers also validate the typed union above. */
export const TaskRunEventSchema = Type.Object({
  ...EventBase, type: Type.String({ minLength: 1 }), payload: JsonObjectSchema,
});
export type TaskRunEvent = Static<typeof TaskRunEventSchema>;

export const EventConsumerClaimRequestSchema = Type.Object({}, { additionalProperties: false });
export type EventConsumerClaimRequest = Static<typeof EventConsumerClaimRequestSchema>;
export const EventConsumerCursorSchema = Type.Object({
  taskRunId: IdentifierSchema, consumerId: IdentifierSchema,
  generation: Type.Integer({ minimum: 1 }), acknowledgedSequence: Type.Integer({ minimum: 0 }),
  settledAcknowledgedSequence: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  finalAcknowledgedSequence: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  claimedAt: IsoDateTimeSchema, updatedAt: IsoDateTimeSchema,
});
export type EventConsumerCursor = Static<typeof EventConsumerCursorSchema>;
export const EventConsumerClaimResponseSchema = Type.Object({ data: Type.Object({ cursor: EventConsumerCursorSchema }), requestId: RequestIdSchema }, { additionalProperties: false });
export type EventConsumerClaimResponse = Static<typeof EventConsumerClaimResponseSchema>;
export const EventStreamQuerySchema = Type.Object({ consumerId: IdentifierSchema, generation: Type.Integer({ minimum: 1 }), after: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false });
export type EventStreamQuery = Static<typeof EventStreamQuerySchema>;
export const EventConsumerAckRequestSchema = Type.Object({ generation: Type.Integer({ minimum: 1 }), sequence: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
export type EventConsumerAckRequest = Static<typeof EventConsumerAckRequestSchema>;
export const EventConsumerAckResponseSchema = Type.Object({ data: Type.Object({ status: Type.Literal("accepted"), cursor: EventConsumerCursorSchema }), requestId: RequestIdSchema }, { additionalProperties: false });
export type EventConsumerAckResponse = Static<typeof EventConsumerAckResponseSchema>;

export function createTaskRunEventId(taskRunId: string, sequence: number): string {
  if (taskRunId.length === 0 || !Number.isSafeInteger(sequence) || sequence < 1) throw new RangeError("TaskRun event IDs require a non-empty TaskRun ID and a positive integer sequence.");
  return `task_run:${taskRunId}:${sequence}`;
}
