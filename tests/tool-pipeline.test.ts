import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { Type } from "typebox";
import { ToolExecutionPipeline, ToolRegistry, type ToolProvider } from "@tagent/execution/composition";
import type { RuntimeTool, SubprocessSpawnSpec, ToolCapabilityApplicationPort } from "@tagent/execution/ports";

const testSignal = new AbortController().signal;

function tool(name: string, execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} })), mutation = false): RuntimeTool {
  return {
    name, label: name, description: name, parameters: Type.Object({ value: Type.Optional(Type.String()) }),
    executionMode: mutation ? "sequential" : "parallel",
    policy: { operationType: `tool.${name}`, workspaceAccess: mutation ? "mutation" : "read_only", externalAction: mutation },
    execute,
  };
}

function provider(id: string, ...tools: RuntimeTool[]): ToolProvider {
  return { id, provideTools: () => tools };
}

function capabilities(overrides: Partial<ToolCapabilityApplicationPort> = {}) {
  const complete = vi.fn();
  const update = vi.fn();
  const port = {
    runId: "run-1",
    getRun: () => ({ attempt: 1 }),
    getRunExecutionState: () => ({ attempt: 1 }),
    isCurrentAttempt: vi.fn(() => true),
    authorizeWorkspaceMutation: vi.fn(() => ({ allowed: true, reason: "allowed" })),
    authorizeExternalAction: vi.fn(() => ({ allowed: true, reason: "allowed" })),
    advanceRunPhase: vi.fn(() => true),
    recordToolAttempt: vi.fn(() => ({ created: true, status: "running", guard: { blocked: false, reason: "" } })),
    completeToolAttempt: complete,
    consumeAtomicallySettledToolCall: vi.fn(() => false),
    claimOperation: vi.fn(() => ({ claimed: true, status: "running" })),
    updateOperation: update,
    markChecksStale: vi.fn(() => 2),
    ...overrides,
  } as unknown as ToolCapabilityApplicationPort;
  return { port, complete, update };
}

describe("ToolRegistry and ToolExecutionPipeline", () => {
  it("requires caller-owned cancellation at typed execution seams", () => {
    expectTypeOf<Parameters<RuntimeTool["execute"]>[2]>().toEqualTypeOf<AbortSignal>();
    expectTypeOf<SubprocessSpawnSpec>().toMatchTypeOf<{ signal: AbortSignal }>();
  });

  it("classifies a pre-aborted call without recording or dispatching it", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "unsafe" }], details: {} }));
    const record = vi.fn(() => ({ created: true, status: "running" as const, guard: { blocked: false, reason: "" } }));
    const { port } = capabilities({ recordToolAttempt: record });
    const wrapped = new ToolExecutionPipeline(port).bindCatalog({ tools: [tool("read", execute)] }).tools[0];
    const controller = new AbortController();
    controller.abort(new Error("cancelled before dispatch"));
    await expect(wrapped.execute("pre-aborted", {}, controller.signal)).rejects.toMatchObject({
      name: "ToolExecutionError",
      code: "ABORTED_BEFORE_DISPATCH",
      message: "cancelled before dispatch",
    });
    expect(record).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("joins a started body and classifies cancellation after dispatch", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const cleanup = new Promise<void>((resolve) => { release = resolve; });
    const execute = vi.fn(async () => {
      entered();
      await cleanup;
      return { content: [{ type: "text" as const, text: "late success" }], details: {} };
    });
    const { port, complete, update } = capabilities();
    const wrapped = new ToolExecutionPipeline(port).bindCatalog({ tools: [tool("write", execute, true)] }).tools[0];
    const controller = new AbortController();
    let settled = false;
    const pending = wrapped.execute("started-abort", {}, controller.signal).finally(() => { settled = true; });
    await started;
    controller.abort(new Error("cancelled after dispatch"));
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await expect(pending).rejects.toMatchObject({ code: "ABORTED", message: "cancelled after dispatch" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith("started-abort", false, expect.stringContaining('"code":"ABORTED"'));
    expect(update).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      status: "failed",
      effects: expect.arrayContaining([expect.objectContaining({
        kind: "error",
        error: expect.objectContaining({ code: "ABORTED" }),
      })]),
    }));
  });

  it("fails duplicate registration atomically and supports provider disposal", () => {
    const registry = new ToolRegistry();
    const dispose = registry.register(provider("first", tool("read")));
    expect(() => registry.register(provider("duplicate", tool("write"), tool("read")))).toThrow("Duplicate tool read");
    expect(registry.snapshot().tools.map((item) => item.name)).toEqual(["read"]);
    dispose();
    expect(registry.snapshot().tools).toEqual([]);
    expect(() => registry.register(provider("self-duplicate", tool("same"), tool("same")))).toThrow("contributed duplicate tool same");
    registry.register(provider("same-provider", tool("one")));
    expect(() => registry.register(provider("same-provider", tool("two")))).toThrow("already registered");
  });

  it("returns an immutable Attempt catalog snapshot", () => {
    const registry = new ToolRegistry();
    registry.register(provider("first", tool("read")));
    const snapshot = registry.snapshot();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tools)).toBe(true);
    expect(Object.isFrozen(snapshot.tools[0])).toBe(true);
    expect(Object.isFrozen(snapshot.tools[0].parameters)).toBe(true);
    expect(Object.isFrozen(snapshot.tools[0].policy)).toBe(true);
    registry.register(provider("second", tool("write")));
    expect(snapshot.tools.map((item) => item.name)).toEqual(["read"]);
    expect(registry.snapshot().tools.map((item) => item.name)).toEqual(["read", "write"]);
  });

  it("binds exactly one catalog and rejects tool-call identity reuse", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }));
    const { port } = capabilities();
    const pipeline = new ToolExecutionPipeline(port);
    const wrapped = pipeline.bindCatalog({ tools: [tool("read", execute)] }).tools[0];
    expect(() => pipeline.bindCatalog({ tools: [] })).toThrow("already bound");
    expect(pipeline.beforeToolCall("stable", "read", { value: "one" })).toEqual({ blocked: false });
    await expect(wrapped.execute("stable", { value: "two" }, testSignal)).rejects.toThrow("reused with different payload");
    expect(execute).not.toHaveBeenCalled();
  });

  it("records read observations after execution", async () => {
    const order: string[] = [];
    let durableResult: unknown;
    let claimed = true;
    const execute = vi.fn(async () => {
      order.push("execute");
      return { content: [{ type: "text" as const, text: "observed" }], details: {} };
    });
    const { port } = capabilities({
      claimOperation: vi.fn(() => {
        order.push("claim");
        return claimed ? { claimed: true, status: "running" } : { claimed: false, status: "succeeded", result: durableResult };
      }),
      updateOperation: vi.fn((_id, update) => { durableResult = update.result; return update; }),
    });
    const firstPipeline = new ToolExecutionPipeline(port);
    const first = firstPipeline.bindCatalog({ tools: [tool("read", execute)] }).tools[0];
    await first.execute("read-once", {}, testSignal);
    expect(order).toEqual(["execute", "claim"]);
    expect(durableResult).toBeDefined();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("orders stale-attempt, external-approval, workspace, and durable attempt guards before execution", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "unsafe" }], details: {} }));
    const external = vi.fn(() => ({ allowed: true, reason: "approved" }));
    const workspace = vi.fn(() => ({ allowed: true, reason: "goal" }));
    const record = vi.fn(() => ({ created: true, status: "running" as const, guard: { blocked: false, reason: "" } }));
    const { port } = capabilities({ isCurrentAttempt: () => false, authorizeExternalAction: external, authorizeWorkspaceMutation: workspace, recordToolAttempt: record });
    const pipeline = new ToolExecutionPipeline(port);
    const wrapped = pipeline.bindCatalog({ tools: [tool("write", execute, true)] }).tools[0];
    await expect(wrapped.execute("call-1", {}, testSignal)).rejects.toThrow("no longer current");
    expect(external).not.toHaveBeenCalled();
    expect(workspace).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();

    const deniedApproval = vi.fn(() => ({ allowed: false, reason: "missing" }));
    const second = capabilities({ authorizeExternalAction: deniedApproval, authorizeWorkspaceMutation: workspace, recordToolAttempt: record });
    const denied = new ToolExecutionPipeline(second.port).bindCatalog({ tools: [tool("write", execute, true)] }).tools[0];
    await expect(denied.execute("call-2", {}, testSignal)).rejects.toThrow("External action approval guard");
    expect(workspace).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("requests and blocks on explicit approval for maintenance outside external-action TaskRuns", () => {
    const approval = vi.fn(() => ({ allowed: false, reason: "missing" }));
    const request = vi.fn(() => ({ approvalId: "approval-1", reason: "Approval requested for the next Attempt" }));
    const { port } = capabilities({ authorizeExternalAction: approval, requestExternalActionApproval: request });
    const maintenance = tool("maintenance", undefined, true);
    maintenance.policy = { ...maintenance.policy!, externalAction: "explicit" };
    const pipeline = new ToolExecutionPipeline(port);
    pipeline.bindCatalog({ tools: [maintenance] });

    expect(pipeline.beforeToolCall("maintenance-1", "maintenance", {})).toEqual({
      blocked: true,
      reason: expect.stringContaining("Approval requested for the next Attempt"),
    });
    expect(approval).toHaveBeenCalledWith(true);
    expect(request).toHaveBeenCalledWith("maintenance-1", "maintenance");
    expect(pipeline.beforeToolCall("maintenance-1", "maintenance", {})).toMatchObject({ blocked: true });
    expect(request).toHaveBeenCalledOnce();
  });

  it("settles a successful mutation once and replays its receipt without repeating the provider", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "changed" }], details: { bytes: 1 } }));
    let durableResult: unknown;
    let claimed = true;
    const { port, complete, update } = capabilities({
      claimOperation: vi.fn(() => claimed
        ? { claimed: true, status: "running" }
        : { claimed: false, status: "succeeded", result: durableResult }),
      updateOperation: vi.fn((_id, updateValue) => { durableResult = updateValue.result; update(updateValue); return updateValue; }),
    });
    const pipeline = new ToolExecutionPipeline(port);
    const wrapped = pipeline.bindCatalog({ tools: [tool("write", execute, true)] }).tools[0];
    const first = await wrapped.execute("stable-call", { value: "one" }, testSignal);
    pipeline.afterToolCall("stable-call", true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(1);
    expect(first.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("trusted operation receipt") });

    claimed = false;
    const replayPipeline = new ToolExecutionPipeline(port);
    const replay = replayPipeline.bindCatalog({ tools: [tool("write", execute, true)] }).tools[0];
    expect(await replay.execute("stable-call", { value: "one" }, testSignal)).toEqual(first);
    replayPipeline.afterToolCall("stable-call", true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("dispatches post-receipt work only after a new success is durable", async () => {
    const order: string[] = [];
    let durableResult: unknown;
    let claimed = true;
    const operationTool = tool("maintenance", vi.fn(async () => {
      order.push("execute");
      return { content: [{ type: "text" as const, text: "accepted" }], details: {} };
    }), true);
    operationTool.onOperationSettled = vi.fn(() => { order.push("dispatch"); });
    const { port } = capabilities({
      claimOperation: vi.fn(() => claimed
        ? { claimed: true, status: "running" }
        : { claimed: false, status: "succeeded", result: durableResult }),
      updateOperation: vi.fn((_id, update) => {
        order.push(`persist:${update.status}`);
        durableResult = update.result;
        return update;
      }),
    });

    await new ToolExecutionPipeline(port).bindCatalog({ tools: [operationTool] }).tools[0]
      .execute("activate", {}, testSignal);
    expect(order).toEqual(["execute", "persist:succeeded", "dispatch"]);
    expect(operationTool.onOperationSettled).toHaveBeenCalledOnce();

    claimed = false;
    await new ToolExecutionPipeline(port).bindCatalog({ tools: [operationTool] }).tools[0]
      .execute("activate", {}, testSignal);
    expect(operationTool.onOperationSettled).toHaveBeenCalledOnce();
  });

  it("never dispatches post-receipt work when success settlement fails", async () => {
    const operationTool = tool("maintenance", undefined, true);
    operationTool.onOperationSettled = vi.fn();
    let updates = 0;
    const { port } = capabilities({
      updateOperation: vi.fn((_id, update) => {
        updates += 1;
        if (updates === 1) throw new Error("writer fence lost before receipt settlement");
        return update;
      }),
    });

    await expect(new ToolExecutionPipeline(port).bindCatalog({ tools: [operationTool] }).tools[0]
      .execute("activate", {}, testSignal)).rejects.toThrow("writer fence lost before receipt settlement");
    expect(operationTool.onOperationSettled).not.toHaveBeenCalled();
  });

  it("keeps a durable success authoritative when its post-settlement hook throws", async () => {
    const operationTool = tool("maintenance", undefined, true);
    operationTool.onOperationSettled = vi.fn(() => { throw new Error("notification failed"); });
    const { port, update } = capabilities();

    await expect(new ToolExecutionPipeline(port).bindCatalog({ tools: [operationTool] }).tools[0]
      .execute("activate", {}, testSignal)).resolves.toMatchObject({
        content: [{ type: "text" }],
      });

    expect(operationTool.onOperationSettled).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: "succeeded" }));
  });

  it("records a failed receipt and never lets the provider settle the tool attempt directly", async () => {
    const execute = vi.fn(async () => { throw new Error("provider failed"); });
    const { port, complete, update } = capabilities();
    const wrapped = new ToolExecutionPipeline(port).bindCatalog({ tools: [tool("write", execute, true)] }).tools[0];
    await expect(wrapped.execute("failed-call", {}, testSignal)).rejects.toThrow("provider failed");
    expect(update).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ status: "failed", stage: "execution_failed" }));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("replays a completed mutation receipt without re-executing or re-settling the tool attempt", async () => {
    const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "unsafe replay" }], details: {} }));
    const receipt = { content: [{ type: "text" as const, text: "prior result" }], details: { operationId: "prior" } };
    const { port, complete } = capabilities({
      recordToolAttempt: vi.fn(() => ({ created: false, status: "succeeded" as const, guard: { blocked: false, reason: "" } })),
      claimOperation: vi.fn(() => ({ claimed: false, status: "succeeded", result: receipt })),
    });
    const wrapped = new ToolExecutionPipeline(port).bindCatalog({ tools: [tool("write", execute, true)] }).tools[0];
    await expect(wrapped.execute("completed-call", {}, testSignal)).resolves.toEqual(receipt);
    expect(execute).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});
