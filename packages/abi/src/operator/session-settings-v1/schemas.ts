import { Type, type Static } from "typebox";
import { IdentifierSchema, IsoDateTimeSchema, RequestIdSchema } from "../../shared/primitives.js";
import { ResourceRevisionSchema } from "../../profiles/v1/schemas.js";

export const SessionReasoningEffortSchema = Type.Union([
  Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"),
  Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
]);
export type SessionReasoningEffort = Static<typeof SessionReasoningEffortSchema>;

export const OperatorSessionSettingsSchema = Type.Object({
  sessionId: IdentifierSchema,
  title: Type.String({ minLength: 1, maxLength: 256 }),
  modelId: Type.String({ minLength: 1, maxLength: 256 }),
  reasoningEffort: SessionReasoningEffortSchema,
  revision: ResourceRevisionSchema,
  updatedAt: IsoDateTimeSchema,
}, { additionalProperties: false });
export type OperatorSessionSettings = Static<typeof OperatorSessionSettingsSchema>;

export const OperatorSessionSettingsParamsSchema = Type.Object({
  sessionId: IdentifierSchema,
}, { additionalProperties: false });
export type OperatorSessionSettingsParams = Static<typeof OperatorSessionSettingsParamsSchema>;

export const OperatorSessionSettingsUpdateRequestSchema = Type.Object({
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  modelId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
  reasoningEffort: Type.Optional(SessionReasoningEffortSchema),
}, { additionalProperties: false, minProperties: 1 });
export type OperatorSessionSettingsUpdateRequest = Static<typeof OperatorSessionSettingsUpdateRequestSchema>;

export const OperatorSessionSettingsResponseSchema = Type.Object({
  data: Type.Object({ settings: OperatorSessionSettingsSchema }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type OperatorSessionSettingsResponse = Static<typeof OperatorSessionSettingsResponseSchema>;
