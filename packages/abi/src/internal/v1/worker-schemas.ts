import { Type, type Static } from "typebox";
import { IdentifierSchema, IsoDateTimeSchema, JsonObjectSchema } from "../../shared/primitives.js";

export const WorkerLeaseSchema = Type.Object({
  workerId: IdentifierSchema,
  jobId: IdentifierSchema,
  leaseToken: Type.String({ minLength: 1 }),
  fence: Type.Integer({ minimum: 1 }),
  expiresAt: IsoDateTimeSchema,
});
export type WorkerLease = Static<typeof WorkerLeaseSchema>;

const WorkerCallbackBase = {
  workerId: IdentifierSchema,
  jobId: IdentifierSchema,
  leaseToken: Type.String({ minLength: 1 }),
  fence: Type.Integer({ minimum: 1 }),
  occurredAt: IsoDateTimeSchema,
};

export const WorkerCallbackSchema = Type.Union([
  Type.Object({
    ...WorkerCallbackBase,
    type: Type.Literal("worker.progressed"),
    payload: Type.Object({ progress: Type.Number({ minimum: 0, maximum: 1 }), details: JsonObjectSchema }),
  }, { additionalProperties: false }),
  Type.Object({
    ...WorkerCallbackBase,
    type: Type.Literal("worker.completed"),
    payload: Type.Object({ result: JsonObjectSchema }),
  }, { additionalProperties: false }),
  Type.Object({
    ...WorkerCallbackBase,
    type: Type.Literal("worker.failed"),
    payload: Type.Object({ code: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1 }), retryable: Type.Boolean() }),
  }, { additionalProperties: false }),
]);
export type WorkerCallback = Static<typeof WorkerCallbackSchema>;

export const WorkerReceiptSchema = Type.Object({
  receiptId: IdentifierSchema,
  workerId: IdentifierSchema,
  jobId: IdentifierSchema,
  fence: Type.Integer({ minimum: 1 }),
  status: Type.Union([Type.Literal("accepted"), Type.Literal("duplicate"), Type.Literal("stale_fence")]),
  callbackType: Type.Union([
    Type.Literal("worker.progressed"), Type.Literal("worker.completed"), Type.Literal("worker.failed"),
  ]),
  receivedAt: IsoDateTimeSchema,
});
export type WorkerReceipt = Static<typeof WorkerReceiptSchema>;
