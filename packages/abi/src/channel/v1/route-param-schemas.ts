import { Type, type Static } from "typebox";
import { IdempotencyKeySchema } from "../../shared/idempotency.js";
import { IdentifierSchema } from "../../shared/primitives.js";

export const SessionParamsSchema = Type.Object({
  sessionId: IdentifierSchema,
}, { additionalProperties: false });
export type SessionParams = Static<typeof SessionParamsSchema>;

export const SubmissionLookupParamsSchema = Type.Object({
  sessionId: IdentifierSchema,
  idempotencyKey: IdempotencyKeySchema,
}, { additionalProperties: false });
export type SubmissionLookupParams = Static<typeof SubmissionLookupParamsSchema>;

export const TaskRunParamsSchema = Type.Object({
  taskRunId: IdentifierSchema,
}, { additionalProperties: false });
export type TaskRunParams = Static<typeof TaskRunParamsSchema>;

export const TaskRunArtifactParamsSchema = Type.Object({
  taskRunId: IdentifierSchema,
  artifactId: IdentifierSchema,
}, { additionalProperties: false });
export type TaskRunArtifactParams = Static<typeof TaskRunArtifactParamsSchema>;

export const EventConsumerParamsSchema = Type.Object({
  taskRunId: IdentifierSchema,
  consumerId: Type.String({ minLength: 1, maxLength: 200 }),
}, { additionalProperties: false });
export type EventConsumerParams = Static<typeof EventConsumerParamsSchema>;
