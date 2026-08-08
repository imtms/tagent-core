import { Type, type Static } from "typebox";

export const GatewayProvenanceSchema = Type.Object({
  surface: Type.Union([Type.Literal("web"), Type.Literal("channel"), Type.Literal("api")]),
  gatewayActorId: Type.String({ minLength: 1, maxLength: 256 }),
  sourceId: Type.String({ minLength: 1, maxLength: 256 }),
  externalRequestId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
}, { additionalProperties: false });
export type GatewayProvenance = Static<typeof GatewayProvenanceSchema>;
