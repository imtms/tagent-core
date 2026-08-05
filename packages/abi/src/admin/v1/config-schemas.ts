import { Type, type Static } from "typebox";
import { IsoDateTimeSchema, RequestIdSchema } from "../../shared/primitives.js";

export const AdminConfigStatusSchema = Type.Object({
  runtime: Type.String({ minLength: 1 }),
  provider: Type.String({ minLength: 1 }),
  api: Type.String({ minLength: 1 }),
  baseUrl: Type.String(),
  modelId: Type.String({ minLength: 1 }),
  credentialConfigured: Type.Boolean(),
  providerTimeoutMs: Type.Integer({ minimum: 0 }),
  providerMaxRetries: Type.Integer({ minimum: 0 }),
  taskRunTimeoutMs: Type.Integer({ minimum: 0 }),
  maxContinuations: Type.Integer({ minimum: 0 }),
  schemaVersion: Type.Optional(Type.Integer({ minimum: 1 })),
  memoryEnabled: Type.Boolean(),
  memoryBackend: Type.Optional(Type.Union([Type.Literal("memory"), Type.Literal("postgres")])),
  memoryColdBackend: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("s3")])),
  learningEnabled: Type.Boolean(),
  learningAutoExecutionEnabled: Type.Boolean(),
  readiness: Type.Object({
    ready: Type.Boolean(),
    checkedAt: IsoDateTimeSchema,
    reason: Type.Union([Type.String(), Type.Null()]),
  }),
});
export type AdminConfigStatus = Static<typeof AdminConfigStatusSchema>;

export const AdminConfigStatusResponseSchema = Type.Object({
  data: Type.Object({ status: AdminConfigStatusSchema }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type AdminConfigStatusResponse = Static<typeof AdminConfigStatusResponseSchema>;
