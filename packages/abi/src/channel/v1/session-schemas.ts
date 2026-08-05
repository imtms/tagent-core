import { Type, type Static } from "typebox";
import { IdentifierSchema, IsoDateTimeSchema } from "../../shared/primitives.js";

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
}, { additionalProperties: false });
export type SessionCreateRequest = Static<typeof SessionCreateRequestSchema>;

export const SessionSchema = Type.Object({
  id: IdentifierSchema,
  title: Type.String({ minLength: 1, maxLength: 256 }),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  latestTaskRunStatus: Type.Union([TaskRunStatusSchema, Type.Null()]),
  latestTaskRunPhase: Type.Union([TaskRunPhaseSchema, Type.Null()]),
});
export type Session = Static<typeof SessionSchema>;
