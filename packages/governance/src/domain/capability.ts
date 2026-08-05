import { createHash } from "node:crypto";
import type {
  ApprovalRef,
  ApprovalRisk,
  ApprovalScope,
  ApprovalSubject,
  ApprovalTarget,
} from "./approval.js";
import {
  operationDigest,
  stableJson,
  type CanonicalJsonValue,
} from "./operation-digest.js";

export const CAPABILITY_COMMAND_SCHEMA = "tagent.capability.command/v1" as const;
declare const capabilityCommandBrand: unique symbol;

export interface CapabilityOperation {
  readonly subject: Readonly<ApprovalSubject>;
  readonly action: string;
  readonly target: Readonly<ApprovalTarget>;
  readonly scope: Readonly<ApprovalScope>;
  readonly payload: CanonicalJsonValue;
}

export interface CapabilityCommand {
  readonly [capabilityCommandBrand]: true;
  readonly schema: typeof CAPABILITY_COMMAND_SCHEMA;
  /** Global idempotency identity. Reusing it for another Attempt or operation is a conflict. */
  readonly commandId: string;
  readonly operation: CapabilityOperation;
}

export interface CapabilityCommandInput {
  readonly commandId: string;
  readonly operation: CapabilityOperation;
}

export interface CapabilityGrant {
  id: string;
  subject: ApprovalSubject;
  action: string;
  scope: ApprovalScope;
  riskCeiling: ApprovalRisk;
  expiresAt: number | null;
  revokedAt: number | null;
}

export type PolicyDecision =
  | { decision: "allow"; grantId: string; reasonCode: string }
  | { decision: "require_approval"; reasonCode: string; approvalRef?: ApprovalRef }
  | { decision: "deny"; reasonCode: string };

export interface AuthorizationReceipt {
  id: string;
  commandId: string;
  operationDigest: string;
  decision: PolicyDecision["decision"];
  approvalRef: ApprovalRef | null;
  grantId: string | null;
  actorId: string;
  details: CanonicalJsonValue;
  createdAt: number;
}

const unsafeCanonicalKeys = new Set(["__proto__", "constructor", "prototype"]);

function canonicalClone(value: unknown): unknown {
  return JSON.parse(stableJson(value)) as unknown;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be a canonical object`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  if (actual.length !== canonicalExpected.length
    || actual.some((key, index) => key !== canonicalExpected[index])) {
    throw new TypeError(`${name} must contain exactly: ${canonicalExpected.join(", ")}`);
  }
}

function assertNonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${name} must be a non-empty string without NUL bytes`);
  }
}

function assertSafeCanonicalKeys(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertSafeCanonicalKeys);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (unsafeCanonicalKeys.has(key)) throw new TypeError(`Canonical JSON key ${key} is not allowed`);
    assertSafeCanonicalKeys(child);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateOperation(value: unknown): CapabilityOperation {
  const operation = asRecord(value, "CapabilityCommand.operation");
  assertExactKeys(operation, ["subject", "action", "target", "scope", "payload"], "CapabilityCommand.operation");
  const subject = asRecord(operation.subject, "CapabilityCommand.operation.subject");
  assertExactKeys(subject, ["kind", "id"], "CapabilityCommand.operation.subject");
  if (subject.kind !== "task_run" && subject.kind !== "workflow") {
    throw new TypeError("CapabilityCommand.operation.subject.kind must be task_run or workflow");
  }
  assertNonEmpty(subject.id, "CapabilityCommand.operation.subject.id");
  assertNonEmpty(operation.action, "CapabilityCommand.operation.action");
  const target = asRecord(operation.target, "CapabilityCommand.operation.target");
  assertExactKeys(target, ["kind", "id"], "CapabilityCommand.operation.target");
  assertNonEmpty(target.kind, "CapabilityCommand.operation.target.kind");
  assertNonEmpty(target.id, "CapabilityCommand.operation.target.id");
  const scope = asRecord(operation.scope, "CapabilityCommand.operation.scope");
  assertExactKeys(scope, ["type", "id"], "CapabilityCommand.operation.scope");
  assertNonEmpty(scope.type, "CapabilityCommand.operation.scope.type");
  assertNonEmpty(scope.id, "CapabilityCommand.operation.scope.id");
  assertSafeCanonicalKeys(operation.payload);
  return operation as unknown as CapabilityOperation;
}

/** Creates the only supported, immutable CapabilityCommand representation. */
export function createCapabilityCommand(input: CapabilityCommandInput): CapabilityCommand {
  const cloned = asRecord(canonicalClone(input), "CapabilityCommand input");
  assertExactKeys(cloned, ["commandId", "operation"], "CapabilityCommand input");
  assertNonEmpty(cloned.commandId, "CapabilityCommand.commandId");
  const operation = validateOperation(cloned.operation);
  return deepFreeze({
    schema: CAPABILITY_COMMAND_SCHEMA,
    commandId: cloned.commandId,
    operation,
  }) as CapabilityCommand;
}

/** Re-validates an untrusted command at an application boundary and returns a detached immutable clone. */
export function parseCapabilityCommand(input: unknown): CapabilityCommand {
  const cloned = asRecord(canonicalClone(input), "CapabilityCommand");
  assertExactKeys(cloned, ["schema", "commandId", "operation"], "CapabilityCommand");
  if (cloned.schema !== CAPABILITY_COMMAND_SCHEMA) throw new TypeError("CapabilityCommand.schema is unsupported");
  return createCapabilityCommand({
    commandId: cloned.commandId as string,
    operation: cloned.operation as unknown as CapabilityOperation,
  });
}

/** Approval digest over operation semantics only; command identity and request metadata are excluded. */
export function capabilityOperationDigest(command: CapabilityCommand): string {
  return operationDigest(command.operation);
}

export function capabilityPayloadHash(command: CapabilityCommand): string {
  return createHash("sha256").update(stableJson(command.operation.payload), "utf8").digest("hex");
}

export function capabilityOperationType(command: CapabilityCommand): string {
  return command.operation.action;
}

export function capabilityOperationId(command: CapabilityCommand): string {
  return command.commandId;
}

export function capabilityAuthorizationReceiptId(command: CapabilityCommand): string {
  return `capability-authorization:${command.commandId}`;
}
