import { Type, type Static } from "typebox";
import { IsoDateTimeSchema, RequestIdSchema } from "../../shared/primitives.js";

export const LearningSettingsSchema = Type.Object({
  memoryAvailable: Type.Boolean(),
  memoryEnabled: Type.Boolean(),
  learningEnabled: Type.Boolean(),
  autoExecutionEnabled: Type.Boolean(),
  passiveLearningEnabled: Type.Boolean(),
  activeExecutionRequiresApproval: Type.Literal(true),
  updatedAt: IsoDateTimeSchema,
  reason: Type.String(),
});
export type LearningSettings = Static<typeof LearningSettingsSchema>;

export const LearningSettingsUpdateRequestSchema = Type.Object({
  memoryEnabled: Type.Optional(Type.Boolean()),
  learningEnabled: Type.Optional(Type.Boolean()),
  autoExecutionEnabled: Type.Optional(Type.Boolean()),
  reason: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export type LearningSettingsUpdateRequest = Static<typeof LearningSettingsUpdateRequestSchema>;

export const LearningSettingsResponseSchema = Type.Object({
  data: Type.Object({ settings: LearningSettingsSchema }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type LearningSettingsResponse = Static<typeof LearningSettingsResponseSchema>;

export const TaskRunLearningPolicyRequestSchema = Type.Object({
  policy: Type.Union([Type.Literal("allow"), Type.Literal("metadata_only"), Type.Literal("deny")]),
  reason: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export type TaskRunLearningPolicyRequest = Static<typeof TaskRunLearningPolicyRequestSchema>;
