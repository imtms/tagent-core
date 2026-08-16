import { fork } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  CORE_HOST_PROTOCOL_VERSION,
  type CoreHostActivationRequest,
  type HostToGenerationMessage,
} from "./generation-protocol.js";
import {
  GenerationSession,
  type CoreHostLogger,
} from "./host-generation-session.js";
import {
  CoreHostStateStore,
  initialCoreHostState,
  type CoreHostActivationPhase,
  type CoreHostActivationState,
  type CoreHostDurableState,
} from "./host-state-store.js";
import {
  CoreReleaseRegistry,
  type CoreReleaseIdentity,
} from "./host-release-registry.js";

export {
  CORE_HOST_PROTOCOL_VERSION,
  CORE_STATE_PROTOCOL,
  parseGenerationToHostMessage,
} from "./generation-protocol.js";
export type {
  CoreHostActivationRequest,
  CoreHostDrainedMessage,
  CoreHostReadyMessage,
  GenerationToHostMessage,
  HostToGenerationMessage,
} from "./generation-protocol.js";
export type {
  CoreHostActivationPhase,
  CoreHostActivationState,
  CoreHostDurableState,
} from "./host-state-store.js";
export type { CoreReleaseIdentity } from "./host-release-registry.js";
export type { CoreHostLogger } from "./host-generation-session.js";

const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_FORCE_KILL_GRACE_MS = 5_000;
const DEFAULT_CRASH_WINDOW_MS = 10 * 60_000;
const DEFAULT_MAX_CRASHES = 5;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;
const DEFAULT_CANDIDATE_STABILIZATION_MS = 12_000;
const MAX_ACTIVATION_ERROR_BYTES = 4 * 1024;

type HostTimer = ReturnType<typeof setTimeout>;

export interface CoreHostTimers {
  setTimeout(callback: () => void, delayMs: number): HostTimer;
  clearTimeout(timer: HostTimer): void;
}

const defaultTimers: CoreHostTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

const defaultLogger: CoreHostLogger = {
  info: (message, details) => console.log(message, details ?? ""),
  error: (message, error, details) => console.error(message, error ?? "", details ?? ""),
};

export interface CoreHostOptions {
  readonly releaseRoot: string;
  readonly directReleaseDirectory: string;
  readonly directGenerationEntry?: string;
  readonly runtimeDirectory?: string;
  readonly readyTimeoutMs?: number;
  readonly drainTimeoutMs?: number;
  readonly forceKillGraceMs?: number;
  readonly crashWindowMs?: number;
  readonly maxCrashes?: number;
  readonly heartbeatTimeoutMs?: number;
  readonly candidateStabilizationMs?: number;
  readonly clock?: () => number;
  readonly timers?: CoreHostTimers;
  readonly logger?: CoreHostLogger;
  readonly spawn?: typeof fork;
  readonly verifyRelease?: (release: CoreReleaseIdentity) => Promise<void>;
  readonly fatal?: (error: unknown) => void;
}

function boundedErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const encoded = Buffer.from(message);
  if (encoded.byteLength <= MAX_ACTIVATION_ERROR_BYTES) return message;
  return `${encoded.subarray(0, MAX_ACTIVATION_ERROR_BYTES).toString("utf8")}…`;
}

function deadline<T>(promise: Promise<T>, ms: number, timers: CoreHostTimers, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = timers.setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { timers.clearTimeout(timer); resolve(value); },
      (error) => { timers.clearTimeout(timer); reject(error); },
    );
  });
}

class CoreHostCrashBudgetExceededError extends Error {
  constructor(maxCrashes: number, crashWindowMs: number) {
    super(`Core Generation exceeded ${maxCrashes} crashes in ${crashWindowMs}ms`);
    this.name = "CoreHostCrashBudgetExceededError";
  }
}

export class CoreHost {
  private readonly generationWorkingDirectory: string;
  private readonly runtimeDirectory: string;
  private readonly stateStore: CoreHostStateStore;
  private readonly releaseRegistry: CoreReleaseRegistry;
  private readonly readyTimeoutMs: number;
  private readonly drainTimeoutMs: number;
  private readonly forceKillGraceMs: number;
  private readonly crashWindowMs: number;
  private readonly maxCrashes: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly candidateStabilizationMs: number;
  private readonly clock: () => number;
  private readonly timers: CoreHostTimers;
  private readonly logger: CoreHostLogger;
  private readonly spawn: typeof fork;
  private readonly fatal: (error: unknown) => void;
  private state: CoreHostDurableState = initialCoreHostState();
  private active?: GenerationSession;
  private activationBusy = false;
  private startInvoked = false;
  private stopped = false;
  private restartTask?: Promise<void>;
  private restartDelayCancel?: () => void;
  private heartbeatDeadline?: HostTimer;

  constructor(private readonly options: CoreHostOptions) {
    this.generationWorkingDirectory = path.resolve(options.releaseRoot);
    this.runtimeDirectory = path.resolve(options.runtimeDirectory ?? path.join(options.releaseRoot, "runtime"));
    this.stateStore = new CoreHostStateStore(this.runtimeDirectory);
    this.releaseRegistry = new CoreReleaseRegistry({
      releaseRoot: options.releaseRoot,
      directReleaseDirectory: options.directReleaseDirectory,
      directGenerationEntry: options.directGenerationEntry,
      verifyRelease: options.verifyRelease,
    });
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.forceKillGraceMs = options.forceKillGraceMs ?? DEFAULT_FORCE_KILL_GRACE_MS;
    this.crashWindowMs = options.crashWindowMs ?? DEFAULT_CRASH_WINDOW_MS;
    this.maxCrashes = options.maxCrashes ?? DEFAULT_MAX_CRASHES;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.candidateStabilizationMs = options.candidateStabilizationMs ?? DEFAULT_CANDIDATE_STABILIZATION_MS;
    this.clock = options.clock ?? Date.now;
    this.timers = options.timers ?? defaultTimers;
    this.logger = options.logger ?? defaultLogger;
    this.spawn = options.spawn ?? fork;
    this.fatal = options.fatal ?? ((error) => {
      this.logger.error("Core Host stopped after an unrecoverable failure", error);
      process.exit(1);
    });
    for (const [name, value] of [
      ["readyTimeoutMs", this.readyTimeoutMs],
      ["drainTimeoutMs", this.drainTimeoutMs],
      ["forceKillGraceMs", this.forceKillGraceMs],
      ["crashWindowMs", this.crashWindowMs],
      ["maxCrashes", this.maxCrashes],
      ["heartbeatTimeoutMs", this.heartbeatTimeoutMs],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`CoreHost ${name} must be a positive safe integer`);
    }
    if (!Number.isSafeInteger(this.candidateStabilizationMs) || this.candidateStabilizationMs < 0) {
      throw new TypeError("CoreHost candidateStabilizationMs must be a non-negative safe integer");
    }
  }

  snapshot(): Readonly<{ activeRelease: string | null; generationId: string | null; activationBusy: boolean; state: CoreHostDurableState }> {
    return Object.freeze({
      activeRelease: this.active?.release.id ?? null,
      generationId: this.active?.generationId ?? null,
      activationBusy: this.activationBusy,
      state: this.state,
    });
  }

  async start(): Promise<void> {
    if (this.startInvoked) throw new Error("Core Host can only be started once");
    this.startInvoked = true;
    if (this.stopped) throw new Error("Core Host is already stopped");
    let generationStartAttempted = false;
    try {
      await mkdir(this.runtimeDirectory, { recursive: true });
      await this.releaseRegistry.initialize();
      this.state = await this.stateStore.read();
      const now = this.clock();
      const recentCrashes = this.state.crashTimestamps.filter((item) => item > now - this.crashWindowMs);
      if (recentCrashes.length > this.maxCrashes) {
        throw new CoreHostCrashBudgetExceededError(this.maxCrashes, this.crashWindowMs);
      }
      if (recentCrashes.length !== this.state.crashTimestamps.length) {
        this.state = { ...this.state, crashTimestamps: recentCrashes };
        await this.writeState();
      }
      const release = await this.releaseRegistry.resolveCommitted();
      await this.releaseRegistry.verify(release);
      // The Host has no acknowledgement that the Generation durably recorded a
      // terminal result. Replay the latest activation identity on every Host
      // recovery so continuation recovery remains ordered behind that receipt.
      const recoveredRequestId = this.state.activation?.requestId;
      generationStartAttempted = true;
      const session = await this.startRelease(release, false, recoveredRequestId);
      await this.reconcileRecoveredActivation(session);
      this.logger.info("Core Host started Generation", { generationId: session.generationId, releaseId: release.id });
    } catch (error) {
      this.stopped = true;
      this.clearHeartbeatDeadline();
      const session = this.active;
      if (session) await this.stopSession(session, "Generation did not stop after Host startup failure");
      if (generationStartAttempted && !(error instanceof CoreHostCrashBudgetExceededError)) {
        try {
          await this.recordCrash();
        } catch (stateError) {
          throw new AggregateError(
            [error, stateError],
            "Core Host startup failed and its crash budget could not be persisted",
            { cause: stateError },
          );
        }
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    this.clearHeartbeatDeadline();
    this.restartDelayCancel?.();
    const session = this.active;
    if (session) await this.stopSession(session, "Generation did not stop after Host close", this.drainTimeoutMs);
    if (this.restartTask) await this.restartTask;
  }

  private async startRelease(
    release: CoreReleaseIdentity,
    activationManaged: boolean,
    activationRequestId?: string,
    minimumWriterFence?: number,
  ): Promise<GenerationSession> {
    const session = new GenerationSession(
      release,
      this.generationWorkingDirectory,
      this.spawn,
      (source, request) => this.beginActivation(source, request),
      (source, result) => { void this.unexpectedExit(source, result); },
      (source) => this.acceptHeartbeat(source),
      process.env,
      this.logger,
      this.clock,
      activationRequestId,
    );
    // Readiness startup owns pre-READY failures. Normal crash recovery is
    // enabled only after the child has crossed the complete READY barrier.
    session.managedExit = true;
    // A starting child is already Host-owned. This lets SIGTERM/close stop it
    // even before READY rather than losing it in a startup race.
    this.active = session;
    try {
      const ready = await deadline(session.ready, this.readyTimeoutMs, this.timers, `Generation ${session.generationId} readiness timed out`);
      if (minimumWriterFence !== undefined && ready.writerFence <= minimumWriterFence) {
        throw new Error(
          `Generation ${session.generationId} writer fence ${ready.writerFence} did not advance beyond ${minimumWriterFence}`,
        );
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (session.hasExited) throw new Error(`Generation ${session.generationId} exited immediately after READY`);
      this.armHeartbeatDeadline(session);
      this.sendHostStatus(session);
      if (!activationManaged) session.allowUnexpectedExitRecovery();
    } catch (error) {
      session.managedExit = true;
      if (!session.hasExited) session.child.kill("SIGKILL");
      await session.exited;
      if (this.active === session) this.active = undefined;
      throw error;
    }
    return session;
  }

  private beginActivation(session: GenerationSession, request: CoreHostActivationRequest): void {
    void this.activate(session, request).catch((error) => {
      void this.handleDetachedActivationFailure(error);
    });
  }

  private async handleDetachedActivationFailure(error: unknown): Promise<void> {
    this.logger.error("Core Host activation escaped its recovery boundary", error);
    if (this.stopped) return;
    this.stopped = true;
    this.clearHeartbeatDeadline();
    const failures = [error];
    const active = this.active;
    if (active) {
      try {
        await this.stopSession(active, "Generation did not stop after an unhandled activation failure");
      } catch (stopError) {
        failures.push(stopError);
      }
    }
    try {
      this.fatal(new AggregateError(failures, "Core Host activation escaped its recovery boundary"));
    } catch (fatalError) {
      this.logger.error("Core Host fatal handler failed", fatalError);
    }
  }

  private async activate(session: GenerationSession, request: CoreHostActivationRequest): Promise<void> {
    if (this.stopped || this.active !== session) return;
    if (this.replayActivationResult(session, request)) return;
    if (this.activationBusy) {
      this.sendResult(session, request.requestId, "blocked", session.release.id, "Another activation is already in progress");
      return;
    }
    this.activationBusy = true;
    // Activation now owns this Generation's exit path. A crash while release
    // verification is in flight must not start a parallel crash-restart loop.
    session.managedExit = true;
    const previous = session.release;
    let targetRelease = previous.id;
    let oldStopped = false;
    let candidate: GenerationSession | undefined;
    try {
      if (!previous.managed) throw new Error("Release activation is unavailable outside a managed immutable release root");
      if (request.expectedCurrent !== previous.id) {
        throw new Error(`Activation expected ${request.expectedCurrent}, but active release is ${previous.id}`);
      }
      const target = await this.releaseRegistry.resolveTarget(request.targetRelease, previous);
      targetRelease = target.id;
      this.state = {
        ...this.state,
        activation: this.activationState(request, session, previous.id, target.id, "validating"),
      };
      await this.writeState();
      this.sendHostStatus(session);
      await this.releaseRegistry.verify(target);
      if (this.stopped) throw new Error("Core Host stopped during Generation activation");

      this.state = { ...this.state, activation: this.activationState(request, session, previous.id, target.id, "draining") };
      await this.writeState();
      this.sendHostStatus(session);
      await this.drain(session, request.requestId);
      oldStopped = true;
      if (this.stopped) throw new Error("Core Host stopped during Generation drain");

      this.state = { ...this.state, activation: this.activationState(request, session, previous.id, target.id, "starting") };
      await this.writeState();
      candidate = await this.startRelease(
        target,
        true,
        request.requestId,
        session.readyMessage!.writerFence,
      );
      await this.waitForCandidateStability(candidate);
      if (this.stopped) throw new Error("Core Host stopped during candidate startup");
      if (candidate.hasExited) throw new Error(`Candidate ${target.id} exited before commit`);
      if (target.id !== previous.id) await this.releaseRegistry.commit(target.id);
      if (this.stopped) return;
      if (candidate.hasExited) throw new Error(`Candidate ${target.id} exited during commit`);
      this.state = { ...this.state, activation: this.activationState(request, candidate, previous.id, target.id, "committed") };
      await this.writeState();
      if (candidate.hasExited) throw new Error(`Candidate ${target.id} exited before activation settlement`);
      candidate.allowUnexpectedExitRecovery();
      this.sendHostStatus(candidate);
      this.sendResult(candidate, request.requestId, "succeeded", target.id);
      this.logger.info("Core Host committed Generation activation", { requestId: request.requestId, previousRelease: previous.id, targetRelease: target.id });
    } catch (error) {
      const message = boundedErrorMessage(error);
      this.logger.error("Core Host activation failed", error, { requestId: request.requestId, previousRelease: previous.id, targetRelease: request.targetRelease });
      if (this.stopped) {
        // Preserve the last durable non-terminal phase. On the next Host
        // start, current + activation.json deterministically reconcile it.
        return;
      }
      if (!oldStopped && this.active === session && !session.hasExited) {
        this.state = { ...this.state, activation: this.activationState(request, session, previous.id, targetRelease, "failed", message) };
        try {
          await this.writeState();
        } catch (stateError) {
          this.stopped = true;
          await this.stopSession(session, "Generation did not stop after activation-state persistence failure");
          this.fatal(new AggregateError(
            [error, stateError],
            "Core Host could not persist a terminal activation result",
          ));
          return;
        }
        session.allowUnexpectedExitRecovery();
        this.sendHostStatus(session);
        this.sendResult(session, request.requestId, "failed", previous.id, message);
      } else {
        await this.rollback(
          previous,
          request,
          message,
          candidate,
          session.readyMessage!.writerFence,
        );
      }
    } finally {
      this.activationBusy = false;
    }
  }

  private async drain(session: GenerationSession, requestId: string): Promise<void> {
    session.managedExit = true;
    // The Generation intentionally stops heartbeats before quiescent teardown.
    // From here the longer drain deadline, not the liveness deadline, owns it.
    this.clearHeartbeatDeadline();
    const drained = session.waitForDrained(requestId);
    const completed = (async () => {
      const first = await Promise.race([
        drained.then(() => "drained" as const),
        session.exited.then(() => "exited" as const),
      ]);
      // DRAINED proves the handoff was prepared, but process exit is still the
      // exclusive-writer barrier. If exit wins, waiting for an ACK that can no
      // longer arrive only extends downtime and adds no safety.
      if (first === "drained") await session.exited;
    })();
    try {
      session.send({
        type: "DRAIN",
        protocolVersion: CORE_HOST_PROTOCOL_VERSION,
        generationId: session.generationId,
        requestId,
        deadlineMs: this.drainTimeoutMs,
      });
      await deadline(completed, this.drainTimeoutMs, this.timers, `Generation ${session.generationId} drain timed out`);
    } catch (error) {
      this.logger.error("Core Host is forcing Generation termination after drain failure", error, { generationId: session.generationId, requestId });
      await this.stopSession(session, `Generation ${session.generationId} ignored SIGTERM`);
    }
    if (this.active === session) {
      this.active = undefined;
      this.clearHeartbeatDeadline();
    }
  }

  private async rollback(
    previous: CoreReleaseIdentity,
    request: CoreHostActivationRequest,
    failure: string,
    candidate?: GenerationSession,
    minimumWriterFence = 0,
  ): Promise<void> {
    try {
      if (candidate) await this.stopSession(candidate, "Candidate did not stop during rollback");
      await this.releaseRegistry.verify(previous);
      if (this.stopped) return;
      await this.releaseRegistry.commit(previous.id);
      if (this.stopped) return;
      const restored = await this.startRelease(
        previous,
        true,
        request.requestId,
        Math.max(minimumWriterFence, candidate?.readyMessage?.writerFence ?? 0),
      );
      this.state = {
        ...this.state,
        activation: this.activationState(request, restored, previous.id, this.resolvedTargetId(request, previous), "rolled_back", failure),
      };
      await this.writeState();
      restored.allowUnexpectedExitRecovery();
      this.sendHostStatus(restored);
      this.sendResult(restored, request.requestId, "rolled_back", previous.id, failure);
      this.logger.info("Core Host rolled back Generation activation", { requestId: request.requestId, activeRelease: previous.id });
    } catch (rollbackError) {
      if (this.stopped) return;
      const rollbackFailure = boundedErrorMessage(rollbackError);
      this.state = {
        ...this.state,
        activation: {
          ...this.activationState(request, undefined, previous.id, this.resolvedTargetId(request, previous), "failed", boundedErrorMessage(`${failure}; rollback failed: ${rollbackFailure}`)),
        },
      };
      await this.writeStateBestEffort();
      this.stopped = true;
      const active = this.active;
      if (active) await this.stopSession(active, "Generation did not stop after rollback failure");
      this.fatal(new AggregateError([rollbackError], "Core Host activation and rollback failed", { cause: new Error(failure) }));
    }
  }

  private async unexpectedExit(session: GenerationSession, result: { code: number | null; signal: NodeJS.Signals | null }): Promise<void> {
    if (this.stopped || session.managedExit || this.active !== session) return;
    this.active = undefined;
    this.clearHeartbeatDeadline();
    let crashes: number[];
    try {
      crashes = await this.recordCrash();
    } catch (error) {
      this.stopped = true;
      this.fatal(new AggregateError([error], "Core Host could not persist its crash budget"));
      return;
    }
    this.logger.error("Core Generation exited unexpectedly", undefined, { releaseId: session.release.id, generationId: session.generationId, ...result, crashes: crashes.length });
    if (crashes.length > this.maxCrashes) {
      this.stopped = true;
      this.fatal(new CoreHostCrashBudgetExceededError(this.maxCrashes, this.crashWindowMs));
      return;
    }
    if (this.restartTask) return;
    this.restartTask = (async () => {
      let recentCrashes = crashes;
      while (!this.stopped) {
        const delayMs = Math.min(30_000, 2 ** Math.max(0, recentCrashes.length - 1) * 1_000);
        await this.waitForRestartDelay(delayMs);
        if (this.stopped) return;
        let release: CoreReleaseIdentity;
        try {
          release = await this.releaseRegistry.resolveCommitted();
          await this.releaseRegistry.verify(release);
        } catch (error) {
          if (this.stopped) return;
          this.stopped = true;
          this.logger.error("Core Host rejected the committed release during crash recovery", error);
          this.fatal(new AggregateError([error], "Core Host could not verify the committed release during crash recovery"));
          return;
        }
        if (this.stopped) return;
        try {
          await this.startRelease(
            release,
            false,
            undefined,
            session.readyMessage?.writerFence,
          );
          return;
        } catch (error) {
          if (this.stopped) return;
          try {
            recentCrashes = await this.recordCrash();
          } catch (stateError) {
            this.stopped = true;
            this.fatal(new AggregateError([error, stateError], "Core Host restart failed and its crash budget could not be persisted"));
            return;
          }
          this.logger.error("Core Generation restart attempt failed", error, { crashes: recentCrashes.length });
          if (recentCrashes.length > this.maxCrashes) {
            this.stopped = true;
            this.fatal(new AggregateError([error], new CoreHostCrashBudgetExceededError(this.maxCrashes, this.crashWindowMs).message));
            return;
          }
        }
      }
    })().finally(() => { this.restartTask = undefined; });
    await this.restartTask;
  }

  private waitForRestartDelay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: HostTimer | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) this.timers.clearTimeout(timer);
        if (this.restartDelayCancel === finish) this.restartDelayCancel = undefined;
        resolve();
      };
      this.restartDelayCancel = finish;
      timer = this.timers.setTimeout(finish, ms);
    });
  }

  private waitForCandidateStability(session: GenerationSession): Promise<void> {
    if (this.candidateStabilizationMs === 0) {
      if (session.hasExited) return Promise.reject(new Error(`Candidate ${session.release.id} exited before stabilization`));
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let stopObserving: () => void = () => undefined;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        stopObserving();
        if (error) reject(error);
        else resolve();
      };
      const timer = this.timers.setTimeout(() => {
        finish(session.hasExited
          ? new Error(`Candidate ${session.release.id} exited during stabilization`)
          : undefined);
      }, this.candidateStabilizationMs);
      stopObserving = session.observeExit(({ code, signal }) => {
        finish(new Error(`Candidate ${session.release.id} exited during stabilization (${code ?? signal ?? "unknown"})`));
      });
    });
  }

  private acceptHeartbeat(session: GenerationSession): void {
    if (this.stopped || this.active !== session || session.hasExited) return;
    this.armHeartbeatDeadline(session);
  }

  private armHeartbeatDeadline(session: GenerationSession): void {
    this.clearHeartbeatDeadline();
    this.heartbeatDeadline = this.timers.setTimeout(() => {
      this.heartbeatDeadline = undefined;
      if (this.stopped || this.active !== session || session.hasExited) return;
      const age = session.lastHeartbeatAt === null ? Number.POSITIVE_INFINITY : this.clock() - session.lastHeartbeatAt;
      if (age < this.heartbeatTimeoutMs) {
        this.armHeartbeatDeadline(session);
        return;
      }
      this.logger.error("Core Host terminated an unresponsive Generation", undefined, {
        generationId: session.generationId,
        releaseId: session.release.id,
        heartbeatAgeMs: age,
      });
      session.child.kill("SIGKILL");
    }, this.heartbeatTimeoutMs);
    this.heartbeatDeadline.unref?.();
  }

  private clearHeartbeatDeadline(): void {
    if (this.heartbeatDeadline) this.timers.clearTimeout(this.heartbeatDeadline);
    this.heartbeatDeadline = undefined;
  }

  private sendHostStatus(session: GenerationSession): void {
    if (!session.readyMessage || session.hasExited) return;
    try {
      session.send({
        type: "HOST_STATUS",
        protocolVersion: CORE_HOST_PROTOCOL_VERSION,
        generationId: session.generationId,
        activeRelease: session.release.id,
        activationPhase: this.state.activation?.phase ?? "",
        activationRequestId: this.state.activation?.requestId ?? "",
        recentCrashes: this.state.crashTimestamps.length,
        maxCrashes: this.maxCrashes,
      });
    } catch (error) {
      this.logger.error("Core Host could not publish its status", error, { generationId: session.generationId });
    }
  }

  private async recordCrash(): Promise<number[]> {
    const timestamp = this.clock();
    const crashes = [...this.state.crashTimestamps.filter((item) => item > timestamp - this.crashWindowMs), timestamp];
    this.state = { ...this.state, crashTimestamps: crashes };
    await this.writeState();
    return crashes;
  }

  private resolvedTargetId(request: CoreHostActivationRequest, previousRelease: Pick<CoreReleaseIdentity, "id">): string {
    return request.targetRelease === "current" ? previousRelease.id : request.targetRelease;
  }

  private replayActivationResult(session: GenerationSession, request: CoreHostActivationRequest): boolean {
    const activation = this.state.activation;
    if (!activation || activation.requestId !== request.requestId) return false;
    if (activation.runId !== request.runId
      || activation.operationId !== request.operationId
      || activation.previousRelease !== request.expectedCurrent
      || activation.targetRelease !== this.resolvedTargetId(request, { id: request.expectedCurrent })) {
      this.sendResult(
        session,
        request.requestId,
        "failed",
        session.release.id,
        "Activation request identity conflicts with its durable Host record",
      );
      return true;
    }
    if (!new Set<CoreHostActivationPhase>(["committed", "rolled_back", "failed"]).has(activation.phase)) {
      return true;
    }
    const status = activation.phase === "committed"
      ? "succeeded"
      : activation.phase === "rolled_back" ? "rolled_back" : "failed";
    const activeRelease = activation.phase === "committed" ? activation.targetRelease : activation.previousRelease;
    this.sendResult(session, request.requestId, status, activeRelease, activation.error);
    return true;
  }

  private activationState(
    request: CoreHostActivationRequest,
    session: GenerationSession | undefined,
    previousRelease: string,
    targetRelease: string,
    phase: CoreHostActivationPhase,
    error?: string,
  ): CoreHostActivationState {
    return {
      requestId: request.requestId,
      runId: request.runId,
      operationId: request.operationId,
      previousRelease,
      targetRelease,
      generationId: session?.generationId ?? request.generationId,
      phase,
      updatedAt: this.clock(),
      ...(error ? { error } : {}),
    };
  }

  private sendResult(
    session: GenerationSession,
    requestId: string,
    status: Extract<HostToGenerationMessage, { type: "ACTIVATION_RESULT" }>["status"],
    activeRelease: string,
    error?: string,
  ): void {
    try {
      session.send({
        type: "ACTIVATION_RESULT",
        protocolVersion: CORE_HOST_PROTOCOL_VERSION,
        requestId,
        status,
        activeRelease,
        ...(error ? { error } : {}),
      });
    } catch (sendError) {
      this.logger.error("Core Host could not deliver activation result", sendError, { requestId, status, activeRelease });
    }
  }

  private async reconcileRecoveredActivation(session: GenerationSession): Promise<void> {
    const activation = this.state.activation;
    if (!activation) return;
    if (!["committed", "rolled_back", "failed"].includes(activation.phase)) {
      const succeeded = session.release.id === activation.targetRelease;
      const phase: CoreHostActivationPhase = succeeded ? "committed" : "rolled_back";
      this.state = { ...this.state, activation: { ...activation, phase, generationId: session.generationId, updatedAt: this.clock(), ...(succeeded ? {} : { error: activation.error ?? "Host restarted before activation commit" }) } };
      await this.writeState();
    }
    const recovered = this.state.activation!;
    const status = recovered.phase === "committed"
      ? "succeeded"
      : recovered.phase === "rolled_back" ? "rolled_back" : "failed";
    const activeRelease = recovered.phase === "committed" ? recovered.targetRelease : recovered.previousRelease;
    this.sendResult(session, recovered.requestId, status, activeRelease, recovered.error);
  }

  private async stopSession(
    session: GenerationSession,
    timeoutMessage: string,
    graceMs = this.forceKillGraceMs,
  ): Promise<void> {
    if (this.active === session) {
      this.active = undefined;
      this.clearHeartbeatDeadline();
    }
    if (session.hasExited) return;
    session.managedExit = true;
    session.child.kill("SIGTERM");
    try {
      await deadline(session.exited, graceMs, this.timers, timeoutMessage);
    } catch {
      if (!session.hasExited) session.child.kill("SIGKILL");
      await session.exited;
    }
  }

  private async writeState(): Promise<void> {
    await this.stateStore.write(this.state);
  }

  private async writeStateBestEffort(): Promise<void> {
    try { await this.writeState(); }
    catch (error) { this.logger.error("Core Host could not persist its activation state", error); }
  }
}

export interface CoreHostCliOptions {
  readonly entryPath: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly directGenerationEntry?: string;
}

export async function runCoreHostFromCli(options: CoreHostCliOptions): Promise<CoreHost> {
  const environment = options.environment ?? process.env;
  const directReleaseDirectory = path.dirname(path.dirname(path.resolve(options.entryPath)));
  const inferredReleaseRoot = path.basename(directReleaseDirectory) === "current"
    ? path.dirname(directReleaseDirectory)
    : directReleaseDirectory;
  const releaseRoot = path.resolve(environment.TAGENT_RELEASE_ROOT ?? inferredReleaseRoot);
  const host = new CoreHost({
    releaseRoot,
    directReleaseDirectory,
    ...(options.directGenerationEntry ? { directGenerationEntry: options.directGenerationEntry } : {}),
  });
  await host.start();
  let closing = false;
  const close = async (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    console.log(`Received ${signal}; closing TAgent Core Host`);
    try { await host.close(); }
    catch (error) { console.error("TAgent Core Host close failed", error); process.exitCode = 1; }
  };
  process.once("SIGTERM", () => void close("SIGTERM"));
  process.once("SIGINT", () => void close("SIGINT"));
  return host;
}
