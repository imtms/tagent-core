import { Type, type Static } from "typebox";
import { IdempotencyKeySchema } from "../../shared/idempotency.js";
import { IdentifierSchema, IsoDateTimeSchema, RequestIdSchema } from "../../shared/primitives.js";
import { GatewayProvenanceSchema, GatewayRequestAuditSchema } from "./provenance-schemas.js";

export {
  IDEMPOTENCY_KEY_HEADER,
  IDEMPOTENCY_KEY_PATTERN,
  IdempotencyKeySchema,
  type IdempotencyKey,
} from "../../shared/idempotency.js";

export const SubmissionCreateHeadersSchema = Type.Object({
  "idempotency-key": IdempotencyKeySchema,
}, { additionalProperties: true });
export type SubmissionCreateHeaders = Static<typeof SubmissionCreateHeadersSchema>;

export const SubmissionCreateRequestSchema = Type.Object({
  content: Type.String({ minLength: 1 }),
  modelId: Type.Optional(Type.String({
    minLength: 1,
    description: "Advisory compatibility hint; excluded from v1 idempotency and execution semantics.",
  })),
  origin: Type.Optional(GatewayProvenanceSchema),
}, { additionalProperties: false });
export type SubmissionCreateRequest = Static<typeof SubmissionCreateRequestSchema>;

export const SubmissionApplicationInputSchema = Type.Object({
  idempotencyKey: IdempotencyKeySchema,
  content: Type.String({ minLength: 1 }),
  modelId: Type.Optional(Type.String({ minLength: 1 })),
  origin: Type.Optional(GatewayProvenanceSchema),
}, { additionalProperties: false });
export type SubmissionApplicationInput = Static<typeof SubmissionApplicationInputSchema>;

export const SubmissionExecutionRequestSchema = Type.Object({
  content: Type.String({ minLength: 1 }),
  requestId: RequestIdSchema,
  modelId: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });
export type SubmissionExecutionRequest = Static<typeof SubmissionExecutionRequestSchema>;

export const SubmissionStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("accepted"),
  Type.Literal("started"),
  Type.Literal("failed"),
]);
export type SubmissionStatus = Static<typeof SubmissionStatusSchema>;

export const SubmissionReceiptSchema = Type.Object({
  idempotencyKey: IdempotencyKeySchema,
  sessionId: IdentifierSchema,
  submissionId: IdentifierSchema,
  status: SubmissionStatusSchema,
  taskRunId: Type.Union([IdentifierSchema, Type.Null()]),
  error: Type.Union([Type.String(), Type.Null()]),
  audit: Type.Union([GatewayRequestAuditSchema, Type.Null()]),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
});
export type SubmissionReceipt = Static<typeof SubmissionReceiptSchema>;

export const SubmissionResponseSchema = Type.Object({
  data: Type.Object({
    receipt: SubmissionReceiptSchema,
  }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type SubmissionResponse = Static<typeof SubmissionResponseSchema>;

export function createSubmissionApplicationInput(
  headers: SubmissionCreateHeaders,
  request: SubmissionCreateRequest,
): SubmissionApplicationInput {
  return { idempotencyKey: headers["idempotency-key"], ...request };
}

export function mapSubmissionToExecutionRequest(input: SubmissionApplicationInput): SubmissionExecutionRequest {
  return {
    content: input.content,
    requestId: input.idempotencyKey,
    ...(input.modelId === undefined ? {} : { modelId: input.modelId }),
  };
}

export function normalizeSubmissionRequest(request: SubmissionCreateRequest): SubmissionCreateRequest {
  return {
    content: request.content.trim(),
    ...(request.modelId === undefined ? {} : { modelId: request.modelId }),
    ...(request.origin === undefined ? {} : { origin: request.origin }),
  };
}

export function canonicalizeSubmissionRequest(request: SubmissionCreateRequest): string {
  const normalized = normalizeSubmissionRequest(request);
  return JSON.stringify({ content: normalized.content, ...(normalized.origin === undefined ? {} : { origin: normalized.origin }) });
}
