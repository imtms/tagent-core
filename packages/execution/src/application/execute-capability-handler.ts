import {
  parseCapabilityCommand,
  stableJson,
  type ApprovalRef,
  type CanonicalJsonValue,
} from "@tagent/governance/domain";
import type {
  CapabilityEffectPort,
  CapabilityEffectSettlement,
  CapabilityExecutionPersistencePort,
  CapabilityExecutionRequest,
  CapabilityExecutionState,
} from "../ports/capability-execution-port.js";
import {
  CapabilityGrantUnsupportedError,
  CapabilityOutcomeUnknownError,
} from "../capability-execution-errors.js";

export type ExecuteCapabilityInput = CapabilityExecutionRequest;

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

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function canonicalClone<T>(value: T): T {
  return deepFreeze(JSON.parse(stableJson(value)) as T);
}

function normalizeRequest(input: ExecuteCapabilityInput): CapabilityExecutionRequest {
  const cloned = asRecord(canonicalClone(input), "ExecuteCapability input");
  assertExactKeys(cloned, ["command", "fence", "approvalRef", "actorId", "details"], "ExecuteCapability input");
  const command = parseCapabilityCommand(cloned.command);
  const fence = asRecord(cloned.fence, "ExecuteCapability fence");
  assertExactKeys(
    fence,
    ["attemptId", "expectedVersion", "leaseToken", "executionFence"],
    "ExecuteCapability fence",
  );
  assertNonEmpty(fence.attemptId, "CapabilityExecutionFence.attemptId");
  assertNonEmpty(fence.leaseToken, "CapabilityExecutionFence.leaseToken");
  if (!Number.isSafeInteger(fence.expectedVersion) || (fence.expectedVersion as number) <= 0) {
    throw new TypeError("CapabilityExecutionFence.expectedVersion must be a positive safe integer");
  }
  if (!Number.isSafeInteger(fence.executionFence) || (fence.executionFence as number) <= 0) {
    throw new TypeError("CapabilityExecutionFence.executionFence must be a positive safe integer");
  }
  const approvalRef = asRecord(cloned.approvalRef, "ExecuteCapability approvalRef");
  assertExactKeys(approvalRef, ["source", "id"], "ExecuteCapability approvalRef");
  if (approvalRef.source !== "legacy_run" && approvalRef.source !== "legacy_workflow") {
    throw new TypeError("ExecuteCapability approvalRef.source must identify a legacy authority");
  }
  assertNonEmpty(approvalRef.id, "ExecuteCapability approvalRef.id");
  assertNonEmpty(cloned.actorId, "ExecuteCapability actorId");
  return deepFreeze({
    command,
    fence: {
      attemptId: fence.attemptId,
      expectedVersion: fence.expectedVersion as number,
      leaseToken: fence.leaseToken,
      executionFence: fence.executionFence as number,
    },
    approvalRef: approvalRef as unknown as ApprovalRef,
    actorId: cloned.actorId,
    details: cloned.details as CanonicalJsonValue,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Dormant approval-bound capability orchestration; composition does not wire it yet. */
export class ExecuteCapabilityHandler {
  constructor(
    private readonly persistence: CapabilityExecutionPersistencePort,
    private readonly effect: CapabilityEffectPort,
  ) {}

  async execute(input: ExecuteCapabilityInput): Promise<CapabilityExecutionState> {
    const request = normalizeRequest(input);
    const authorized = this.assertApprovalBound(request, this.persistence.authorizeAndClaim(request));
    if (authorized.status !== "authorized") return authorized;

    const begin = this.persistence.beginEffect(request);
    const running = this.assertApprovalBound(request, begin.state);
    if (!begin.started) {
      if (running.status === "authorized") {
        throw new Error(`Capability command ${request.command.commandId} did not acquire its effect start fence`);
      }
      return running;
    }
    if (running.status !== "running") {
      throw new Error(`Capability command ${request.command.commandId} began in unexpected ${running.status} state`);
    }

    let result: CanonicalJsonValue;
    try {
      result = canonicalClone(await this.effect.execute(request.command));
    } catch (effectError) {
      const settlement: CapabilityEffectSettlement = { status: "failed", error: errorMessage(effectError) };
      try {
        const failed = this.assertApprovalBound(request, this.persistence.settleEffect(request, settlement));
        if (failed.status !== "failed") {
          throw new Error(
            `Capability command ${request.command.commandId} failed settlement returned ${failed.status}`,
            { cause: effectError },
          );
        }
      } catch (settlementError) {
        this.markUnknownBestEffort(request, settlementError);
        throw new CapabilityOutcomeUnknownError(request.command.commandId, settlementError, effectError);
      }
      throw effectError;
    }

    try {
      const succeeded = this.assertApprovalBound(
        request,
        this.persistence.settleEffect(request, { status: "succeeded", result }),
      );
      if (succeeded.status !== "succeeded") {
        throw new Error(`Capability command ${request.command.commandId} success settlement returned ${succeeded.status}`);
      }
      return succeeded;
    } catch (settlementError) {
      this.markUnknownBestEffort(request, settlementError);
      throw new CapabilityOutcomeUnknownError(request.command.commandId, settlementError);
    }
  }

  private assertApprovalBound(
    request: CapabilityExecutionRequest,
    state: CapabilityExecutionState,
  ): CapabilityExecutionState {
    if (state.commandId !== request.command.commandId) {
      throw new Error(`Capability persistence returned a different command identity for ${request.command.commandId}`);
    }
    if (state.authorization.kind === "grant") {
      throw new CapabilityGrantUnsupportedError(state.authorization.grantId);
    }
    if (state.authorization.approvalRef.source !== request.approvalRef.source
      || state.authorization.approvalRef.id !== request.approvalRef.id) {
      throw new Error(`Capability command ${request.command.commandId} returned a different approval authority`);
    }
    return state;
  }

  private markUnknownBestEffort(request: CapabilityExecutionRequest, error: unknown): void {
    try {
      const unknown = this.assertApprovalBound(
        request,
        this.persistence.markOutcomeUnknown(request, { error: errorMessage(error) }),
      );
      if (unknown.status !== "outcome_unknown") {
        throw new Error(`Capability command ${request.command.commandId} unknown marker returned ${unknown.status}`);
      }
    } catch {
      // The typed error returned to the caller remains authoritative. A running
      // row is also non-replayable, so marker failure cannot repeat the effect.
    }
  }
}
