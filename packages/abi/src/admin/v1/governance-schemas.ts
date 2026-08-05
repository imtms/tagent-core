import { Type, type Static } from "typebox";
import { IdentifierSchema, IsoDateTimeSchema, JsonObjectSchema, RequestIdSchema } from "../../shared/primitives.js";

export const RiskClassSchema = Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]);
export type RiskClass = Static<typeof RiskClassSchema>;

export const WorkflowRevisionSchema = Type.Object({
  id: IdentifierSchema,
  workflowId: IdentifierSchema,
  revision: Type.Integer({ minimum: 1 }),
  name: Type.String({ minLength: 1 }),
  intent: Type.String({ minLength: 1 }),
  cueTerms: Type.Array(Type.String()),
  applicability: Type.Array(Type.String()),
  nonApplicability: Type.Array(Type.String()),
  steps: Type.Array(Type.Object({
    stepId: IdentifierSchema,
    instruction: Type.String({ minLength: 1 }),
    required: Type.Boolean(),
  })),
  verification: Type.Array(Type.Object({
    check: Type.String({ minLength: 1 }),
    required: Type.Boolean(),
    successCondition: Type.String({ minLength: 1 }),
  })),
  requiredCapabilities: Type.Array(Type.String()),
  riskClass: RiskClassSchema,
  confidence: Type.Number({ minimum: 0, maximum: 1 }),
  createdAt: IsoDateTimeSchema,
});
export type WorkflowRevision = Static<typeof WorkflowRevisionSchema>;

export const WorkflowDefinitionSchema = Type.Object({
  id: IdentifierSchema,
  scopeId: IdentifierSchema,
  status: Type.Union([
    Type.Literal("candidate"), Type.Literal("active"), Type.Literal("suspended"), Type.Literal("deprecated"),
  ]),
  activeRevisionId: Type.Union([IdentifierSchema, Type.Null()]),
  deletedAt: Type.Optional(Type.Union([IsoDateTimeSchema, Type.Null()])),
  purgeAfter: Type.Optional(Type.Union([IsoDateTimeSchema, Type.Null()])),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  revision: Type.Optional(WorkflowRevisionSchema),
});
export type WorkflowDefinition = Static<typeof WorkflowDefinitionSchema>;

export const WorkflowProposalSchema = Type.Object({
  id: IdentifierSchema,
  workflowId: IdentifierSchema,
  baseRevisionId: IdentifierSchema,
  reason: Type.String(),
  patch: JsonObjectSchema,
  changedPaths: Type.Array(Type.String()),
  status: Type.Union([
    Type.Literal("candidate"), Type.Literal("approved"), Type.Literal("rejected"), Type.Literal("applied"),
  ]),
  createdAt: IsoDateTimeSchema,
});
export type WorkflowProposal = Static<typeof WorkflowProposalSchema>;

export const AutonomyApprovalSchema = Type.Object({
  id: IdentifierSchema,
  scopeId: IdentifierSchema,
  actionType: Type.Union([
    Type.Literal("activate_workflow"), Type.Literal("apply_revision"),
    Type.Literal("start_canary"), Type.Literal("execute_workflow"),
  ]),
  targetType: Type.String({ minLength: 1 }),
  targetId: IdentifierSchema,
  status: Type.Union([
    Type.Literal("pending"), Type.Literal("approved"), Type.Literal("rejected"),
    Type.Literal("revoked"), Type.Literal("expired"), Type.Literal("executed"),
  ]),
  riskClass: RiskClassSchema,
  impactScope: JsonObjectSchema,
  evidence: JsonObjectSchema,
  diff: JsonObjectSchema,
  rollback: JsonObjectSchema,
  requestedBy: IdentifierSchema,
  requestReason: Type.String({ minLength: 1 }),
  expiresAt: IsoDateTimeSchema,
  decidedBy: Type.Union([IdentifierSchema, Type.Null()]),
  decisionReason: Type.String(),
  decidedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  executedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
  executionReceipt: Type.Union([JsonObjectSchema, Type.Null()]),
  createdAt: IsoDateTimeSchema,
});
export type AutonomyApproval = Static<typeof AutonomyApprovalSchema>;

export const GovernanceDecisionRequestSchema = Type.Object({
  action: Type.Union([Type.Literal("approve"), Type.Literal("reject"), Type.Literal("revoke"), Type.Literal("execute")]),
  actor: IdentifierSchema,
  reason: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
export type GovernanceDecisionRequest = Static<typeof GovernanceDecisionRequestSchema>;

export const AutonomyApprovalResponseSchema = Type.Object({
  data: Type.Object({ approval: AutonomyApprovalSchema }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type AutonomyApprovalResponse = Static<typeof AutonomyApprovalResponseSchema>;
