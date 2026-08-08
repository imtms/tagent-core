import { Type, type Static } from "typebox";
import { IdentifierSchema, IsoDateTimeSchema } from "../../shared/primitives.js";
import { IdempotencyKeySchema } from "../../shared/idempotency.js";
import { GatewayProvenanceSchema } from "./provenance-schemas.js";
import { canonicalJson } from "../../shared/canonical-json.js";

export const TaskRunStatusSchema = Type.Union([
  Type.Literal("running"),
  Type.Literal("waiting_input"),
  Type.Literal("completed"),
  Type.Literal("blocked"),
  Type.Literal("interrupted"),
  Type.Literal("cancelled"),
  Type.Literal("failed"),
]);
export type TaskRunStatus = Static<typeof TaskRunStatusSchema>;

export const TaskRunPhaseSchema = Type.Union([
  Type.Literal("discover"),
  Type.Literal("plan"),
  Type.Literal("implement"),
  Type.Literal("verify"),
  Type.Literal("review"),
  Type.Literal("waiting_input"),
  Type.Literal("done"),
  Type.Literal("blocked"),
]);
export type TaskRunPhase = Static<typeof TaskRunPhaseSchema>;

export const SessionCreateRequestSchema = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  origin: Type.Optional(GatewayProvenanceSchema),
}, { additionalProperties: false });
export type SessionCreateRequest = Static<typeof SessionCreateRequestSchema>;

export const SessionCreateHeadersSchema = Type.Object({
  "idempotency-key": IdempotencyKeySchema,
}, { additionalProperties: true });
export type SessionCreateHeaders = Static<typeof SessionCreateHeadersSchema>;

export function normalizeSessionCreateRequest(request: SessionCreateRequest): SessionCreateRequest {
  return {
    title: request.title?.trim() || "New workspace",
    ...(request.origin === undefined ? {} : { origin: request.origin }),
  };
}

export function canonicalizeSessionCreateRequest(request: SessionCreateRequest): string {
  return canonicalJson(normalizeSessionCreateRequest(request));
}

export const SessionSchema = Type.Object({
  id: IdentifierSchema,
  title: Type.String({ minLength: 1, maxLength: 256 }),
  modelId: Type.String({ minLength: 1 }),
  reasoningEffort: Type.Union([
    Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"),
    Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
  ]),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  latestTaskRunStatus: Type.Union([TaskRunStatusSchema, Type.Null()]),
  latestTaskRunPhase: Type.Union([TaskRunPhaseSchema, Type.Null()]),
});
export type Session = Static<typeof SessionSchema>;
