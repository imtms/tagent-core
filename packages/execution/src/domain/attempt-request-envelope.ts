import { createHash } from "node:crypto";
import type { RuntimeModelSpec } from "./runtime-model.js";

export interface AttemptRequestEnvelopeDraft {
  runId: string;
  attemptId: string;
  attempt: number;
  requestOrdinal: number;
  /** The exact provider-dialect request body produced after all model-visible transforms. */
  providerPayload: unknown;
  model: RuntimeModelSpec;
  createdAt: number;
}

export interface AttemptRequestEnvelope extends AttemptRequestEnvelopeDraft {
  id: string;
  schemaVersion: 1;
  providerPayloadHash: string;
  envelopeHash: string;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonical(item)]));
  return value;
}

function assertJsonValue(value: unknown, path = "$", ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Attempt request value ${path} must be a finite JSON number`);
    return;
  }
  if (typeof value !== "object") throw new TypeError(`Attempt request value ${path} is not JSON-serializable`);
  if (ancestors.has(value)) throw new TypeError(`Attempt request value ${path} contains a cycle`);
  ancestors.add(value);
  if (Array.isArray(value)) value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, ancestors));
  else for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item !== undefined) assertJsonValue(item, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

export function canonicalRequestJson(value: unknown): string {
  assertJsonValue(value);
  return JSON.stringify(canonical(value));
}
export function requestHash(value: unknown): string { return createHash("sha256").update(canonicalRequestJson(value)).digest("hex"); }

export function createAttemptRequestEnvelope(draft: AttemptRequestEnvelopeDraft): AttemptRequestEnvelope {
  if (!Number.isSafeInteger(draft.attempt) || draft.attempt <= 0) throw new TypeError("Attempt request envelope attempt must be a positive integer");
  if (!Number.isSafeInteger(draft.requestOrdinal) || draft.requestOrdinal <= 0) throw new TypeError("Attempt request envelope ordinal must be a positive integer");
  const providerPayloadHash = requestHash(draft.providerPayload);
  const identity = { schemaVersion: 1 as const, ...draft, providerPayloadHash };
  const envelopeHash = requestHash(identity);
  return { id: `request-envelope:${draft.attemptId}:${draft.requestOrdinal}`, ...identity, envelopeHash };
}
