import { Type, type Static } from "typebox";
import { IdentifierSchema, IsoDateTimeSchema, RequestIdSchema } from "../../shared/primitives.js";
import { ProfilePageInfoSchema, ResourceRevisionSchema } from "../../profiles/v1/schemas.js";

const Sha256Schema = Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" });

export const OperatorSkillSummarySchema = Type.Object({
  id: IdentifierSchema,
  name: Type.String({ minLength: 1, maxLength: 64 }),
  latestRevision: ResourceRevisionSchema,
  latestRevisionId: IdentifierSchema,
  description: Type.String({ minLength: 1, maxLength: 1024 }),
  sha256: Sha256Schema,
  workspaceCount: Type.Integer({ minimum: 0 }),
  resourceRevision: ResourceRevisionSchema,
  updatedAt: IsoDateTimeSchema,
}, { additionalProperties: false });
export type OperatorSkillSummary = Static<typeof OperatorSkillSummarySchema>;

export const OperatorSkillRevisionSchema = Type.Object({
  id: IdentifierSchema,
  skillId: IdentifierSchema,
  revision: ResourceRevisionSchema,
  name: Type.String({ minLength: 1, maxLength: 64 }),
  description: Type.String({ minLength: 1, maxLength: 1024 }),
  content: Type.String({ minLength: 1, maxLength: 524_288 }),
  sha256: Sha256Schema,
  disableModelInvocation: Type.Boolean(),
  createdAt: IsoDateTimeSchema,
}, { additionalProperties: false });
export type OperatorSkillRevision = Static<typeof OperatorSkillRevisionSchema>;

export const OperatorSkillParamsSchema = Type.Object({ skillId: IdentifierSchema }, { additionalProperties: false });
export const OperatorWorkspaceSkillParamsSchema = Type.Object({ workspaceId: IdentifierSchema }, { additionalProperties: false });

export const OperatorSkillUploadRequestSchema = Type.Object({
  filename: Type.String({ minLength: 1, maxLength: 255 }),
  contentBase64: Type.String({ minLength: 4, maxLength: 11_200_000 }),
}, { additionalProperties: false });
export type OperatorSkillUploadRequest = Static<typeof OperatorSkillUploadRequestSchema>;

export const OperatorSkillUpdateRequestSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 64 }),
  description: Type.String({ minLength: 1, maxLength: 1024 }),
  content: Type.String({ minLength: 1, maxLength: 524_288 }),
  disableModelInvocation: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
export type OperatorSkillUpdateRequest = Static<typeof OperatorSkillUpdateRequestSchema>;

export const OperatorWorkspaceSkillsReplaceRequestSchema = Type.Object({
  skillIds: Type.Array(IdentifierSchema, { maxItems: 32, uniqueItems: true }),
}, { additionalProperties: false });
export type OperatorWorkspaceSkillsReplaceRequest = Static<typeof OperatorWorkspaceSkillsReplaceRequestSchema>;

export const OperatorSkillCatalogResponseSchema = Type.Object({
  data: Type.Object({
    items: Type.Array(OperatorSkillSummarySchema),
    collectionRevision: ResourceRevisionSchema,
    pageInfo: ProfilePageInfoSchema,
  }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type OperatorSkillCatalogResponse = Static<typeof OperatorSkillCatalogResponseSchema>;

export const OperatorSkillResponseSchema = Type.Object({
  data: Type.Object({
    skill: OperatorSkillRevisionSchema,
    resourceRevision: ResourceRevisionSchema,
    catalogRevision: ResourceRevisionSchema,
  }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type OperatorSkillResponse = Static<typeof OperatorSkillResponseSchema>;

export const OperatorSkillRevisionsResponseSchema = Type.Object({
  data: Type.Object({
    items: Type.Array(OperatorSkillRevisionSchema),
    resourceRevision: ResourceRevisionSchema,
    pageInfo: ProfilePageInfoSchema,
  }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type OperatorSkillRevisionsResponse = Static<typeof OperatorSkillRevisionsResponseSchema>;

export const OperatorSkillDeleteResponseSchema = Type.Object({
  data: Type.Object({
    ok: Type.Literal(true),
    skillId: IdentifierSchema,
    catalogRevision: ResourceRevisionSchema,
  }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type OperatorSkillDeleteResponse = Static<typeof OperatorSkillDeleteResponseSchema>;

export const OperatorWorkspaceSkillsResponseSchema = Type.Object({
  data: Type.Object({
    items: Type.Array(OperatorSkillRevisionSchema),
    bindingRevision: ResourceRevisionSchema,
    pageInfo: ProfilePageInfoSchema,
  }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type OperatorWorkspaceSkillsResponse = Static<typeof OperatorWorkspaceSkillsResponseSchema>;
