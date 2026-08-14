import { Type, type Static } from "typebox";
import { IdempotencyKeySchema } from "../../shared/idempotency.js";
import { IdentifierSchema, IsoDateTimeSchema, JsonObjectSchema, RequestIdSchema } from "../../shared/primitives.js";

export const CAPABILITY_PROFILE_VERSION = "1.0" as const;

export const CAPABILITY_PROFILE_IDS = [
  "operator.session-settings.v1",
  "operator.session-inbox.v1",
  "operator.context-manifest.v1",
  "operator.skills.v1",
  "admin.memory.v1",
  "admin.learning.v1",
  "admin.workflow.v1",
  "admin.autonomy.v1",
] as const;

export const CapabilityProfileIdSchema = Type.Union([
  Type.Literal("operator.session-settings.v1"),
  Type.Literal("operator.session-inbox.v1"),
  Type.Literal("operator.context-manifest.v1"),
  Type.Literal("operator.skills.v1"),
  Type.Literal("admin.memory.v1"),
  Type.Literal("admin.learning.v1"),
  Type.Literal("admin.workflow.v1"),
  Type.Literal("admin.autonomy.v1"),
]);
export type CapabilityProfileId = Static<typeof CapabilityProfileIdSchema>;

export const PROFILE_SERVICE_SCOPES = [
  "operator:session-settings:read", "operator:session-settings:write",
  "operator:inbox:read", "operator:inbox:write", "operator:inbox:control",
  "operator:context-manifests:read",
  "operator:skills:read", "operator:skills:write",
  "admin:memory:read", "admin:memory:write",
  "admin:learning:read", "admin:learning:write",
  "admin:workflow:read", "admin:workflow:write",
  "admin:autonomy:read", "admin:autonomy:decide", "admin:autonomy:execute",
  "admin:operations:read",
] as const;

export const ProfileServiceScopeSchema = Type.Union([
  Type.Literal("operator:session-settings:read"), Type.Literal("operator:session-settings:write"),
  Type.Literal("operator:inbox:read"), Type.Literal("operator:inbox:write"), Type.Literal("operator:inbox:control"),
  Type.Literal("operator:context-manifests:read"),
  Type.Literal("operator:skills:read"), Type.Literal("operator:skills:write"),
  Type.Literal("admin:memory:read"), Type.Literal("admin:memory:write"),
  Type.Literal("admin:learning:read"), Type.Literal("admin:learning:write"),
  Type.Literal("admin:workflow:read"), Type.Literal("admin:workflow:write"),
  Type.Literal("admin:autonomy:read"), Type.Literal("admin:autonomy:decide"), Type.Literal("admin:autonomy:execute"),
  Type.Literal("admin:operations:read"),
]);
export type ProfileServiceScope = Static<typeof ProfileServiceScopeSchema>;

export const CapabilityProfileEndpointIdSchema = Type.String({
  minLength: 3,
  maxLength: 160,
  pattern: "^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*)+$",
});
export type CapabilityProfileEndpointId = Static<typeof CapabilityProfileEndpointIdSchema>;

export const ProfileWriteRecoverySchema = Type.Object({
  kind: Type.Union([
    Type.Literal("none"),
    Type.Literal("exact_replay_readback"),
    Type.Literal("durable_receipt_lookup"),
  ]),
  idempotencyKeyRequired: Type.Boolean(),
  revisionPreconditionRequired: Type.Boolean(),
  operationLookupPath: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  interruptedEffectState: Type.Union([Type.Literal("not_applicable"), Type.Literal("outcome_unknown")]),
  automaticUnknownReplay: Type.Literal(false),
}, { additionalProperties: false });
export type ProfileWriteRecovery = Static<typeof ProfileWriteRecoverySchema>;

export const CapabilityProfileEndpointSchema = Type.Object({
  id: CapabilityProfileEndpointIdSchema,
  method: Type.Union([
    Type.Literal("GET"), Type.Literal("POST"), Type.Literal("PUT"),
    Type.Literal("PATCH"), Type.Literal("DELETE"),
  ]),
  path: Type.String({ minLength: 1, pattern: "^/api/v1/" }),
  requiredScopes: Type.Array(ProfileServiceScopeSchema, { minItems: 1 }),
  resourceScope: Type.Union([
    Type.Literal("none"), Type.Literal("principal"), Type.Literal("workspace"),
    Type.Literal("session"), Type.Literal("task_run"), Type.Literal("memory"),
    Type.Literal("workflow"), Type.Literal("autonomy"),
  ]),
  recovery: ProfileWriteRecoverySchema,
}, { additionalProperties: false });
export type CapabilityProfileEndpoint = Static<typeof CapabilityProfileEndpointSchema>;

export const CapabilityProfileDescriptorSchema = Type.Object({
  id: CapabilityProfileIdSchema,
  version: Type.Literal(CAPABILITY_PROFILE_VERSION),
  audience: Type.Union([Type.Literal("operator"), Type.Literal("admin")]),
  detailPath: Type.String({ minLength: 1, pattern: "^/api/v1/capability-profiles/" }),
  endpointIds: Type.Array(CapabilityProfileEndpointIdSchema, { minItems: 1 }),
  endpoints: Type.Array(CapabilityProfileEndpointSchema, { minItems: 1 }),
  pagination: Type.Object({
    style: Type.Union([Type.Literal("none"), Type.Literal("opaque_cursor")]),
    cursorVersion: Type.Union([Type.Literal("1"), Type.Null()]),
    cursorOpaque: Type.Boolean(),
    cursorExpiry: Type.Boolean(),
    cursorSurvivesRestart: Type.Boolean(),
    membershipConsistency: Type.Union([Type.Literal("not_applicable"), Type.Literal("snapshot")]),
    defaultLimit: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    maximumLimit: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  }, { additionalProperties: false }),
  retention: Type.Object({
    automaticDeletion: Type.Boolean(),
    tombstones: Type.Boolean(),
    missingResourceStatus: Type.Union([Type.Literal(404), Type.Literal(410)]),
    operationReceiptDays: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  }, { additionalProperties: false }),
  compatibility: Type.Object({
    additiveChangesRequireMinor: Type.Literal(true),
    incompatibleChangesRequireMajor: Type.Literal(true),
    unknownResponseFields: Type.Literal("rejected"),
  }, { additionalProperties: false }),
}, { additionalProperties: false });
export type CapabilityProfileDescriptor = Static<typeof CapabilityProfileDescriptorSchema>;

export const CapabilityProfileAuthorizationSchema = Type.Object({
  principalId: IdentifierSchema,
  status: Type.Union([
    Type.Literal("available"), Type.Literal("partially_available"), Type.Literal("unavailable"),
  ]),
  availableEndpointIds: Type.Array(CapabilityProfileEndpointIdSchema),
  missingScopes: Type.Array(ProfileServiceScopeSchema),
}, { additionalProperties: false });
export type CapabilityProfileAuthorization = Static<typeof CapabilityProfileAuthorizationSchema>;

export const CapabilityProfileSummarySchema = Type.Object({
  id: CapabilityProfileIdSchema,
  version: Type.Literal(CAPABILITY_PROFILE_VERSION),
  audience: Type.Union([Type.Literal("operator"), Type.Literal("admin")]),
  detailPath: Type.String({ minLength: 1 }),
  authorization: CapabilityProfileAuthorizationSchema,
}, { additionalProperties: false });
export type CapabilityProfileSummary = Static<typeof CapabilityProfileSummarySchema>;

export const CapabilityProfileRegistryResponseSchema = Type.Object({
  data: Type.Object({ profiles: Type.Array(CapabilityProfileSummarySchema) }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type CapabilityProfileRegistryResponse = Static<typeof CapabilityProfileRegistryResponseSchema>;

export const CapabilityProfileDetailResponseSchema = Type.Object({
  data: Type.Object({
    profile: CapabilityProfileDescriptorSchema,
    authorization: CapabilityProfileAuthorizationSchema,
  }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type CapabilityProfileDetailResponse = Static<typeof CapabilityProfileDetailResponseSchema>;

export const CapabilityProfileParamsSchema = Type.Object({
  profileId: CapabilityProfileIdSchema,
}, { additionalProperties: false });
export type CapabilityProfileParams = Static<typeof CapabilityProfileParamsSchema>;

export const ResourceRevisionSchema = Type.Integer({ minimum: 1 });
export type ResourceRevision = Static<typeof ResourceRevisionSchema>;

export const RESOURCE_REVISION_ETAG_PATTERN = '^"r([1-9][0-9]*)"$';
export const ResourceRevisionEtagSchema = Type.String({ pattern: RESOURCE_REVISION_ETAG_PATTERN });
export type ResourceRevisionEtag = Static<typeof ResourceRevisionEtagSchema>;

export const ProfileMutationHeadersSchema = Type.Object({
  "idempotency-key": IdempotencyKeySchema,
  "if-match": ResourceRevisionEtagSchema,
  "x-tagent-delegated-actor": Type.Optional(IdentifierSchema),
  "x-tagent-delegated-request-id": Type.Optional(RequestIdSchema),
}, { additionalProperties: true });
export type ProfileMutationHeaders = Static<typeof ProfileMutationHeadersSchema>;

export const ProfileOperationHeadersSchema = Type.Object({
  "idempotency-key": IdempotencyKeySchema,
  "x-tagent-delegated-actor": Type.Optional(IdentifierSchema),
  "x-tagent-delegated-request-id": Type.Optional(RequestIdSchema),
}, { additionalProperties: true });
export type ProfileOperationHeaders = Static<typeof ProfileOperationHeadersSchema>;

export const ProfileListQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
}, { additionalProperties: false });
export type ProfileListQuery = Static<typeof ProfileListQuerySchema>;

export const ProfilePageInfoSchema = Type.Object({
  nextCursor: Type.Union([Type.String({ minLength: 1, maxLength: 4096 }), Type.Null()]),
  hasMore: Type.Boolean(),
  limit: Type.Integer({ minimum: 1, maximum: 200 }),
  snapshot: Type.String({ minLength: 1, maxLength: 4096 }),
}, { additionalProperties: false });
export type ProfilePageInfo = Static<typeof ProfilePageInfoSchema>;

export const ProfileOperationStatusSchema = Type.Union([
  Type.Literal("started"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("outcome_unknown"),
]);
export type ProfileOperationStatus = Static<typeof ProfileOperationStatusSchema>;

export const ProfileOperationReceiptSchema = Type.Object({
  requestId: IdempotencyKeySchema,
  profileId: CapabilityProfileIdSchema,
  endpointId: CapabilityProfileEndpointIdSchema,
  status: ProfileOperationStatusSchema,
  resource: Type.Object({ type: Type.String({ minLength: 1 }), id: IdentifierSchema }, { additionalProperties: false }),
  result: Type.Union([JsonObjectSchema, Type.Null()]),
  error: Type.Union([JsonObjectSchema, Type.Null()]),
  createdAt: IsoDateTimeSchema,
  updatedAt: IsoDateTimeSchema,
  completedAt: Type.Union([IsoDateTimeSchema, Type.Null()]),
}, { additionalProperties: false });
export type ProfileOperationReceipt = Static<typeof ProfileOperationReceiptSchema>;

export const ProfileOperationResponseSchema = Type.Object({
  data: Type.Object({ operation: ProfileOperationReceiptSchema }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type ProfileOperationResponse = Static<typeof ProfileOperationResponseSchema>;
