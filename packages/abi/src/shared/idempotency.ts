import { Type, type Static } from "typebox";

export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";
export const IDEMPOTENCY_KEY_PATTERN = "^[A-Za-z0-9._:-]+$";

export const IdempotencyKeySchema = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: IDEMPOTENCY_KEY_PATTERN,
});
export type IdempotencyKey = Static<typeof IdempotencyKeySchema>;
