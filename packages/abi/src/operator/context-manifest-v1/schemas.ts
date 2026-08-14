import { Type, type Static } from "typebox";
import { IdentifierSchema, IsoDateTimeSchema, RequestIdSchema } from "../../shared/primitives.js";
import { ProfilePageInfoSchema } from "../../profiles/v1/schemas.js";

export const PublicContextManifestItemKindSchema = Type.Union([
  Type.Literal("system_prompt"), Type.Literal("taskrun_contract"), Type.Literal("workspace_goal"),
  Type.Literal("skill"), Type.Literal("session_message"), Type.Literal("transcript_message"),
  Type.Literal("core_memory"), Type.Literal("memory_card"), Type.Literal("cold_topic"),
  Type.Literal("workflow_revision"), Type.Literal("communication_profile"), Type.Literal("project_rule"),
  Type.Literal("user_prompt"),
]);

export const PublicContextManifestItemSchema = Type.Object({
  kind: PublicContextManifestItemKindSchema,
  sourceRef: Type.String({ minLength: 16, maxLength: 64, pattern: "^[a-f0-9]+$" }),
  selected: Type.Boolean(),
  estimatedTokens: Type.Integer({ minimum: 0 }),
}, { additionalProperties: false });

export const PublicContextManifestSchema = Type.Object({
  id: IdentifierSchema,
  taskRunId: IdentifierSchema,
  attempt: Type.Integer({ minimum: 1 }),
  source: Type.Union([Type.Literal("session"), Type.Literal("transcript")]),
  manifestHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]+$" }),
  items: Type.Array(PublicContextManifestItemSchema, { maxItems: 10_000 }),
  stats: Type.Object({
    itemCount: Type.Integer({ minimum: 0 }),
    selectedItemCount: Type.Integer({ minimum: 0 }),
    estimatedTokens: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
  createdAt: IsoDateTimeSchema,
}, { additionalProperties: false });
export type PublicContextManifest = Static<typeof PublicContextManifestSchema>;

export const OperatorContextManifestParamsSchema = Type.Object({ taskRunId: IdentifierSchema }, { additionalProperties: false });

export const OperatorContextManifestListResponseSchema = Type.Object({
  data: Type.Object({
    items: Type.Array(PublicContextManifestSchema),
    pageInfo: ProfilePageInfoSchema,
  }, { additionalProperties: false }),
  requestId: RequestIdSchema,
}, { additionalProperties: false });
export type OperatorContextManifestListResponse = Static<typeof OperatorContextManifestListResponseSchema>;
