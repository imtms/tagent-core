import { Type, type Static } from "typebox";
import { TimestampMillisecondsSchema } from "../../shared/primitives.js";

const ConsoleNullableTimestampSchema = Type.Union([TimestampMillisecondsSchema, Type.Null()]);
const ConsoleNullableStringSchema = Type.Union([Type.String(), Type.Null()]);

/** @deprecated Use LearningSettings from admin/v1. */
export const ConsoleLearningFeatureStateSchema = Type.Object({
  memoryAvailable: Type.Boolean(), memoryEnabled: Type.Boolean(), learningEnabled: Type.Boolean(),
  autoExecutionEnabled: Type.Boolean(), passiveLearningEnabled: Type.Boolean(),
  activeExecutionRequiresApproval: Type.Literal(true), updatedAt: TimestampMillisecondsSchema, reason: Type.String(),
});
/** @deprecated Use LearningSettings from admin/v1. */
export type ConsoleLearningFeatureState = Static<typeof ConsoleLearningFeatureStateSchema>;

/** @deprecated Use AdminConfigStatus from admin/v1. */
export const ConsoleRuntimeStatusSchema = Type.Object({
  runtime: Type.String(), provider: Type.String(), api: Type.String(), baseUrl: Type.String(), modelId: Type.String(),
  credentialConfigured: Type.Boolean(), providerTimeoutMs: Type.Number(), providerMaxRetries: Type.Number(),
  runTimeoutMs: Type.Number(), maxContinuations: Type.Number(), schemaVersion: Type.Optional(Type.Number()),
  memoryEnabled: Type.Boolean(), memoryWorkspaceScopeId: Type.Optional(Type.String()),
  memoryBackend: Type.Optional(Type.Union([Type.Literal("memory"), Type.Literal("postgres")])),
  memoryColdBackend: Type.Optional(Type.Union([Type.Literal("local"), Type.Literal("s3")])),
  learningEnabled: Type.Boolean(), learningAutoExecutionEnabled: Type.Boolean(), learningRequiresMemory: Type.Literal(true),
  learningActiveExecutionRequiresApproval: Type.Literal(true), autoExecutionEnabled: Type.Optional(Type.Boolean()),
  passiveLearningEnabled: Type.Optional(Type.Boolean()),
});
/** @deprecated Use AdminConfigStatus from admin/v1. */
export type ConsoleRuntimeStatus = Static<typeof ConsoleRuntimeStatusSchema>;

/** @deprecated Use WorkflowRevision from admin/v1. */
export const ConsoleWorkflowRevisionSchema = Type.Object({
  id: Type.String(), workflowId: Type.String(), revision: Type.Number(), name: Type.String(), intent: Type.String(),
  cueTerms: Type.Array(Type.String()), applicability: Type.Array(Type.String()), nonApplicability: Type.Array(Type.String()),
  steps: Type.Array(Type.Object({ stepId: Type.String(), instruction: Type.String(), required: Type.Boolean() })),
  verification: Type.Array(Type.Object({ check: Type.String(), required: Type.Boolean(), successCondition: Type.String() })),
  requiredCapabilities: Type.Array(Type.String()),
  riskClass: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  confidence: Type.Number(), createdAt: TimestampMillisecondsSchema,
});
/** @deprecated Use WorkflowRevision from admin/v1. */
export type ConsoleWorkflowRevision = Static<typeof ConsoleWorkflowRevisionSchema>;

/** @deprecated Use WorkflowDefinition from admin/v1. */
export const ConsoleWorkflowDefinitionSchema = Type.Object({
  id: Type.String(), scopeId: Type.String(),
  status: Type.Union([Type.Literal("candidate"), Type.Literal("active"), Type.Literal("suspended"), Type.Literal("deprecated")]),
  activeRevisionId: ConsoleNullableStringSchema,
  deletedAt: Type.Optional(ConsoleNullableTimestampSchema), purgeAfter: Type.Optional(ConsoleNullableTimestampSchema),
  createdAt: TimestampMillisecondsSchema, updatedAt: TimestampMillisecondsSchema,
  revision: Type.Optional(ConsoleWorkflowRevisionSchema),
});
/** @deprecated Use WorkflowDefinition from admin/v1. */
export type ConsoleWorkflowDefinition = Static<typeof ConsoleWorkflowDefinitionSchema>;

/** @deprecated Use AutonomyApproval from admin/v1. */
export const ConsoleAutonomyApprovalSchema = Type.Object({
  id: Type.String(), scopeId: Type.String(),
  actionType: Type.Union([
    Type.Literal("activate_workflow"), Type.Literal("apply_revision"),
    Type.Literal("start_canary"), Type.Literal("execute_workflow"),
  ]),
  targetType: Type.String(), targetId: Type.String(), workflowId: ConsoleNullableStringSchema,
  revisionId: ConsoleNullableStringSchema, proposalId: ConsoleNullableStringSchema, bindingId: ConsoleNullableStringSchema,
  status: Type.Union([
    Type.Literal("pending"), Type.Literal("approved"), Type.Literal("rejected"),
    Type.Literal("revoked"), Type.Literal("expired"), Type.Literal("executed"),
  ]),
  riskClass: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  impactScopeJson: Type.String(), evidenceJson: Type.String(), diffJson: Type.String(), rollbackJson: Type.String(),
  requestedBy: Type.String(), requestReason: Type.String(), expiresAt: TimestampMillisecondsSchema,
  decidedBy: Type.String(), decisionReason: Type.String(), decidedAt: ConsoleNullableTimestampSchema,
  executedAt: ConsoleNullableTimestampSchema, executionReceiptJson: Type.String(), createdAt: TimestampMillisecondsSchema,
});
/** @deprecated Use AutonomyApproval from admin/v1. */
export type ConsoleAutonomyApproval = Static<typeof ConsoleAutonomyApprovalSchema>;

export const ConsoleWorkflowBindingSchema = Type.Object({
  id: Type.String(), runId: Type.String(), attempt: Type.Number(), workflowId: Type.String(), revisionId: Type.String(),
  relevanceScore: Type.Number(), applicationMode: Type.String(), createdAt: TimestampMillisecondsSchema,
});
export type ConsoleWorkflowBinding = Static<typeof ConsoleWorkflowBindingSchema>;

export const ConsoleCanaryBindingSchema = Type.Object({
  id: Type.String(), promotionId: Type.String(), runId: Type.String(), variant: Type.String(), bucket: Type.Number(),
  revisionId: Type.String(), outcomeStatus: Type.Optional(Type.String()), success: Type.Optional(Type.Number()),
});
export type ConsoleCanaryBinding = Static<typeof ConsoleCanaryBindingSchema>;

export const ConsoleWorkflowFeedbackSchema = Type.Object({
  id: Type.String(), workflowId: Type.String(), revisionId: Type.String(), runId: Type.String(), attempt: Type.Number(),
  signal: Type.String(), weight: Type.Number(), adopted: Type.Number(), verified: Type.Number(), note: Type.String(),
  createdAt: TimestampMillisecondsSchema,
});
export type ConsoleWorkflowFeedback = Static<typeof ConsoleWorkflowFeedbackSchema>;

export const ConsoleWorkflowProposalSchema = Type.Object({
  id: Type.String(), workflowId: Type.String(), baseRevisionId: Type.String(), reason: Type.String(),
  patchJson: Type.String(), changedPathsJson: Type.String(),
  status: Type.Union([Type.Literal("candidate"), Type.Literal("approved"), Type.Literal("rejected"), Type.Literal("applied")]),
  createdAt: TimestampMillisecondsSchema,
});
export type ConsoleWorkflowProposal = Static<typeof ConsoleWorkflowProposalSchema>;

export const ConsoleLearningPolicySchema = Type.Object({
  runId: Type.String(), policy: Type.Union([Type.Literal("allow"), Type.Literal("metadata_only"), Type.Literal("deny")]),
  reason: Type.String(), updatedAt: TimestampMillisecondsSchema,
});
export type ConsoleLearningPolicy = Static<typeof ConsoleLearningPolicySchema>;

export const ConsoleWorkflowQualitySchema = Type.Object({
  workflowId: Type.String(), revisionId: Type.Optional(Type.String()), samples: Type.Number(), score: Type.Number(),
});
export type ConsoleWorkflowQuality = Static<typeof ConsoleWorkflowQualitySchema>;

export const ConsoleDistillationJobSchema = Type.Object({
  id: Type.String(), taskSignature: Type.String(), status: Type.String(), attempts: Type.Number(),
  checkpointJson: Type.String(), error: Type.String(), updatedAt: TimestampMillisecondsSchema,
});
export type ConsoleDistillationJob = Static<typeof ConsoleDistillationJobSchema>;

export const ConsoleWorkflowEvaluationSchema = Type.Object({
  id: Type.String(), workflowId: Type.String(), revisionId: Type.String(), kind: Type.String(), status: Type.String(),
  sampleSize: Type.Number(), successRate: Type.Number(), baselineRate: Type.Number(), evaluatorId: Type.String(),
  evaluatorVersion: Type.String(), datasetId: Type.String(), receiptHash: Type.String(), createdAt: TimestampMillisecondsSchema,
});
export type ConsoleWorkflowEvaluation = Static<typeof ConsoleWorkflowEvaluationSchema>;

export const ConsoleAutonomyAuditSchema = Type.Object({
  id: Type.String(), category: Type.String(), action: Type.String(), actor: Type.String(),
  sourceRunId: ConsoleNullableStringSchema, workflowId: ConsoleNullableStringSchema,
  revisionId: ConsoleNullableStringSchema, approvalId: ConsoleNullableStringSchema,
  evidenceJson: Type.String(), metadataJson: Type.String(), receiptHash: Type.String(), createdAt: TimestampMillisecondsSchema,
});
export type ConsoleAutonomyAudit = Static<typeof ConsoleAutonomyAuditSchema>;

/** @deprecated Use the focused admin/v1 resources instead of the legacy aggregate. */
export const ConsoleLearningCenterDataSchema = Type.Object({
  featureState: Type.Union([ConsoleLearningFeatureStateSchema, Type.Null()]),
  workflows: Type.Array(ConsoleWorkflowDefinitionSchema),
  bindings: Type.Array(ConsoleWorkflowBindingSchema),
  canaryBindings: Type.Array(ConsoleCanaryBindingSchema),
  feedback: Type.Array(ConsoleWorkflowFeedbackSchema),
  proposals: Type.Array(ConsoleWorkflowProposalSchema),
  learningPolicies: Type.Array(ConsoleLearningPolicySchema),
  quality: Type.Array(ConsoleWorkflowQualitySchema),
  distillationJobs: Type.Array(ConsoleDistillationJobSchema),
  distillationMetrics: Type.Object({
    queued: Type.Number(), running: Type.Number(), completed: Type.Number(), deadLetter: Type.Number(),
    failed: Type.Number(), oldestQueuedAgeMs: Type.Number(),
  }),
  evaluations: Type.Array(ConsoleWorkflowEvaluationSchema),
  approvals: Type.Array(ConsoleAutonomyApprovalSchema),
  autonomyAudit: Type.Array(ConsoleAutonomyAuditSchema),
});
/** @deprecated Use the focused admin/v1 resources instead of the legacy aggregate. */
export type ConsoleLearningCenterData = Static<typeof ConsoleLearningCenterDataSchema>;
