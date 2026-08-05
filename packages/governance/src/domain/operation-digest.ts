import { createHash } from "node:crypto";
import type {
  ApprovalScope,
  ApprovalSubject,
  ApprovalTarget,
} from "./approval.js";

export const OPERATION_DIGEST_ALGORITHM = "tagent.approval.operation.sha256.v1";
export const OPERATION_DIGEST_SCHEMA = "tagent.approval.operation/v1";
const operationDigestPrefix = "TAGENT_APPROVAL_OPERATION\0v1\0";

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export interface CanonicalOperationInput {
  subject: ApprovalSubject;
  action: string;
  target: ApprovalTarget;
  scope: ApprovalScope;
  payload: CanonicalJsonValue;
}

function normalizeCanonicalJson(value: unknown, ancestors: WeakSet<object>): CanonicalJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON requires finite numbers");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object") throw new TypeError(`Canonical JSON does not support ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError("Canonical JSON does not support cyclic values");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key === "symbol") || keys.length !== value.length + 1) {
        throw new TypeError("Canonical JSON requires dense arrays without extra properties");
      }
      const normalized: CanonicalJsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError("Canonical JSON requires dense arrays");
        }
        normalized.push(normalizeCanonicalJson(descriptor.value, ancestors));
      }
      return normalized;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON requires plain objects");
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      throw new TypeError("Canonical JSON does not support symbol keys");
    }
    const normalized = Object.create(null) as Record<string, CanonicalJsonValue>;
    for (const key of (ownKeys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("Canonical JSON requires enumerable data properties");
      }
      normalized[key] = normalizeCanonicalJson(descriptor.value, ancestors);
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalizeCanonicalJson(value, new WeakSet<object>()));
}

export function canonicalOperationJson(input: CanonicalOperationInput): string {
  return stableJson({
    schema: OPERATION_DIGEST_SCHEMA,
    subject: input.subject,
    action: input.action,
    target: input.target,
    scope: input.scope,
    payload: input.payload,
  });
}

export function operationDigest(input: CanonicalOperationInput): string {
  const digest = createHash("sha256")
    .update(operationDigestPrefix, "utf8")
    .update(canonicalOperationJson(input), "utf8")
    .digest("hex");
  return `${OPERATION_DIGEST_ALGORITHM}:${digest}`;
}
