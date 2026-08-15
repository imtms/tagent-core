import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_COMMAND_SCHEMA,
  capabilityAuthorizationReceiptId,
  capabilityOperationDigest,
  capabilityOperationId,
  capabilityOperationType,
  capabilityPayloadHash,
  createCapabilityCommand,
  operationDigest,
  stableJson,
  type CanonicalJsonValue,
  type CapabilityCommand,
} from "@tagent/governance";

function assertFactoryOnlyTypeBoundary(created: CapabilityCommand): void {
  // @ts-expect-error CapabilityCommand carries a private factory brand.
  const forged: CapabilityCommand = {
    schema: CAPABILITY_COMMAND_SCHEMA,
    commandId: "forged",
    operation: created.operation,
  };
  // @ts-expect-error The immutable operation graph cannot be mutated by consumers.
  created.operation.subject.id = "other-run";
  void forged;
}
void assertFactoryOnlyTypeBoundary;

function command(commandId = "command-1", payload: CanonicalJsonValue = { z: 2, a: [1, 0] }) {
  return createCapabilityCommand({
    commandId,
    operation: {
      subject: { kind: "task_run", id: "run-1" },
      action: "workspace.file.write",
      target: { kind: "workspace_path", id: "notes/result.txt" },
      scope: { type: "session", id: "session-1" },
      payload,
    },
  });
}

describe("CapabilityCommand", () => {
  it("creates a strict canonical clone and deeply freezes the complete value object", () => {
    const payload = { z: 2, a: [1, -0] };
    const created = command("command-frozen", payload);

    expect(created).toEqual({
      schema: CAPABILITY_COMMAND_SCHEMA,
      commandId: "command-frozen",
      operation: {
        subject: { kind: "task_run", id: "run-1" },
        action: "workspace.file.write",
        target: { kind: "workspace_path", id: "notes/result.txt" },
        scope: { type: "session", id: "session-1" },
        payload: { a: [1, 0], z: 2 },
      },
    });
    expect(Object.isFrozen(created)).toBe(true);
    expect(Object.isFrozen(created.operation)).toBe(true);
    expect(Object.isFrozen(created.operation.subject)).toBe(true);
    expect(Object.isFrozen(created.operation.target)).toBe(true);
    expect(Object.isFrozen(created.operation.scope)).toBe(true);
    expect(Object.isFrozen(created.operation.payload)).toBe(true);
    expect(Object.isFrozen((created.operation.payload as { a: number[] }).a)).toBe(true);

    payload.z = 99;
    payload.a[0] = 99;
    expect(created.operation.payload).toEqual({ a: [1, 0], z: 2 });
    expect(() => { (created.operation as { action: string }).action = "workspace.shell.execute"; }).toThrow();
  });

  it("rejects noncanonical dual fields, extra structure, accessors, and invalid payloads", () => {
    expect(() => createCapabilityCommand({
      commandId: "dual-field",
      operation: {
        subject: { kind: "task_run", id: "run-1" },
        capability: "workspace.file",
        action: "workspace.file.write",
        target: { kind: "workspace_path", id: "a.txt" },
        scope: { type: "session", id: "session-1" },
        payload: {},
      },
    } as never)).toThrow("exactly");

    const accessor = Object.defineProperty({}, "secret", { enumerable: true, get: () => "value" });
    expect(() => command("accessor", accessor as never)).toThrow("data properties");
    expect(() => command("date", { date: new Date() } as never)).toThrow("plain objects");
    expect(() => createCapabilityCommand({
      commandId: "nul\0command",
      operation: {
        subject: { kind: "task_run", id: "run-1" },
        action: "workspace.file.write",
        target: { kind: "workspace_path", id: "a.txt" },
        scope: { type: "session", id: "session-1" },
        payload: {},
      },
    })).toThrow("commandId");
  });

  it("binds the digest only to the operation five-tuple and provides one identity vocabulary", () => {
    const first = command("command-a");
    const second = command("command-b");

    expect(capabilityOperationDigest(first)).toBe(capabilityOperationDigest(second));
    expect(capabilityOperationDigest(first)).toBe(operationDigest(first.operation));
    const changedOperations = [
      { ...first.operation, subject: { kind: "task_run" as const, id: "run-2" } },
      { ...first.operation, action: "workspace.file.delete" },
      { ...first.operation, target: { kind: "workspace_path", id: "notes/other.txt" } },
      { ...first.operation, scope: { type: "session", id: "session-2" } },
      { ...first.operation, payload: { path: "notes/other.txt" } },
    ];
    const digests = changedOperations.map((operation) => capabilityOperationDigest(createCapabilityCommand({
      commandId: first.commandId,
      operation,
    })));
    expect(digests).toHaveLength(5);
    expect(new Set([capabilityOperationDigest(first), ...digests])).toHaveLength(6);

    expect(capabilityOperationId(first)).toBe("command-a");
    expect(capabilityAuthorizationReceiptId(first)).toBe("capability-authorization:command-a");
    expect(capabilityOperationType(first)).toBe("workspace.file.write");
    expect(capabilityPayloadHash(first)).toBe(
      createHash("sha256").update(stableJson(first.operation.payload), "utf8").digest("hex"),
    );
  });
});
