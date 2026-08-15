import { Type, type Static } from "typebox";

export const IdentifierSchema = Type.String({ minLength: 1, maxLength: 256 });
export type Identifier = Static<typeof IdentifierSchema>;

export const RequestIdSchema = Type.String({ minLength: 1, maxLength: 256 });
export type RequestId = Static<typeof RequestIdSchema>;

export const IsoDateTimeSchema = Type.String({ format: "date-time" });
export type IsoDateTime = Static<typeof IsoDateTimeSchema>;

export const TimestampMillisecondsSchema = Type.Integer({ minimum: 0 });
export type TimestampMilliseconds = Static<typeof TimestampMillisecondsSchema>;

export const JsonObjectSchema = Type.Record(Type.String(), Type.Unknown());
export type JsonObject = Static<typeof JsonObjectSchema>;

export const PageInfoSchema = Type.Object({
  nextCursor: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  hasMore: Type.Boolean(),
});
export type PageInfo = Static<typeof PageInfoSchema>;
