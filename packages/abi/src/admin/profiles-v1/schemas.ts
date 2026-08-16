import { Type, type Static } from "typebox";
import { IdentifierSchema, IsoDateTimeSchema, RequestIdSchema } from "../../shared/primitives.js";
import { MemoryKindSchema, MemoryScopeSchema, MemoryStatusSchema } from "../v1/memory-schemas.js";
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
