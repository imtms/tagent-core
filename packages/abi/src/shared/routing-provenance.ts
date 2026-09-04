import { Type, type Static } from "typebox";

export const RoutingUsageSchema = Type.Object({
  model: Type.String({ minLength: 1, maxLength: 500 }),
  input: Type.Number({ minimum: 0 }),
  output: Type.Number({ minimum: 0 }),
  cacheRead: Type.Number({ minimum: 0 }),
  cacheWrite: Type.Number({ minimum: 0 }),
  totalTokens: Type.Number({ minimum: 0 }),
}, { additionalProperties: false });
export type RoutingUsage = Static<typeof RoutingUsageSchema>;

/** Shared routing provenance shape used by Channel, Console, and Operator Inbox. */
export const RoutingProvenanceSchema = Type.Object({
  decisionSource: Type.Union([Type.Literal("deterministic"), Type.Literal("model"), Type.Literal("fallback")]),
  sourceHash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]+$" }),
  sourceChars: Type.Integer({ minimum: 0 }),
  projectionStrategy: Type.Union([Type.Literal("not_sent"), Type.Literal("full"), Type.Literal("head_tail")]),
  projectedChars: Type.Integer({ minimum: 0 }),
  promptEstimatedTokens: Type.Integer({ minimum: 0 }),
  inputBudgetTokens: Type.Union([Type.Integer({ minimum: 0 }), Type.Null()]),
  modelAttempted: Type.Boolean(),
  modelSucceeded: Type.Boolean(),
  usage: Type.Array(RoutingUsageSchema, { maxItems: 64 }),
  abstention: Type.Union([Type.Literal("none"), Type.Literal("new_task_low_confidence"), Type.Literal("active_control_low_confidence")]),
  detail: Type.Optional(Type.String({ maxLength: 500 })),
}, { additionalProperties: false });
export type RoutingProvenance = Static<typeof RoutingProvenanceSchema>;
