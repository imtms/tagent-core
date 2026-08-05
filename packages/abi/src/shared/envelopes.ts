import { Type, type Static } from "typebox";
import { JsonObjectSchema, RequestIdSchema } from "./primitives.js";

export const ErrorCategorySchema = Type.Union([
  Type.Literal("validation"),
  Type.Literal("unauthenticated"),
  Type.Literal("permission_denied"),
  Type.Literal("not_found"),
  Type.Literal("conflict"),
  Type.Literal("rate_limited"),
  Type.Literal("unavailable"),
  Type.Literal("internal"),
]);
export type ErrorCategory = Static<typeof ErrorCategorySchema>;

export const ApiErrorSchema = Type.Object({
  code: Type.String({ minLength: 3, pattern: "^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)+$" }),
  message: Type.String({ minLength: 1 }),
  requestId: RequestIdSchema,
  retryable: Type.Boolean(),
  details: JsonObjectSchema,
}, { additionalProperties: false });
export type ApiError = Static<typeof ApiErrorSchema>;

export const ErrorEnvelopeSchema = Type.Object({
  error: ApiErrorSchema,
}, { additionalProperties: false });
export type ErrorEnvelope = Static<typeof ErrorEnvelopeSchema>;

export const SuccessEnvelopeSchema = Type.Object({
  data: Type.Unknown(),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type SuccessEnvelope = Static<typeof SuccessEnvelopeSchema>;
