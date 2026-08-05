import { Type, type Static } from "typebox";
import { IdentifierSchema, IsoDateTimeSchema, JsonObjectSchema, RequestIdSchema } from "../../shared/primitives.js";

export const WorkflowEvaluationKindSchema = Type.Union([
  Type.Literal("shadow"),
  Type.Literal("offline_replay"),
]);

export const WorkflowEvaluationRequestSchema = Type.Object({
  candidateRevisionId: IdentifierSchema,
  baselineRevisionId: IdentifierSchema,
  kind: WorkflowEvaluationKindSchema,
  datasetId: IdentifierSchema,
  baselineRunIds: Type.Optional(Type.Array(IdentifierSchema, { maxItems: 10_000 })),
  candidateRunIds: Type.Optional(Type.Array(IdentifierSchema, { maxItems: 10_000 })),
}, { additionalProperties: false });
export type WorkflowEvaluationRequest = Static<typeof WorkflowEvaluationRequestSchema>;

export const WorkflowEvaluationWorkflowParamsSchema = Type.Object({ id: IdentifierSchema }, { additionalProperties: false });
export const WorkflowEvaluationIdParamsSchema = Type.Object({ id: IdentifierSchema }, { additionalProperties: false });

export const WorkflowEvaluationExecutionReceiptSchema = Type.Object({
  id: IdentifierSchema,
  status: Type.String({ minLength: 1 }),
  receiptHash: Type.String({ minLength: 1 }),
  signature: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

export const WorkflowEvaluationResponseSchema = Type.Object({
  data: WorkflowEvaluationExecutionReceiptSchema,
  requestId: RequestIdSchema,
}, { additionalProperties: false });

export const WorkflowEvaluationVerificationSchema = Type.Boolean();
export const WorkflowEvaluationVerificationResponseSchema = Type.Object({
  data: WorkflowEvaluationVerificationSchema,
  requestId: RequestIdSchema,
}, { additionalProperties: false });

export const EvaluationMetricsSchema = Type.Object({
  sampleSize: Type.Integer({ minimum: 0 }),
  successRate: Type.Number({ minimum: 0, maximum: 1 }),
  baselineRate: Type.Number({ minimum: 0, maximum: 1 }),
  score: Type.Number(),
  measurements: JsonObjectSchema,
});
export type EvaluationMetrics = Static<typeof EvaluationMetricsSchema>;

export const WorkflowEvaluationReceiptSchema = Type.Object({
  evaluationId: IdentifierSchema,
  workflowId: IdentifierSchema,
  revisionId: IdentifierSchema,
  taskRunId: Type.Union([IdentifierSchema, Type.Null()]),
  kind: Type.String({ minLength: 1 }),
  status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("inconclusive")]),
  evaluatorId: IdentifierSchema,
  evaluatorVersion: Type.String({ minLength: 1 }),
  datasetId: IdentifierSchema,
  metrics: EvaluationMetricsSchema,
  evidence: JsonObjectSchema,
  receiptHash: Type.String({ minLength: 1 }),
  evaluatedAt: IsoDateTimeSchema,
});
export type WorkflowEvaluationReceipt = Static<typeof WorkflowEvaluationReceiptSchema>;

export const EvaluationSubmissionSchema = Type.Object({
  leaseToken: Type.String({ minLength: 1 }),
  fence: Type.Integer({ minimum: 1 }),
  receipt: WorkflowEvaluationReceiptSchema,
}, { additionalProperties: false });
export type EvaluationSubmission = Static<typeof EvaluationSubmissionSchema>;
