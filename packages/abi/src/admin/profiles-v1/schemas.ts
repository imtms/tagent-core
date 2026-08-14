import { Type, type Static } from "typebox";
import { IdentifierSchema, IsoDateTimeSchema, RequestIdSchema } from "../../shared/primitives.js";
import { MemoryKindSchema, MemoryScopeSchema, MemoryStatusSchema } from "../v1/memory-schemas.js";
import { LearningSettingsSchema } from "../v1/learning-schemas.js";
import { ProfilePageInfoSchema, ResourceRevisionSchema } from "../../profiles/v1/schemas.js";

export const AdminMemoryStatusSchema = Type.Object({
  available: Type.Boolean(),
  ready: Type.Boolean(),
  degraded: Type.Boolean(),
  reasons: Type.Array(Type.String({ maxLength: 500 }), { maxItems: 50 }),
}, { additionalProperties: false });
export type AdminMemoryStatus = Static<typeof AdminMemoryStatusSchema>;

export const AdminMemoryStatusResponseSchema = Type.Object({
  data: Type.Object({ status: AdminMemoryStatusSchema }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type AdminMemoryStatusResponse = Static<typeof AdminMemoryStatusResponseSchema>;

export const AdminMemoryRecordSchema = Type.Object({
  id: IdentifierSchema,
  kind: MemoryKindSchema,
  tier: Type.Union([Type.Literal("hot"), Type.Literal("warm")]),
  scope: MemoryScopeSchema,
  title: Type.String({ maxLength: 500 }),
  content: Type.String({ maxLength: 200_000 }),
  summary: Type.String({ maxLength: 5_000 }),
  status: MemoryStatusSchema,
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  sourceRefs: Type.Array(Type.Object({
    sourceType: Type.String({ minLength: 1, maxLength: 64 }),
    sourceRef: Type.String({ minLength: 32, maxLength: 32 }),
  }, { additionalProperties: false }), { maxItems: 100 }),
  resourceRevision: ResourceRevisionSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}, { additionalProperties: false });
export type AdminMemoryRecord = Static<typeof AdminMemoryRecordSchema>;

export const AdminMemoryRecordsResponseSchema = Type.Object({
  data: Type.Object({
    items: Type.Array(AdminMemoryRecordSchema),
    pageInfo: ProfilePageInfoSchema,
  }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type AdminMemoryRecordsResponse = Static<typeof AdminMemoryRecordsResponseSchema>;

export const AdminMemoryCaptureRequestSchema = Type.Object({
  scope: MemoryScopeSchema,
  content: Type.String({ minLength: 1, maxLength: 200_000 }),
}, { additionalProperties: false });
export type AdminMemoryCaptureRequest = Static<typeof AdminMemoryCaptureRequestSchema>;

export const AdminMemoryGovernRequestSchema = Type.Object({
  scope: MemoryScopeSchema,
  action: Type.Union([Type.Literal("approve"), Type.Literal("reject"), Type.Literal("correct"), Type.Literal("resolve")]),
  reason: Type.String({ minLength: 1, maxLength: 2_000 }),
  content: Type.Optional(Type.String({ minLength: 1, maxLength: 200_000 })),
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  resolution: Type.Optional(Type.Union([Type.Literal("accept"), Type.Literal("reject")])),
}, { additionalProperties: false });
export type AdminMemoryGovernRequest = Static<typeof AdminMemoryGovernRequestSchema>;

export const AdminMemoryForgetRequestSchema = Type.Object({
  scope: MemoryScopeSchema,
  reason: Type.String({ minLength: 1, maxLength: 2_000 }),
  gracePeriodMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_592_000_000 })),
}, { additionalProperties: false });
export type AdminMemoryForgetRequest = Static<typeof AdminMemoryForgetRequestSchema>;

export const AdminLearningSettingsResponseSchema = Type.Object({
  data: Type.Object({
    settings: LearningSettingsSchema,
    resourceRevision: ResourceRevisionSchema,
  }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type AdminLearningSettingsResponse = Static<typeof AdminLearningSettingsResponseSchema>;

export const AdminLearningCenterSchema = Type.Object({
  sessionId: IdentifierSchema,
  counts: Type.Object({
    workflows: Type.Integer({ minimum: 0 }),
    bindings: Type.Integer({ minimum: 0 }),
    feedback: Type.Integer({ minimum: 0 }),
    proposals: Type.Integer({ minimum: 0 }),
    policies: Type.Integer({ minimum: 0 }),
    evaluations: Type.Integer({ minimum: 0 }),
    approvals: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
  memoryEnabled: Type.Boolean(),
  learningEnabled: Type.Boolean(),
  autoExecutionEnabled: Type.Boolean(),
}, { additionalProperties: false });
export type AdminLearningCenter = Static<typeof AdminLearningCenterSchema>;

export const AdminLearningCenterResponseSchema = Type.Object({
  data: Type.Object({ center: AdminLearningCenterSchema }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type AdminLearningCenterResponse = Static<typeof AdminLearningCenterResponseSchema>;

export const AdminLearningSessionParamsSchema = Type.Object({ sessionId: IdentifierSchema }, { additionalProperties: false });
export const AdminLearningTaskRunParamsSchema = Type.Object({ taskRunId: IdentifierSchema }, { additionalProperties: false });

export const AdminTaskRunLearningPolicyRequestSchema = Type.Object({
  policy: Type.Union([Type.Literal("allow"), Type.Literal("metadata_only"), Type.Literal("deny")]),
  reason: Type.String({ minLength: 1, maxLength: 2_000 }),
}, { additionalProperties: false });
export type AdminTaskRunLearningPolicyRequest = Static<typeof AdminTaskRunLearningPolicyRequestSchema>;

export const AdminTaskRunLearningPolicyResponseSchema = Type.Object({
  data: Type.Object({
    taskRunId: IdentifierSchema,
    policy: Type.Union([Type.Literal("allow"), Type.Literal("metadata_only"), Type.Literal("deny")]),
    reason: Type.String({ maxLength: 2_000 }),
    resourceRevision: ResourceRevisionSchema,
  }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type AdminTaskRunLearningPolicyResponse = Static<typeof AdminTaskRunLearningPolicyResponseSchema>;

export const AdminWorkflowRevisionSchema = Type.Object({
  id: IdentifierSchema,
  revision: ResourceRevisionSchema,
  name: Type.String({ minLength: 1, maxLength: 300 }),
  intent: Type.String({ minLength: 1, maxLength: 5_000 }),
  steps: Type.Array(Type.Object({
    stepId: IdentifierSchema,
    instruction: Type.String({ minLength: 1, maxLength: 10_000 }),
    required: Type.Boolean(),
  }, { additionalProperties: false }), { maxItems: 100 }),
  requiredCapabilities: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 100 }),
  riskClass: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  createdAt: IsoDateTimeSchema,
}, { additionalProperties: false });
export type AdminWorkflowRevision = Static<typeof AdminWorkflowRevisionSchema>;

export const AdminWorkflowSchema = Type.Object({
  id: IdentifierSchema,
  scopeId: IdentifierSchema,
  status: Type.Union([Type.Literal("candidate"), Type.Literal("active"), Type.Literal("suspended"), Type.Literal("deprecated")]),
  activeRevisionId: Type.Union([IdentifierSchema, Type.Null()]),
  deletedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  purgeAfter: Type.Union([IsoDateTimeSchema, Type.Null()]),
  resourceRevision: ResourceRevisionSchema,
  revision: Type.Union([AdminWorkflowRevisionSchema, Type.Null()]),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}, { additionalProperties: false });
export type AdminWorkflow = Static<typeof AdminWorkflowSchema>;

export const AdminWorkflowsResponseSchema = Type.Object({
  data: Type.Object({ items: Type.Array(AdminWorkflowSchema), pageInfo: ProfilePageInfoSchema }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type AdminWorkflowsResponse = Static<typeof AdminWorkflowsResponseSchema>;

export const AdminWorkflowResponseSchema = Type.Object({
  data: Type.Object({ workflow: AdminWorkflowSchema }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type AdminWorkflowResponse = Static<typeof AdminWorkflowResponseSchema>;

export const AdminWorkflowParamsSchema = Type.Object({ workflowId: IdentifierSchema }, { additionalProperties: false });
export const AdminWorkflowActivationRequestSchema = Type.Object({
  revisionId: Type.Optional(IdentifierSchema),
  reason: Type.String({ minLength: 1, maxLength: 2_000 }),
}, { additionalProperties: false });
export const AdminWorkflowActivateRequestSchema = Type.Object({
  revisionId: Type.Optional(IdentifierSchema),
  approvalId: IdentifierSchema,
}, { additionalProperties: false });
export const AdminWorkflowSuspendRequestSchema = Type.Object({ reason: Type.String({ minLength: 1, maxLength: 2_000 }) }, { additionalProperties: false });
export const AdminWorkflowDeleteRequestSchema = Type.Object({
  reason: Type.String({ minLength: 1, maxLength: 2_000 }),
  gracePeriodMs: Type.Optional(Type.Integer({ minimum: 1, maximum: 2_592_000_000 })),
}, { additionalProperties: false });
export const AdminEmptyRequestSchema = Type.Object({}, { additionalProperties: false });

export const AdminAutonomyApprovalSchema = Type.Object({
  id: IdentifierSchema,
  scopeId: IdentifierSchema,
  actionType: Type.Union([
    Type.Literal("activate_workflow"), Type.Literal("apply_revision"),
    Type.Literal("start_canary"), Type.Literal("execute_workflow"),
  ]),
  targetType: Type.String({ minLength: 1, maxLength: 200 }),
  targetId: IdentifierSchema,
  status: Type.Union([
    Type.Literal("pending"), Type.Literal("approved"), Type.Literal("rejected"),
    Type.Literal("revoked"), Type.Literal("expired"), Type.Literal("executed"),
  ]),
  riskClass: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  requestedBy: Type.String({ minLength: 1, maxLength: 300 }),
  requestReason: Type.String({ maxLength: 2_000 }),
  expiresAt: IsoDateTimeSchema,
  decidedBy: Type.Union([Type.String({ minLength: 1, maxLength: 300 }), Type.Null()]),
  decisionReason: Type.String({ maxLength: 2_000 }),
  decidedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  executedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  resourceRevision: ResourceRevisionSchema,
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
}, { additionalProperties: false });
export type AdminAutonomyApproval = Static<typeof AdminAutonomyApprovalSchema>;

export const AdminAutonomyApprovalsResponseSchema = Type.Object({
  data: Type.Object({ items: Type.Array(AdminAutonomyApprovalSchema), pageInfo: ProfilePageInfoSchema }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type AdminAutonomyApprovalsResponse = Static<typeof AdminAutonomyApprovalsResponseSchema>;

export const AdminAutonomyApprovalResponseSchema = Type.Object({
  data: Type.Object({ approval: AdminAutonomyApprovalSchema }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type AdminAutonomyApprovalResponse = Static<typeof AdminAutonomyApprovalResponseSchema>;

export const AdminAutonomyParamsSchema = Type.Object({ approvalId: IdentifierSchema }, { additionalProperties: false });
export const AdminAutonomyDecisionRequestSchema = Type.Object({
  decision: Type.Union([Type.Literal("approved"), Type.Literal("rejected")]),
  reason: Type.String({ minLength: 1, maxLength: 2_000 }),
}, { additionalProperties: false });
export type AdminAutonomyDecisionRequest = Static<typeof AdminAutonomyDecisionRequestSchema>;
export const AdminAutonomyRevokeRequestSchema = Type.Object({ reason: Type.String({ minLength: 1, maxLength: 2_000 }) }, { additionalProperties: false });
export type AdminAutonomyRevokeRequest = Static<typeof AdminAutonomyRevokeRequestSchema>;
