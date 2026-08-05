import { Type, type Static } from "typebox";
import { IdentifierSchema, IsoDateTimeSchema, JsonObjectSchema, RequestIdSchema } from "../../shared/primitives.js";

export const KnownTaskRunEventTypeSchema = Type.Union([
  Type.Literal("task_run.started"),
  Type.Literal("task_run.waiting_input"),
  Type.Literal("task_run.blocked"),
  Type.Literal("task_run.resumed"),
  Type.Literal("task_run.completed"),
  Type.Literal("task_run.failed"),
  Type.Literal("task_run.cancelled"),
  Type.Literal("task_run.compacted"),
  Type.Literal("message.completed"),
  Type.Literal("tool.started"),
  Type.Literal("tool.progress"),
  Type.Literal("tool.completed"),
  Type.Literal("tool.failed"),
  Type.Literal("provider.failure"),
]);
export type KnownTaskRunEventType = Static<typeof KnownTaskRunEventTypeSchema>;

export const TaskRunEventSchema = Type.Object({
  specVersion: Type.Literal("1.0"),
  eventId: Type.String({ minLength: 1, pattern: "^task_run:.+:[1-9][0-9]*$" }),
  aggregateType: Type.Literal("task_run"),
  aggregateId: IdentifierSchema,
  sequence: Type.Integer({ minimum: 1 }),
  type: Type.String({ minLength: 1 }),
  occurredAt: IsoDateTimeSchema,
  correlationId: Type.Union([IdentifierSchema, Type.Null()]),
  causationId: Type.Union([IdentifierSchema, Type.Null()]),
  payload: JsonObjectSchema,
});
export type TaskRunEvent = Static<typeof TaskRunEventSchema>;

export const EventConsumerClaimRequestSchema = Type.Object({}, { additionalProperties: false });
export type EventConsumerClaimRequest = Static<typeof EventConsumerClaimRequestSchema>;

export const EventConsumerCursorSchema = Type.Object({
  taskRunId: IdentifierSchema,
  consumerId: IdentifierSchema,
  generation: Type.Integer({ minimum: 1 }),
  acknowledgedSequence: Type.Integer({ minimum: 0 }),
  terminalAcknowledgedSequence: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  claimedAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type EventConsumerCursor = Static<typeof EventConsumerCursorSchema>;

export const EventConsumerClaimResponseSchema = Type.Object({
  data: Type.Object({ cursor: EventConsumerCursorSchema }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type EventConsumerClaimResponse = Static<typeof EventConsumerClaimResponseSchema>;

export const EventStreamQuerySchema = Type.Object({
  consumerId: IdentifierSchema,
  generation: Type.Integer({ minimum: 1 }),
  after: Type.Optional(Type.Integer({ minimum: 0 })),
}, { additionalProperties: false });
export type EventStreamQuery = Static<typeof EventStreamQuerySchema>;

export const EventConsumerAckRequestSchema = Type.Object({
  generation: Type.Integer({ minimum: 1 }),
  sequence: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });
export type EventConsumerAckRequest = Static<typeof EventConsumerAckRequestSchema>;

export const EventConsumerAckResponseSchema = Type.Object({
  data: Type.Object({
    status: Type.Literal("accepted"),
    cursor: EventConsumerCursorSchema,
  }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type EventConsumerAckResponse = Static<typeof EventConsumerAckResponseSchema>;

export function createTaskRunEventId(taskRunId: string, sequence: number): string {
  if (taskRunId.length === 0 || !Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError("TaskRun event IDs require a non-empty TaskRun ID and a positive integer sequence.");
  }
  return `task_run:${taskRunId}:${sequence}`;
}
