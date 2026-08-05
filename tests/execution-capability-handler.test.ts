import { describe, expect, it, vi } from "vitest";
import { createCapabilityCommand, type CanonicalJsonValue } from "@tagent/governance";
import {
  CapabilityGrantUnsupportedError,
  CapabilityOutcomeUnknownError,
  ExecuteCapabilityHandler,
} from "@tagent/execution/application";
import type {
  CapabilityEffectPort,
  CapabilityEffectSettlement,
  CapabilityExecutionPersistencePort,
  CapabilityExecutionRequest,
  CapabilityExecutionState,
} from "@tagent/execution/ports";

function command(commandId = "command-1") {
  return createCapabilityCommand({
    commandId,
    operation: {
      subject: { kind: "task_run", id: "run-1" },
      action: "workspace.file.write",
      target: { kind: "workspace_path", id: "notes/result.txt" },
      scope: { type: "session", id: "session-1" },
      payload: { path: "notes/result.txt", content: "done" },
    },
  });
}

const approvalRef = { source: "legacy_run" as const, id: "approval-1" };

function request(commandId = "command-1") {
  return {
    command: command(commandId),
    fence: {
      attemptId: "attempt-1",
      expectedVersion: 3,
      leaseToken: "lease-1",
      executionFence: 7,
    },
    approvalRef,
    actorId: "human-1",
    details: { channel: "test" },
  };
}

function state(
  status: CapabilityExecutionState["status"],
  overrides: Partial<CapabilityExecutionState> = {},
): CapabilityExecutionState {
  return {
    commandId: "command-1",
    status,
    authorization: { kind: "approval", approvalRef },
    error: "",
    ...overrides,
  };
}

class ControlledPersistence implements CapabilityExecutionPersistencePort {
  readonly calls: string[] = [];
  current = state("authorized");
  beginStarted = true;
  settleError: Error | undefined;
  unknownError: Error | undefined;

  authorizeAndClaim(_request: CapabilityExecutionRequest) {
    this.calls.push("authorize");
    return this.current;
  }

  beginEffect(_request: CapabilityExecutionRequest) {
    this.calls.push("begin");
    this.current = state("running");
    return { state: this.current, started: this.beginStarted };
  }

  settleEffect(_request: CapabilityExecutionRequest, settlement: CapabilityEffectSettlement) {
    this.calls.push(`settle:${settlement.status}`);
    if (this.settleError) throw this.settleError;
    this.current = settlement.status === "succeeded"
      ? state("succeeded", { result: settlement.result })
      : state("failed", { error: settlement.error });
    return this.current;
  }

  markOutcomeUnknown(_request: CapabilityExecutionRequest, input: { error: string }) {
    this.calls.push("unknown");
    if (this.unknownError) throw this.unknownError;
    this.current = state("outcome_unknown", { error: input.error });
    return this.current;
  }
}

function fixture(result: CanonicalJsonValue = { bytesWritten: 4 }) {
  const persistence = new ControlledPersistence();
  const effect: CapabilityEffectPort = { execute: vi.fn(async () => result) };
  return { persistence, effect, handler: new ExecuteCapabilityHandler(persistence, effect) };
}

describe("ExecuteCapabilityHandler", () => {
  it("authorizes and claims before beginning the asynchronous effect, then settles success", async () => {
    const { persistence, effect, handler } = fixture();

    await expect(handler.execute(request())).resolves.toMatchObject({
      status: "succeeded",
      result: { bytesWritten: 4 },
    });
    expect(persistence.calls).toEqual(["authorize", "begin", "settle:succeeded"]);
    expect(effect.execute).toHaveBeenCalledOnce();
    expect(effect.execute).toHaveBeenCalledWith(expect.objectContaining({ commandId: "command-1" }));
  });

  it.each(["running", "failed", "outcome_unknown", "cancelled"] as const)(
    "returns persisted %s state without replaying the effect",
    async (status) => {
      const { persistence, effect, handler } = fixture();
      persistence.current = state(status);

      await expect(handler.execute(request())).resolves.toMatchObject({ status });
      expect(persistence.calls).toEqual(["authorize"]);
      expect(effect.execute).not.toHaveBeenCalled();
    },
  );

  it("returns a persisted succeeded result idempotently without replaying the effect", async () => {
    const { persistence, effect, handler } = fixture();
    persistence.current = state("succeeded", { result: { bytesWritten: 4 } });

    await expect(handler.execute(request())).resolves.toMatchObject({
      status: "succeeded",
      result: { bytesWritten: 4 },
    });
    expect(persistence.calls).toEqual(["authorize"]);
    expect(effect.execute).not.toHaveBeenCalled();
  });

  it("resumes authorized work but only the begin-effect winner invokes the effect", async () => {
    const { persistence, effect, handler } = fixture();
    persistence.beginStarted = false;

    await expect(handler.execute(request())).resolves.toMatchObject({ status: "running" });
    expect(persistence.calls).toEqual(["authorize", "begin"]);
    expect(effect.execute).not.toHaveBeenCalled();
  });

  it("settles a thrown effect as failed and never replays it", async () => {
    const { persistence, effect, handler } = fixture();
    const effectError = new Error("workspace write failed");
    vi.mocked(effect.execute).mockRejectedValueOnce(effectError);

    await expect(handler.execute(request())).rejects.toBe(effectError);
    expect(persistence.calls).toEqual(["authorize", "begin", "settle:failed"]);
    await expect(handler.execute(request())).resolves.toMatchObject({
      status: "failed",
      error: "workspace write failed",
    });
    expect(effect.execute).toHaveBeenCalledOnce();
  });

  it("marks outcome unknown when a thrown effect cannot be durably settled as failed", async () => {
    const { persistence, effect, handler } = fixture();
    const effectError = new Error("workspace helper disconnected after write");
    persistence.settleError = new Error("failed settlement lost its writer fence");
    vi.mocked(effect.execute).mockRejectedValueOnce(effectError);

    await expect(handler.execute(request())).rejects.toMatchObject({
      name: "CapabilityOutcomeUnknownError",
      commandId: "command-1",
      cause: persistence.settleError,
      effectError,
    });
    expect(persistence.calls).toEqual(["authorize", "begin", "settle:failed", "unknown"]);
    await expect(handler.execute(request())).resolves.toMatchObject({ status: "outcome_unknown" });
    expect(effect.execute).toHaveBeenCalledOnce();
  });

  it("marks outcome unknown best-effort and throws a typed error when success settlement fails", async () => {
    const { persistence, effect, handler } = fixture();
    persistence.settleError = new Error("SQLite writer fence was lost");

    await expect(handler.execute(request())).rejects.toMatchObject({
      name: "CapabilityOutcomeUnknownError",
      commandId: "command-1",
      cause: persistence.settleError,
    });
    expect(persistence.calls).toEqual(["authorize", "begin", "settle:succeeded", "unknown"]);
    expect(effect.execute).toHaveBeenCalledOnce();
    expect(persistence.current).toMatchObject({ status: "outcome_unknown" });
    expect(new CapabilityOutcomeUnknownError("command-x", new Error("cause"))).toBeInstanceOf(Error);
  });

  it("still throws outcome unknown when the best-effort unknown marker also fails", async () => {
    const { persistence, effect, handler } = fixture();
    persistence.settleError = new Error("settlement failed");
    persistence.unknownError = new Error("unknown marker failed");

    await expect(handler.execute(request())).rejects.toBeInstanceOf(CapabilityOutcomeUnknownError);
    expect(persistence.calls).toEqual(["authorize", "begin", "settle:succeeded", "unknown"]);
    expect(effect.execute).toHaveBeenCalledOnce();
  });

  it("fails closed when an adapter claims grant authorization", async () => {
    const { persistence, effect, handler } = fixture();
    persistence.current = state("authorized", {
      authorization: { kind: "grant", grantId: "grant-1" },
    });

    await expect(handler.execute(request())).rejects.toBeInstanceOf(CapabilityGrantUnsupportedError);
    expect(persistence.calls).toEqual(["authorize"]);
    expect(effect.execute).not.toHaveBeenCalled();
  });

  it("does not expose caller-controlled persistence identity or digest fields", async () => {
    const { handler } = fixture();
    const forbidden = {
      ...request(),
      runId: "forged-run",
      attempt: 999,
      operationType: "forged",
      operationDigest: "forged",
      operationId: "forged",
      receiptId: "forged",
    };

    await expect(handler.execute(forbidden as never)).rejects.toThrow("exactly");
  });

  it("rejects a zero Attempt version before persistence or effect execution", async () => {
    const { persistence, effect, handler } = fixture();
    const stale = request();

    await expect(handler.execute({
      ...stale,
      fence: { ...stale.fence, expectedVersion: 0 },
    })).rejects.toThrow("expectedVersion must be a positive safe integer");
    expect(persistence.calls).toEqual([]);
    expect(effect.execute).not.toHaveBeenCalled();
  });
});
