import { EventEmitter } from "node:events";
import type { ChildProcess, ForkOptions } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CORE_HOST_PROTOCOL_VERSION,
  CORE_STATE_PROTOCOL,
  CoreHost,
  parseGenerationToHostMessage,
  type CoreHostActivationRequest,
  type CoreHostTimers,
  type HostToGenerationMessage,
} from "@tagent/core-service/host";
import {
  GenerationHostBridge,
  ManagedGenerationAdapter,
  parseHostToGenerationMessage,
} from "@tagent/core-service/composition";
import type { GenerationActivationRequest, GenerationMaintenanceRepository } from "@tagent/execution/ports";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface ChildPlan {
  ready?: boolean;
  spawnError?: boolean;
  drain?: "exit" | "ignore" | "throw";
  writerFence?: number;
  onReady?: () => void;
  onKill?: () => void;
  heartbeat?: boolean;
  crashAfterReadyMs?: number;
  drainDelayMs?: number;
}

class FakeChild extends EventEmitter {
  connected = true;
  readonly sent: HostToGenerationMessage[] = [];
  readonly generationId: string;
  readonly releaseId: string;
  readonly activationRequestId?: string;
  readonly kills: NodeJS.Signals[] = [];
  private exited = false;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(
    readonly plan: ChildPlan,
    environment: NodeJS.ProcessEnv,
    readonly cwd: string,
    readonly writerFence: number,
  ) {
    super();
    this.generationId = environment.TAGENT_GENERATION_ID!;
    this.releaseId = environment.TAGENT_RELEASE_ID!;
    this.activationRequestId = environment.TAGENT_ACTIVATION_REQUEST_ID;
    queueMicrotask(() => {
      if (plan.spawnError) {
        this.connected = false;
        this.emit("error", new Error("spawn failed"));
        this.emit("close", null, null);
        return;
      }
      if (plan.ready === false) {
        this.exit(1, null);
        return;
      }
      plan.onReady?.();
      this.deliver({
        type: "READY",
        protocolVersion: CORE_HOST_PROTOCOL_VERSION,
        generationId: this.generationId,
        releaseId: this.releaseId,
        stateProtocol: CORE_STATE_PROTOCOL,
        writerFence: this.writerFence,
      });
      if (plan.heartbeat) {
        let sequence = 0;
        this.heartbeatTimer = setInterval(() => {
          sequence += 1;
          this.deliver({
            type: "HEARTBEAT",
            protocolVersion: CORE_HOST_PROTOCOL_VERSION,
            generationId: this.generationId,
            releaseId: this.releaseId,
            writerFence: this.writerFence,
            sequence,
          });
        }, 5);
        this.heartbeatTimer.unref?.();
      }
      if (plan.crashAfterReadyMs !== undefined) {
        const crash = setTimeout(() => this.exit(1, null), plan.crashAfterReadyMs);
        crash.unref?.();
      }
    });
  }

  send(message: HostToGenerationMessage): boolean {
    if (message.type === "DRAIN" && this.plan.drain === "throw") throw new Error("IPC send failed");
    this.sent.push(message);
    if (message.type === "DRAIN" && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (message.type === "DRAIN" && this.plan.drain === "exit") {
      queueMicrotask(() => this.exit(1, null));
      return true;
    }
    if (message.type === "DRAIN" && this.plan.drain !== "ignore") {
      const drain = () => {
        this.deliver({
          type: "DRAINED",
          protocolVersion: CORE_HOST_PROTOCOL_VERSION,
          generationId: this.generationId,
          requestId: message.requestId,
          writerFence: this.writerFence,
        });
        this.exit(0, null);
      };
      if (this.plan.drainDelayMs === undefined) queueMicrotask(drain);
      else setTimeout(drain, this.plan.drainDelayMs).unref?.();
    }
    return true;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    this.plan.onKill?.();
    this.exit(null, signal);
    return true;
  }

  deliver(message: unknown): void {
    if (!this.exited) this.emit("message", message);
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.exited) return;
    this.exited = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.connected = false;
    this.emit("exit", code, signal);
  }
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const expiresAt = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= expiresAt) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const oldRelease = "1".repeat(40);
const newRelease = "2".repeat(40);

async function releaseRoot(ids: string[] = [oldRelease, newRelease]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "tagent-core-host-"));
  roots.push(root);
  await mkdir(path.join(root, "releases"), { recursive: true });
  for (const id of ids) {
    const directory = path.join(root, "releases", id);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "RELEASE_MANIFEST.json"), JSON.stringify({
      schemaVersion: 2,
      artifact: "core",
      commit: id,
      core: {
        hostProtocolVersion: CORE_HOST_PROTOCOL_VERSION,
        stateProtocol: CORE_STATE_PROTOCOL,
        generationEntry: "node_modules/@tagent/core-service/dist/generation-entry.js",
      },
    }));
  }
  await symlink(`releases/${oldRelease}`, path.join(root, "current"));
  return root;
}

function hostFixture(root: string, plans: Map<string, ChildPlan[]>, overrides: Partial<ConstructorParameters<typeof CoreHost>[0]> = {}) {
  const children: FakeChild[] = [];
  let writerFence = 0;
  const spawn = ((entry: string, _args: readonly string[], options: ForkOptions) => {
    const releaseId = options.env?.TAGENT_RELEASE_ID ?? "development";
    const plan = plans.get(releaseId)?.shift() ?? {};
    const nextWriterFence = plan.writerFence ?? writerFence + 1;
    writerFence = Math.max(writerFence, nextWriterFence);
    const child = new FakeChild(
      plan,
      options.env ?? {},
      String(options.cwd),
      nextWriterFence,
    );
    children.push(child);
    return child as unknown as ChildProcess;
  }) as typeof import("node:child_process").fork;
  const fatal = vi.fn();
  const host = new CoreHost({
    releaseRoot: root,
    directReleaseDirectory: root,
    runtimeDirectory: path.join(root, "runtime"),
    readyTimeoutMs: 200,
    drainTimeoutMs: 200,
    forceKillGraceMs: 100,
    heartbeatTimeoutMs: 60_000,
    candidateStabilizationMs: 0,
    spawn,
    verifyRelease: async () => undefined,
    fatal,
    logger: { info: vi.fn(), error: vi.fn() },
    ...overrides,
  });
  return { host, children, fatal };
}

function activation(generationId: string): CoreHostActivationRequest {
  return {
    type: "ACTIVATE",
    protocolVersion: CORE_HOST_PROTOCOL_VERSION,
    generationId,
    requestId: "run-1:1:activate-1",
    runId: "run-1",
    operationId: "run-1:1:activate-1",
    expectedCurrent: oldRelease,
    targetRelease: newRelease,
  };
}

describe("Core Host protocol", () => {
  it("rejects malformed, extended, oversized, and incompatible Generation messages", () => {
    const ready = {
      type: "READY",
      protocolVersion: CORE_HOST_PROTOCOL_VERSION,
      generationId: "generation-1",
      releaseId: oldRelease,
      stateProtocol: CORE_STATE_PROTOCOL,
      writerFence: 1,
    };
    expect(parseGenerationToHostMessage(ready)).toEqual(ready);
    expect(() => parseGenerationToHostMessage({ ...ready, extra: true })).toThrow("exactly");
    expect(() => parseGenerationToHostMessage({ ...ready, protocolVersion: 1 })).toThrow("unsupported");
    expect(() => parseGenerationToHostMessage({ ...ready, releaseId: "x".repeat(33_000) })).toThrow("too large");
    expect(parseGenerationToHostMessage({
      type: "HEARTBEAT",
      protocolVersion: CORE_HOST_PROTOCOL_VERSION,
      generationId: "generation-1",
      releaseId: oldRelease,
      writerFence: 1,
      sequence: 1,
    })).toMatchObject({ type: "HEARTBEAT", sequence: 1 });

    const result = {
      type: "ACTIVATION_RESULT",
      protocolVersion: CORE_HOST_PROTOCOL_VERSION,
      requestId: "request-1",
      status: "succeeded",
      activeRelease: oldRelease,
    } as const;
    expect(parseHostToGenerationMessage(result)).toEqual(result);
    expect(() => parseHostToGenerationMessage({ ...result, status: "unknown" })).toThrow("status is invalid");
    const status = {
      type: "HOST_STATUS",
      protocolVersion: CORE_HOST_PROTOCOL_VERSION,
      generationId: "generation-1",
      activeRelease: oldRelease,
      activationPhase: "committed",
      activationRequestId: "request-1",
      recentCrashes: 1,
      maxCrashes: 5,
    } as const;
    expect(parseHostToGenerationMessage(status)).toEqual(status);
    expect(() => parseHostToGenerationMessage({ ...status, activationPhase: "unknown" })).toThrow("unsupported");
    expect(() => parseHostToGenerationMessage({ ...status, activationRequestId: null })).toThrow("must be a string");
  });

  it("treats IPC backpressure as an accepted send and rejects stale drains", async () => {
    const listeners: Array<(message: unknown) => void> = [];
    const sent: unknown[] = [];
    let flushed: ((error: Error | null) => void) | undefined;
    let disconnected = false;
    const bridge = new GenerationHostBridge({
      environment: {
        TAGENT_HOST_MANAGED: "1",
        TAGENT_GENERATION_ID: "generation-1",
        TAGENT_RELEASE_ID: oldRelease,
        TAGENT_STATE_PROTOCOL: CORE_STATE_PROTOCOL,
      },
      send: (message, callback) => { sent.push(message); flushed = callback; return false; },
      subscribeMessage: (listener) => listeners.push(listener),
      subscribeDisconnect: () => undefined,
      disconnect: () => { disconnected = true; },
      logger: { error: vi.fn() },
    });
    const drains: string[] = [];
    bridge.onDrain(({ requestId }) => { drains.push(requestId); });
    expect(() => bridge.ready(3)).not.toThrow();
    listeners[0]({
      type: "DRAIN",
      protocolVersion: CORE_HOST_PROTOCOL_VERSION,
      generationId: "stale",
      requestId: "ignored",
      deadlineMs: 100,
    });
    listeners[0]({
      type: "DRAIN",
      protocolVersion: CORE_HOST_PROTOCOL_VERSION,
      generationId: "generation-1",
      requestId: "accepted",
      deadlineMs: 100,
    });
    listeners[0]({
      type: "HOST_STATUS",
      protocolVersion: CORE_HOST_PROTOCOL_VERSION,
      generationId: "generation-1",
      activeRelease: oldRelease,
      activationPhase: "",
      activationRequestId: "",
      recentCrashes: 1,
      maxCrashes: 5,
    });
    await Promise.resolve();
    expect(drains).toEqual(["accepted"]);
    expect(bridge.hostStatus()).toMatchObject({ activeRelease: oldRelease, recentCrashes: 1, maxCrashes: 5 });
    expect(sent).toHaveLength(1);
    const drained = bridge.drained("accepted", 3);
    expect(disconnected).toBe(false);
    flushed?.(null);
    await drained;
    expect(disconnected).toBe(true);
  });

  it("sends only the closed activation IPC shape from a durable request", () => {
    const sent: unknown[] = [];
    const bridge = new GenerationHostBridge({
      environment: {
        TAGENT_HOST_MANAGED: "1",
        TAGENT_RELEASE_MANAGED: "1",
        TAGENT_GENERATION_ID: "generation-1",
        TAGENT_RELEASE_ID: oldRelease,
        TAGENT_STATE_PROTOCOL: CORE_STATE_PROTOCOL,
      },
      send: (message) => { sent.push(message); return true; },
      subscribeMessage: () => undefined,
      subscribeDisconnect: () => undefined,
    });
    const request: GenerationActivationRequest = {
      requestId: "run-1:1:activate-1",
      operationId: "run-1:1:activate-1",
      runId: "run-1",
      expectedCurrent: oldRelease,
      targetRelease: newRelease,
      reason: "Persisted locally, not sent to the Host",
    };

    bridge.activate(request);

    expect(sent).toEqual([{
      type: "ACTIVATE",
      protocolVersion: CORE_HOST_PROTOCOL_VERSION,
      generationId: "generation-1",
      requestId: request.requestId,
      runId: request.runId,
      operationId: request.operationId,
      expectedCurrent: request.expectedCurrent,
      targetRelease: request.targetRelease,
    }]);
    expect(parseGenerationToHostMessage(sent[0])).toEqual(sent[0]);
  });

  it("latches parent IPC loss before Generation readiness and closes without announcing READY", async () => {
    let disconnectParent!: () => void;
    const sent: unknown[] = [];
    const bridge = new GenerationHostBridge({
      environment: {
        TAGENT_HOST_MANAGED: "1",
        TAGENT_GENERATION_ID: "generation-1",
        TAGENT_RELEASE_ID: oldRelease,
        TAGENT_STATE_PROTOCOL: CORE_STATE_PROTOCOL,
      },
      send: (message) => { sent.push(message); return true; },
      subscribeMessage: () => undefined,
      subscribeDisconnect: (listener) => { disconnectParent = listener; },
    });
    disconnectParent();
    const persistence: GenerationMaintenanceRepository = {
      listPendingGenerationActivations: () => [],
      prepareGenerationHandoff: () => { throw new Error("not expected"); },
      recordGenerationActivationResult: () => undefined,
    };
    const terminate = vi.fn();
    const closeGeneration = vi.fn(async () => undefined);
    const adapter = new ManagedGenerationAdapter({
      persistence,
      bridge,
      terminate,
      parentDisconnectGraceMs: 100,
      logger: { error: vi.fn() },
    });

    adapter.announceReady(closeGeneration, 1);
    await waitFor(() => terminate.mock.calls.length === 1, "orphaned Generation did not terminate");

    expect(closeGeneration).toHaveBeenCalledOnce();
    expect(sent).not.toContainEqual(expect.objectContaining({ type: "READY" }));
  });

  it("defers startup recovery for a durable pending activation even before Host state exists", () => {
    const request: GenerationActivationRequest = {
      requestId: "run-1:1:activate-1",
      operationId: "run-1:1:activate-1",
      runId: "run-1",
      expectedCurrent: oldRelease,
      targetRelease: newRelease,
      reason: "durable activation",
    };
    const bridge = new GenerationHostBridge({ environment: {} });
    const adapter = new ManagedGenerationAdapter({
      persistence: {
        listPendingGenerationActivations: () => [request],
        prepareGenerationHandoff: () => ({ continuationId: "continuation-1", created: true }),
        recordGenerationActivationResult: () => undefined,
      },
      bridge,
    });

    expect(adapter.defersInitialRecovery).toBe(true);
  });

  it("releases deferred recovery when a replayed Host result already has no local pending row", () => {
    const bridge = new GenerationHostBridge({
      environment: {
        TAGENT_HOST_MANAGED: "1",
        TAGENT_RELEASE_MANAGED: "1",
        TAGENT_GENERATION_ID: "generation-1",
        TAGENT_RELEASE_ID: newRelease,
        TAGENT_ACTIVATION_REQUEST_ID: "run-1:1:activate-1",
        TAGENT_STATE_PROTOCOL: CORE_STATE_PROTOCOL,
      },
      send: () => true,
      subscribeMessage: () => undefined,
      subscribeDisconnect: () => undefined,
    });
    const adapter = new ManagedGenerationAdapter({
      persistence: {
        listPendingGenerationActivations: () => [],
        prepareGenerationHandoff: () => { throw new Error("not expected"); },
        recordGenerationActivationResult: () => undefined,
      },
      bridge,
    });
    const recover = vi.fn();
    adapter.bindRecovery(recover);

    adapter.coordinator.activationResult({
      requestId: "run-1:1:activate-1",
      status: "succeeded",
      activeRelease: newRelease,
    });

    expect(recover).toHaveBeenCalledOnce();
  });

  it("serializes the next durable activation behind the candidate activation result", async () => {
    const first: GenerationActivationRequest = {
      requestId: "run-1:1:activate-1",
      operationId: "run-1:1:activate-1",
      runId: "run-1",
      expectedCurrent: oldRelease,
      targetRelease: newRelease,
      reason: "first activation",
    };
    const second: GenerationActivationRequest = {
      requestId: "run-2:1:activate-2",
      operationId: "run-2:1:activate-2",
      runId: "run-2",
      expectedCurrent: newRelease,
      targetRelease: "current",
      reason: "second activation",
    };
    const sent: unknown[] = [];
    const bridge = new GenerationHostBridge({
      environment: {
        TAGENT_HOST_MANAGED: "1",
        TAGENT_RELEASE_MANAGED: "1",
        TAGENT_GENERATION_ID: "generation-2",
        TAGENT_RELEASE_ID: newRelease,
        TAGENT_ACTIVATION_REQUEST_ID: first.requestId,
        TAGENT_STATE_PROTOCOL: CORE_STATE_PROTOCOL,
      },
      send: (message) => { sent.push(message); return true; },
      subscribeMessage: () => undefined,
      subscribeDisconnect: () => undefined,
    });
    const adapter = new ManagedGenerationAdapter({
      persistence: {
        listPendingGenerationActivations: () => [first, second],
        prepareGenerationHandoff: () => ({ continuationId: "continuation-1", created: false }),
        recordGenerationActivationResult: () => ({ runId: first.runId, recorded: true }),
      },
      bridge,
    });

    adapter.coordinator.redispatchPending();
    expect(sent).toEqual([]);

    adapter.coordinator.activationResult({
      requestId: first.requestId,
      status: "succeeded",
      activeRelease: newRelease,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(sent).toEqual([expect.objectContaining({
      type: "ACTIVATE",
      requestId: second.requestId,
    })]);
  });

  it("fails the Generation closed when an activation result cannot be persisted", async () => {
    let receive!: (message: unknown) => void;
    const bridge = new GenerationHostBridge({
      environment: {
        TAGENT_HOST_MANAGED: "1",
        TAGENT_RELEASE_MANAGED: "1",
        TAGENT_GENERATION_ID: "generation-1",
        TAGENT_RELEASE_ID: oldRelease,
        TAGENT_STATE_PROTOCOL: CORE_STATE_PROTOCOL,
      },
      send: () => true,
      subscribeMessage: (listener) => { receive = listener; },
      subscribeDisconnect: () => undefined,
    });
    const closeGeneration = vi.fn(async () => undefined);
    const terminate = vi.fn();
    const adapter = new ManagedGenerationAdapter({
      persistence: {
        listPendingGenerationActivations: () => [],
        prepareGenerationHandoff: () => { throw new Error("not expected"); },
        recordGenerationActivationResult: () => { throw new Error("writer fence lost"); },
      },
      bridge,
      terminate,
      parentDisconnectGraceMs: 100,
      logger: { error: vi.fn() },
    });
    adapter.announceReady(closeGeneration, 1);

    receive({
      type: "ACTIVATION_RESULT",
      protocolVersion: CORE_HOST_PROTOCOL_VERSION,
      requestId: "request-1",
      status: "failed",
      activeRelease: oldRelease,
      error: "activation failed",
    });
    await waitFor(() => terminate.mock.calls.length === 1, "Generation did not fail closed");

    expect(closeGeneration).toHaveBeenCalledOnce();
  });
});

describe("Core Host generation lifecycle", () => {
  it("records an initial pre-READY failure without starting a parallel in-process restart loop", async () => {
    const root = await releaseRoot([oldRelease]);
    const { host, children } = hostFixture(root, new Map([
      [oldRelease, [{ ready: false }, {}]],
    ]));

    await expect(host.start()).rejects.toThrow("exited before READY");
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(children).toHaveLength(1);
    expect(host.snapshot().state.crashTimestamps).toHaveLength(1);
  });

  it("persists the pre-READY crash budget across Host process restarts", async () => {
    const root = await releaseRoot([oldRelease]);
    const first = hostFixture(root, new Map([[oldRelease, [{ ready: false }]]]), { maxCrashes: 1 });
    await expect(first.host.start()).rejects.toThrow("exited before READY");
    const second = hostFixture(root, new Map([[oldRelease, [{ ready: false }]]]), { maxCrashes: 1 });
    await expect(second.host.start()).rejects.toThrow("exited before READY");
    const third = hostFixture(root, new Map([[oldRelease, [{}]]]), { maxCrashes: 1 });

    await expect(third.host.start()).rejects.toThrow("exceeded 1 crashes");
    expect(third.children).toHaveLength(0);
  });

  it("does not charge release verification failures to the Generation crash budget", async () => {
    const root = await releaseRoot([oldRelease]);
    const { host, children } = hostFixture(root, new Map([[oldRelease, [{}]]]), {
      verifyRelease: async () => { throw new Error("release signature is invalid"); },
    });

    await expect(host.start()).rejects.toThrow("release signature is invalid");

    expect(children).toHaveLength(0);
    expect(host.snapshot().state.crashTimestamps).toEqual([]);
  });

  it("settles Host startup when the Generation cannot be spawned", async () => {
    const root = await releaseRoot([oldRelease]);
    const { host, children } = hostFixture(root, new Map([
      [oldRelease, [{ spawnError: true }]],
    ]));

    await expect(host.start()).rejects.toThrow("spawn failed");

    expect(children).toHaveLength(1);
    expect(host.snapshot().activeRelease).toBeNull();
  });

  it("terminates and restarts a Generation that stops sending Host heartbeats", async () => {
    const root = await releaseRoot([oldRelease]);
    const { host, children } = hostFixture(root, new Map([
      [oldRelease, [{}, { heartbeat: true }]],
    ]), { heartbeatTimeoutMs: 10 });

    await host.start();
    await waitFor(() => children.length === 2, "unresponsive Generation was not restarted");

    expect(children[0].kills).toContain("SIGKILL");
    expect(host.snapshot().state.crashTimestamps).toHaveLength(1);
    await host.close();
  });

  it("rolls back when a candidate crashes after READY during stabilization", async () => {
    const root = await releaseRoot();
    const { host, children } = hostFixture(root, new Map([
      [oldRelease, [{ heartbeat: true }, { heartbeat: true }]],
      [newRelease, [{ heartbeat: true, crashAfterReadyMs: 5 }]],
    ]), { candidateStabilizationMs: 30, heartbeatTimeoutMs: 100 });
    await host.start();
    children[0].deliver(activation(children[0].generationId));

    await waitFor(
      () => host.snapshot().state.activation?.phase === "rolled_back" && !host.snapshot().activationBusy,
      "early candidate crash did not roll back",
    );

    expect(await readlink(path.join(root, "current"))).toBe(`releases/${oldRelease}`);
    expect(host.snapshot().activeRelease).toBe(oldRelease);
    await host.close();
  });

  it("keeps current on the previous release until candidate stabilization completes", async () => {
    const root = await releaseRoot();
    const { host, children } = hostFixture(root, new Map([
      [oldRelease, [{ heartbeat: true }]],
      [newRelease, [{ heartbeat: true }]],
    ]), { candidateStabilizationMs: 30, heartbeatTimeoutMs: 100 });
    await host.start();
    children[0].deliver(activation(children[0].generationId));
    await waitFor(() => host.snapshot().state.activation?.phase === "starting", "candidate did not enter stabilization");

    expect(await readlink(path.join(root, "current"))).toBe(`releases/${oldRelease}`);
    await waitFor(
      () => host.snapshot().state.activation?.phase === "committed" && !host.snapshot().activationBusy,
      "stable candidate did not commit",
    );
    expect(await readlink(path.join(root, "current"))).toBe(`releases/${newRelease}`);
    await host.close();
  });

  it("drains the old Generation, commits only after candidate readiness, and exactly replays the result", async () => {
    const root = await releaseRoot();
    const { host, children } = hostFixture(root, new Map([
      [oldRelease, [{}]],
      [newRelease, [{}]],
    ]));
    await host.start();
    const first = children[0];
    const request = activation(first.generationId);
    first.deliver(request);

    await waitFor(() => host.snapshot().state.activation?.phase === "committed" && !host.snapshot().activationBusy, "activation did not commit");
    expect(host.snapshot()).toMatchObject({ activeRelease: newRelease, activationBusy: false });
    expect(await readlink(path.join(root, "current"))).toBe(`releases/${newRelease}`);
    const candidate = children[1];
    expect(candidate.sent).toContainEqual(expect.objectContaining({
      type: "ACTIVATION_RESULT",
      requestId: request.requestId,
      status: "succeeded",
      activeRelease: newRelease,
    }));

    candidate.deliver({ ...request, generationId: candidate.generationId });
    await Promise.resolve();
    expect(candidate.sent.filter((message) => message.type === "ACTIVATION_RESULT")).toHaveLength(2);
    expect(children).toHaveLength(2);
    await host.close();
  });

  it("keeps current on the previous release and rolls back when the candidate fails readiness", async () => {
    const root = await releaseRoot();
    const { host, children, fatal } = hostFixture(root, new Map([
      [oldRelease, [{}, {}]],
      [newRelease, [{ ready: false }]],
    ]));
    await host.start();
    children[0].deliver(activation(children[0].generationId));

    await waitFor(() => host.snapshot().state.activation?.phase === "rolled_back" && !host.snapshot().activationBusy, "activation did not roll back");
    expect(await readlink(path.join(root, "current"))).toBe(`releases/${oldRelease}`);
    expect(host.snapshot().activeRelease).toBe(oldRelease);
    expect(children.at(-1)?.sent).toContainEqual(expect.objectContaining({
      type: "ACTIVATION_RESULT",
      status: "rolled_back",
      activeRelease: oldRelease,
    }));
    expect(fatal).not.toHaveBeenCalled();
    await host.close();
  });

  it("rejects a candidate that did not advance the database writer fence", async () => {
    const root = await releaseRoot();
    const { host, children, fatal } = hostFixture(root, new Map([
      [oldRelease, [{}, {}]],
      [newRelease, [{ writerFence: 1 }]],
    ]));
    await host.start();
    children[0].deliver(activation(children[0].generationId));

    await waitFor(() => host.snapshot().state.activation?.phase === "rolled_back" && !host.snapshot().activationBusy, "stale-fence candidate did not roll back");

    expect(children[1].kills).toContain("SIGKILL");
    expect(children.at(-1)?.writerFence).toBeGreaterThan(children[0].writerFence);
    expect(host.snapshot().activeRelease).toBe(oldRelease);
    expect(await readlink(path.join(root, "current"))).toBe(`releases/${oldRelease}`);
    expect(fatal).not.toHaveBeenCalled();
    await host.close();
  });

  it("does not restore a rollback Generation after Host close", async () => {
    const root = await releaseRoot();
    let oldReleaseVerifications = 0;
    let rollbackVerificationStarted!: () => void;
    let releaseRollbackVerification!: () => void;
    const rollbackStarted = new Promise<void>((resolve) => { rollbackVerificationStarted = resolve; });
    const rollbackVerification = new Promise<void>((resolve) => { releaseRollbackVerification = resolve; });
    const { host, children } = hostFixture(root, new Map([
      [oldRelease, [{}]],
      [newRelease, [{ ready: false }]],
    ]), {
      verifyRelease: async (release) => {
        if (release.id !== oldRelease) return;
        oldReleaseVerifications += 1;
        if (oldReleaseVerifications === 2) {
          rollbackVerificationStarted();
          await rollbackVerification;
        }
      },
    });
    await host.start();
    children[0].deliver(activation(children[0].generationId));
    await rollbackStarted;

    await host.close();
    releaseRollbackVerification();
    await waitFor(() => !host.snapshot().activationBusy, "activation did not stop after Host close");

    expect(children).toHaveLength(2);
    expect(host.snapshot().activeRelease).toBeNull();
  });

  it("keeps activation as the sole recovery owner when the source exits during verification", async () => {
    const root = await releaseRoot();
    let releaseVerification!: () => void;
    const waitingForVerification = new Promise<void>((resolve) => { releaseVerification = resolve; });
    const { host, children } = hostFixture(root, new Map([
      [oldRelease, [{}]],
      [newRelease, [{}]],
    ]), {
      verifyRelease: async (release) => {
        if (release.id === newRelease) await waitingForVerification;
      },
    });
    await host.start();
    children[0].deliver(activation(children[0].generationId));
    await waitFor(() => host.snapshot().state.activation?.phase === "validating", "activation did not enter validation");

    children[0].exit(1, null);
    releaseVerification();
    await waitFor(() => host.snapshot().state.activation?.phase === "committed" && !host.snapshot().activationBusy, "activation did not recover the source exit");

    expect(children).toHaveLength(2);
    expect(host.snapshot().state.crashTimestamps).toEqual([]);
    expect(host.snapshot().activeRelease).toBe(newRelease);
    await host.close();
  });

  it("stops the candidate and restores current when commit-state persistence fails", async () => {
    const root = await releaseRoot();
    const statePath = path.join(root, "runtime", "activation.json");
    const { host, children, fatal } = hostFixture(root, new Map([
      [oldRelease, [{}, {}]],
      [newRelease, [{
        onReady: () => {
          rmSync(statePath, { force: true });
          mkdirSync(statePath);
        },
        onKill: () => { rmSync(statePath, { recursive: true, force: true }); },
      }]],
    ]));
    await host.start();
    children[0].deliver(activation(children[0].generationId));

    await waitFor(() => host.snapshot().state.activation?.phase === "rolled_back" && !host.snapshot().activationBusy, "activation did not restore the previous release");
    expect(children[1].kills).toContain("SIGTERM");
    expect(await readlink(path.join(root, "current"))).toBe(`releases/${oldRelease}`);
    expect(host.snapshot().activeRelease).toBe(oldRelease);
    expect(fatal).not.toHaveBeenCalled();
    await host.close();
  });

  it("fails closed without publishing a terminal result when terminal Host state cannot be persisted", async () => {
    const root = await releaseRoot();
    const statePath = path.join(root, "runtime", "activation.json");
    const { host, children, fatal } = hostFixture(root, new Map([
      [oldRelease, [{}]],
    ]), {
      verifyRelease: async (release) => {
        if (release.id !== newRelease) return;
        rmSync(statePath, { force: true });
        mkdirSync(statePath);
        throw new Error("candidate verification failed");
      },
    });
    await host.start();
    children[0].deliver(activation(children[0].generationId));

    await waitFor(() => fatal.mock.calls.length === 1 && !host.snapshot().activationBusy, "Host did not fail closed");

    expect(children[0].kills).toContain("SIGTERM");
    expect(children[0].sent).not.toContainEqual(expect.objectContaining({ type: "ACTIVATION_RESULT" }));
    expect(host.snapshot().activeRelease).toBeNull();
    expect(await readlink(path.join(root, "current"))).toBe(`releases/${oldRelease}`);
  });

  it("forces a timed-out drain and still starts the verified candidate", async () => {
    const root = await releaseRoot();
    const { host, children } = hostFixture(root, new Map([
      [oldRelease, [{ drain: "ignore" }]],
      [newRelease, [{}]],
    ]), { drainTimeoutMs: 10, forceKillGraceMs: 10 });
    await host.start();
    children[0].deliver(activation(children[0].generationId));

    await waitFor(() => host.snapshot().state.activation?.phase === "committed" && !host.snapshot().activationBusy, "forced activation did not commit");
    expect(children[0].kills).toContain("SIGTERM");
    expect(host.snapshot().activeRelease).toBe(newRelease);
    await host.close();
  });

  it("lets the drain deadline own quiescent teardown after heartbeats stop", async () => {
    const root = await releaseRoot();
    const { host, children } = hostFixture(root, new Map([
      [oldRelease, [{ heartbeat: true, drainDelayMs: 150 }]],
      [newRelease, [{ heartbeat: true }]],
    ]), { heartbeatTimeoutMs: 100, drainTimeoutMs: 300 });
    await host.start();
    children[0].deliver(activation(children[0].generationId));

    await waitFor(
      () => host.snapshot().state.activation?.phase === "committed" && !host.snapshot().activationBusy,
      "slow graceful drain did not commit",
    );

    expect(children[0].kills).toEqual([]);
    expect(host.snapshot().activeRelease).toBe(newRelease);
    await host.close();
  });

  it("does not wait for the drain timeout after the old Generation has exited", async () => {
    const root = await releaseRoot();
    const { host, children } = hostFixture(root, new Map([
      [oldRelease, [{ drain: "exit" }]],
      [newRelease, [{}]],
    ]), { drainTimeoutMs: 1_000 });
    await host.start();
    const startedAt = Date.now();
    children[0].deliver(activation(children[0].generationId));

    await waitFor(
      () => host.snapshot().state.activation?.phase === "committed" && !host.snapshot().activationBusy,
      "activation did not recover the drain exit",
    );

    expect(Date.now() - startedAt).toBeLessThan(500);
    expect(children[0].kills).toEqual([]);
    expect(host.snapshot().activeRelease).toBe(newRelease);
    await host.close();
  });

  it("forces termination and continues activation when DRAIN IPC cannot be sent", async () => {
    const root = await releaseRoot();
    const { host, children } = hostFixture(root, new Map([
      [oldRelease, [{ drain: "throw" }]],
      [newRelease, [{}]],
    ]));
    await host.start();
    children[0].deliver(activation(children[0].generationId));

    await waitFor(() => host.snapshot().state.activation?.phase === "committed" && !host.snapshot().activationBusy, "activation after DRAIN IPC loss did not commit");
    expect(children[0].kills).toContain("SIGTERM");
    expect(host.snapshot().activeRelease).toBe(newRelease);
    await host.close();
  });

  it("restarts the same committed release when targetRelease is current", async () => {
    const root = await releaseRoot([oldRelease]);
    const { host, children } = hostFixture(root, new Map([[oldRelease, [{}, {}]]]));
    await host.start();
    children[0].deliver({
      ...activation(children[0].generationId),
      targetRelease: "current",
    });

    await waitFor(() => host.snapshot().state.activation?.phase === "committed" && !host.snapshot().activationBusy, "same-release restart did not commit");
    expect(children).toHaveLength(2);
    expect(await readlink(path.join(root, "current"))).toBe(`releases/${oldRelease}`);
    expect(host.snapshot().activeRelease).toBe(oldRelease);
    await host.close();
  });

  it("fails a conflicting replay without starting another activation", async () => {
    const root = await releaseRoot();
    const { host, children } = hostFixture(root, new Map([
      [oldRelease, [{}]],
      [newRelease, [{}]],
    ]));
    await host.start();
    const request = activation(children[0].generationId);
    children[0].deliver(request);
    await waitFor(() => host.snapshot().state.activation?.phase === "committed" && !host.snapshot().activationBusy, "activation did not commit");
    const candidate = children[1];

    candidate.deliver({
      ...request,
      generationId: candidate.generationId,
      targetRelease: oldRelease,
    });
    await Promise.resolve();

    expect(children).toHaveLength(2);
    expect(candidate.sent).toContainEqual(expect.objectContaining({
      type: "ACTIVATION_RESULT",
      requestId: request.requestId,
      status: "failed",
      error: expect.stringContaining("conflicts"),
    }));
    await host.close();
  });

  it.each([
    [newRelease, "committed", "succeeded"],
    [oldRelease, "rolled_back", "rolled_back"],
  ] as const)("reconciles a Host crash from starting with current=%s as %s", async (currentRelease, phase, status) => {
    const root = await releaseRoot();
    await rm(path.join(root, "current"));
    await symlink(`releases/${currentRelease}`, path.join(root, "current"));
    await mkdir(path.join(root, "runtime"), { recursive: true });
    await writeFile(path.join(root, "runtime", "activation.json"), JSON.stringify({
      schema: "tagent-core/host-state-v1",
      crashTimestamps: [],
      activation: {
        requestId: "run-1:1:activate-1",
        runId: "run-1",
        operationId: "run-1:1:activate-1",
        previousRelease: oldRelease,
        targetRelease: newRelease,
        generationId: "lost-generation",
        phase: "starting",
        updatedAt: 1,
      },
    }));
    const { host, children } = hostFixture(root, new Map([[currentRelease, [{}]]]));

    await host.start();

    expect(host.snapshot().state.activation?.phase).toBe(phase);
    expect(children[0].activationRequestId).toBe("run-1:1:activate-1");
    expect(children[0].sent).toContainEqual(expect.objectContaining({
      type: "ACTIVATION_RESULT",
      requestId: "run-1:1:activate-1",
      status,
      activeRelease: currentRelease,
    }));
    await host.close();
  });

  it.each([
    [newRelease, "committed", "succeeded"],
    [oldRelease, "rolled_back", "rolled_back"],
    [oldRelease, "failed", "failed"],
  ] as const)("replays recovered terminal phase %s/%s before continuation recovery", async (currentRelease, phase, status) => {
    const root = await releaseRoot();
    await rm(path.join(root, "current"));
    await symlink(`releases/${currentRelease}`, path.join(root, "current"));
    await mkdir(path.join(root, "runtime"), { recursive: true });
    await writeFile(path.join(root, "runtime", "activation.json"), JSON.stringify({
      schema: "tagent-core/host-state-v1",
      crashTimestamps: [],
      activation: {
        requestId: "run-1:1:activate-1",
        runId: "run-1",
        operationId: "run-1:1:activate-1",
        previousRelease: oldRelease,
        targetRelease: newRelease,
        generationId: "lost-generation",
        phase,
        updatedAt: 1,
        ...(phase === "failed" ? { error: "activation failed before Host restart" } : {}),
      },
    }));
    const { host, children } = hostFixture(root, new Map([[currentRelease, [{}]]]));

    await host.start();

    expect(children[0].activationRequestId).toBe("run-1:1:activate-1");
    expect(children[0].sent).toContainEqual(expect.objectContaining({
      type: "ACTIVATION_RESULT",
      requestId: "run-1:1:activate-1",
      status,
      activeRelease: currentRelease,
    }));
    await host.close();
  });

  it("starts a development Generation through the Host without exposing release activation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "tagent-core-host-direct-"));
    roots.push(root);
    const { host, children } = hostFixture(root, new Map([["development", [{}]]]));

    await host.start();

    expect(host.snapshot().activeRelease).toBe("development");
    expect(children).toHaveLength(1);
    expect(children[0].cwd).toBe(root);
    await host.close();
  });

  it("keeps the Generation working directory stable across release activation", async () => {
    const root = await releaseRoot();
    const { host, children } = hostFixture(root, new Map([
      [oldRelease, [{}]],
      [newRelease, [{}]],
    ]));
    await host.start();
    children[0].deliver(activation(children[0].generationId));

    await waitFor(
      () => host.snapshot().state.activation?.phase === "committed" && !host.snapshot().activationBusy,
      "activation did not commit",
    );

    expect(children.map((child) => child.cwd)).toEqual([root, root]);
    expect(children[1].cwd).not.toBe(path.join(root, "releases", newRelease));
    await host.close();
  });

  it("restarts the committed Generation with backoff and stops only after the durable crash budget", async () => {
    const root = await releaseRoot([oldRelease]);
    const fastBackoff: CoreHostTimers = {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs >= 1_000 ? 0 : delayMs),
      clearTimeout: (timer) => clearTimeout(timer),
    };
    const { host, children, fatal } = hostFixture(root, new Map([
      [oldRelease, [{}, {}]],
    ]), { timers: fastBackoff, maxCrashes: 1 });
    await host.start();
    children[0].exit(1, null);
    await waitFor(() => children.length === 2 && host.snapshot().activeRelease === oldRelease, "Generation did not restart");
    children[1].exit(1, null);
    await waitFor(() => fatal.mock.calls.length === 1, "crash budget did not stop Host recovery");
    expect(host.snapshot().state.crashTimestamps).toHaveLength(2);
    const durable = JSON.parse(await readFile(path.join(root, "runtime", "activation.json"), "utf8"));
    expect(durable.crashTimestamps).toHaveLength(2);
    await host.close();
  });

  it("fails closed without charging release verification to the restart crash budget", async () => {
    const root = await releaseRoot([oldRelease]);
    let verificationCalls = 0;
    const fastBackoff: CoreHostTimers = {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs >= 1_000 ? 0 : delayMs),
      clearTimeout: (timer) => clearTimeout(timer),
    };
    const { host, children, fatal } = hostFixture(root, new Map([[oldRelease, [{}]]]), {
      timers: fastBackoff,
      verifyRelease: async () => {
        verificationCalls += 1;
        if (verificationCalls > 1) throw new Error("committed release was modified");
      },
    });
    await host.start();
    children[0].exit(1, null);

    await waitFor(() => fatal.mock.calls.length === 1, "invalid committed release did not stop Host recovery");

    expect(children).toHaveLength(1);
    expect(host.snapshot().state.crashTimestamps).toHaveLength(1);
    expect(String(fatal.mock.calls[0]?.[0])).toContain("could not verify the committed release");
    await host.close();
  });

  it("does not spawn a Generation after Host close wins a restart-verification race", async () => {
    const root = await releaseRoot([oldRelease]);
    let verificationCalls = 0;
    let releaseRestartVerification!: () => void;
    let verificationStarted!: () => void;
    const restartVerificationStarted = new Promise<void>((resolve) => { verificationStarted = resolve; });
    const waitingForVerification = new Promise<void>((resolve) => { releaseRestartVerification = resolve; });
    const fastBackoff: CoreHostTimers = {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs >= 1_000 ? 0 : delayMs),
      clearTimeout: (timer) => clearTimeout(timer),
    };
    const { host, children } = hostFixture(root, new Map([
      [oldRelease, [{}]],
    ]), {
      timers: fastBackoff,
      verifyRelease: async () => {
        verificationCalls += 1;
        if (verificationCalls === 2) {
          verificationStarted();
          await waitingForVerification;
        }
      },
    });
    await host.start();
    children[0].exit(1, null);
    await restartVerificationStarted;

    const closing = host.close();
    releaseRestartVerification();
    await closing;

    expect(children).toHaveLength(1);
    expect(host.snapshot().activeRelease).toBeNull();
  });

  it("fails closed on malformed durable activation state", async () => {
    const root = await releaseRoot([oldRelease]);
    await mkdir(path.join(root, "runtime"), { recursive: true });
    await writeFile(path.join(root, "runtime", "activation.json"), JSON.stringify({
      schema: "tagent-core/host-state-v1",
      crashTimestamps: [],
      activation: {
        requestId: "request-1",
        runId: "run-1",
        operationId: "operation-1",
        previousRelease: oldRelease,
        targetRelease: "current",
        generationId: "generation-1",
        phase: "starting",
        updatedAt: 1,
      },
    }));
    const { host, children } = hostFixture(root, new Map([[oldRelease, [{}]]]));
    await expect(host.start()).rejects.toThrow("full lowercase Git commits");
    expect(children).toHaveLength(0);
  });

  it("reclaims a started Generation when Host startup reconciliation fails", async () => {
    const root = await releaseRoot();
    const statePath = path.join(root, "runtime", "activation.json");
    await mkdir(path.dirname(statePath), { recursive: true });
    await writeFile(statePath, JSON.stringify({
      schema: "tagent-core/host-state-v1",
      crashTimestamps: [],
      activation: {
        requestId: "run-1:1:activate-1",
        runId: "run-1",
        operationId: "run-1:1:activate-1",
        previousRelease: oldRelease,
        targetRelease: newRelease,
        generationId: "lost-generation",
        phase: "starting",
        updatedAt: 1,
      },
    }));
    const { host, children } = hostFixture(root, new Map([
      [oldRelease, [{
        onReady: () => {
          rmSync(statePath, { force: true });
          mkdirSync(statePath);
        },
      }]],
    ]));

    await expect(host.start()).rejects.toThrow();

    expect(children).toHaveLength(1);
    expect(children[0].kills).toContain("SIGTERM");
    expect(host.snapshot().activeRelease).toBeNull();
  });
});
