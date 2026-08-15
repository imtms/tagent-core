import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  CORE_HOST_PROTOCOL_VERSION,
  CORE_STATE_PROTOCOL,
  parseGenerationToHostMessage,
  type CoreHostActivationRequest,
  type CoreHostDrainedMessage,
  type CoreHostReadyMessage,
  type GenerationToHostMessage,
  type HostToGenerationMessage,
} from "./generation-protocol.js";

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

const RELEASE_ID = /^[0-9a-f]{40}$/;
const DEFAULT_READY_TIMEOUT_MS = 30_000;
const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;
const DEFAULT_FORCE_KILL_GRACE_MS = 5_000;
const DEFAULT_CRASH_WINDOW_MS = 10 * 60_000;
const DEFAULT_MAX_CRASHES = 5;
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

export interface CoreReleaseIdentity {
  readonly id: string;
  readonly directory: string;
  readonly generationEntry: string;
  readonly managed: boolean;
}

export type CoreHostActivationPhase =
  | "validating"
  | "draining"
  | "starting"
  | "committed"
  | "rolled_back"
  | "failed";

export interface CoreHostActivationState {
  readonly requestId: string;
  readonly runId: string;
  readonly operationId: string;
  readonly previousRelease: string;
  readonly targetRelease: string;
  readonly generationId: string;
  readonly phase: CoreHostActivationPhase;
  readonly updatedAt: number;
  readonly error?: string;
}

export interface CoreHostDurableState {
  readonly schema: "tagent-core/host-state-v1";
  readonly crashTimestamps: readonly number[];
  readonly activation: CoreHostActivationState | null;
}

export interface CoreHostLogger {
  info(message: string, details?: Readonly<Record<string, unknown>>): void;
  error(message: string, error?: unknown, details?: Readonly<Record<string, unknown>>): void;
}

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
  readonly clock?: () => number;
  readonly timers?: CoreHostTimers;
  readonly logger?: CoreHostLogger;
  readonly spawn?: typeof fork;
  readonly verifyRelease?: (release: CoreReleaseIdentity) => Promise<void>;
  readonly fatal?: (error: unknown) => void;
}

interface CoreReleaseManifest {
  schemaVersion: number;
  artifact: string;
  commit: string;
  core?: {
    hostProtocolVersion?: number;
    stateProtocol?: string;
    generationEntry?: string;
  };
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], name: string): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new TypeError(`${name} must contain exactly ${canonical.join(", ")}`);
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new TypeError(`${name} must be a non-empty string`);
  return value;
}

function safeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError(`${name} must be a non-negative safe integer`);
  return value as number;
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

class GenerationSession {
  readonly child: ChildProcess;
  readonly generationId = randomUUID();
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  managedExit = false;
  readyMessage?: CoreHostReadyMessage;
  private resolveReady!: (message: CoreHostReadyMessage) => void;
  private rejectReady!: (error: unknown) => void;
  private resolveExit!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
  private readonly drained = new Map<string, { promise: Promise<CoreHostDrainedMessage>; resolve: (message: CoreHostDrainedMessage) => void }>();
  private exitedValue?: { code: number | null; signal: NodeJS.Signals | null };
  private unexpectedExitReported = false;
  readonly ready: Promise<CoreHostReadyMessage>;

  constructor(
    readonly release: CoreReleaseIdentity,
    workingDirectory: string,
    spawn: typeof fork,
    private readonly onActivation: (session: GenerationSession, request: CoreHostActivationRequest) => void,
    private readonly onUnexpectedExit: (session: GenerationSession, result: { code: number | null; signal: NodeJS.Signals | null }) => void,
    env: NodeJS.ProcessEnv,
    private readonly logger: CoreHostLogger,
    activationRequestId?: string,
  ) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    this.exited = new Promise((resolve) => { this.resolveExit = resolve; });
    this.child = spawn(release.generationEntry, [], {
      // Application-relative state belongs to the stable installation, not
      // to an immutable code generation. This keeps the default database and
      // workspace paths identical across release activation and rollback.
      cwd: workingDirectory,
      env: {
        ...env,
        TAGENT_HOST_MANAGED: "1",
        TAGENT_GENERATION_ID: this.generationId,
        TAGENT_RELEASE_ID: release.id,
        TAGENT_RELEASE_MANAGED: release.managed ? "1" : "0",
        TAGENT_STATE_PROTOCOL: CORE_STATE_PROTOCOL,
        ...(activationRequestId ? { TAGENT_ACTIVATION_REQUEST_ID: activationRequestId } : {}),
      },
      stdio: ["inherit", "inherit", "inherit", "ipc"],
    });
    this.child.on("message", (raw) => this.receive(raw));
    this.child.once("error", (error) => this.rejectReady(error));
    const finishExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.exitedValue) return;
      const result = { code, signal };
      this.exitedValue = result;
      this.resolveExit(result);
      if (!this.readyMessage) this.rejectReady(new Error(`Generation ${this.generationId} exited before READY`));
      this.reportUnexpectedExitIfNeeded();
    };
    // Node may omit `exit` when spawning fails, but always closes the child
    // stdio/IPC resources. Treat the first exit/close signal as terminal.
    this.child.once("exit", finishExit);
    this.child.once("close", finishExit);
  }

  get hasExited(): boolean { return this.exitedValue !== undefined; }

  allowUnexpectedExitRecovery(): void {
    this.managedExit = false;
    this.reportUnexpectedExitIfNeeded();
  }

  send(message: HostToGenerationMessage): void {
    if (!this.child.connected || this.hasExited) throw new Error(`Generation ${this.generationId} IPC is unavailable`);
    this.child.send(message);
  }

  waitForDrained(requestId: string): Promise<CoreHostDrainedMessage> {
    const existing = this.drained.get(requestId);
    if (existing) return existing.promise;
    let resolve!: (message: CoreHostDrainedMessage) => void;
    const promise = new Promise<CoreHostDrainedMessage>((done) => { resolve = done; });
    this.drained.set(requestId, { promise, resolve });
    return promise;
  }

  private receive(raw: unknown): void {
    let message: GenerationToHostMessage;
    try {
      message = parseGenerationToHostMessage(raw);
    } catch (error) {
      this.logger.error("Core Host rejected malformed Generation IPC", error, { generationId: this.generationId });
      return;
    }
    if (message.generationId !== this.generationId) {
      this.logger.error("Core Host rejected stale Generation IPC", undefined, {
        expectedGenerationId: this.generationId,
        receivedGenerationId: message.generationId,
      });
      return;
    }
    if (message.type === "READY") {
      if (this.readyMessage) return;
      if (message.releaseId !== this.release.id) {
        this.rejectReady(new Error(`Generation release mismatch: expected ${this.release.id}, got ${message.releaseId}`));
        return;
      }
      this.readyMessage = message;
      this.resolveReady(message);
      return;
    }
    if (message.type === "DRAINED") {
      if (!this.readyMessage || message.writerFence !== this.readyMessage.writerFence) {
        this.logger.error("Core Host rejected DRAINED with a stale writer fence", undefined, {
          generationId: this.generationId,
          receivedWriterFence: message.writerFence,
          expectedWriterFence: this.readyMessage?.writerFence,
        });
        return;
      }
      this.drained.get(message.requestId)?.resolve(message);
      return;
    }
    if (!this.readyMessage) {
      this.logger.error("Core Host rejected activation before Generation readiness", undefined, { generationId: this.generationId });
      return;
    }
    this.onActivation(this, message);
  }

  private reportUnexpectedExitIfNeeded(): void {
    if (this.managedExit || !this.exitedValue || this.unexpectedExitReported) return;
    this.unexpectedExitReported = true;
    this.onUnexpectedExit(this, this.exitedValue);
  }
}

function initialState(): CoreHostDurableState {
  return { schema: "tagent-core/host-state-v1", crashTimestamps: [], activation: null };
}

export class CoreHost {
  private readonly generationWorkingDirectory: string;
  private readonly runtimeDirectory: string;
  private readonly statePath: string;
  private readonly currentPath: string;
  private readonly readyTimeoutMs: number;
  private readonly drainTimeoutMs: number;
  private readonly forceKillGraceMs: number;
  private readonly crashWindowMs: number;
  private readonly maxCrashes: number;
  private readonly clock: () => number;
  private readonly timers: CoreHostTimers;
  private readonly logger: CoreHostLogger;
  private readonly spawn: typeof fork;
  private readonly fatal: (error: unknown) => void;
  private state: CoreHostDurableState = initialState();
  private active?: GenerationSession;
  private activationBusy = false;
  private startInvoked = false;
  private stopped = false;
  private restartTask?: Promise<void>;
  private restartDelayCancel?: () => void;
  private trustedVerifierPath?: string;

  constructor(private readonly options: CoreHostOptions) {
    this.generationWorkingDirectory = path.resolve(options.releaseRoot);
    this.runtimeDirectory = path.resolve(options.runtimeDirectory ?? path.join(options.releaseRoot, "runtime"));
    this.statePath = path.join(this.runtimeDirectory, "activation.json");
    this.currentPath = path.join(path.resolve(options.releaseRoot), "current");
    this.readyTimeoutMs = options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.forceKillGraceMs = options.forceKillGraceMs ?? DEFAULT_FORCE_KILL_GRACE_MS;
    this.crashWindowMs = options.crashWindowMs ?? DEFAULT_CRASH_WINDOW_MS;
    this.maxCrashes = options.maxCrashes ?? DEFAULT_MAX_CRASHES;
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
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`CoreHost ${name} must be a positive safe integer`);
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
    try {
      await mkdir(this.runtimeDirectory, { recursive: true });
      this.trustedVerifierPath = path.join(
        await realpath(this.options.directReleaseDirectory),
        "scripts",
        "release-manifest.mjs",
      );
      this.state = await this.readState();
      const now = this.clock();
      const recentCrashes = this.state.crashTimestamps.filter((item) => item > now - this.crashWindowMs);
      if (recentCrashes.length > this.maxCrashes) {
        throw new Error(`Core Generation exceeded ${this.maxCrashes} crashes in ${this.crashWindowMs}ms`);
      }
      if (recentCrashes.length !== this.state.crashTimestamps.length) {
        this.state = { ...this.state, crashTimestamps: recentCrashes };
        await this.writeState();
      }
      const release = await this.resolveCommittedRelease();
      await this.verifyRelease(release);
      // The Host has no acknowledgement that the Generation durably recorded a
      // terminal result. Replay the latest activation identity on every Host
      // recovery so continuation recovery remains ordered behind that receipt.
      const recoveredRequestId = this.state.activation?.requestId;
      const session = await this.startRelease(release, false, recoveredRequestId);
      await this.reconcileRecoveredActivation(session);
      this.logger.info("Core Host started Generation", { generationId: session.generationId, releaseId: release.id });
    } catch (error) {
      this.stopped = true;
      const session = this.active;
      if (session) await this.stopSession(session, "Generation did not stop after Host startup failure");
      throw error;
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
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
      (source, request) => { void this.activate(source, request); },
      (source, result) => { void this.unexpectedExit(source, result); },
      process.env,
      this.logger,
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
      const target = await this.resolveTargetRelease(request.targetRelease, previous);
      targetRelease = target.id;
      this.state = {
        ...this.state,
        activation: this.activationState(request, session, previous.id, target.id, "validating"),
      };
      await this.writeState();
      await this.verifyRelease(target);
      if (this.stopped) throw new Error("Core Host stopped during Generation activation");

      this.state = { ...this.state, activation: this.activationState(request, session, previous.id, target.id, "draining") };
      await this.writeState();
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
      if (this.stopped) throw new Error("Core Host stopped during candidate startup");
      if (candidate.hasExited) throw new Error(`Candidate ${target.id} exited before commit`);
      if (target.id !== previous.id) await this.commitCurrent(target.id);
      if (this.stopped) return;
      this.state = { ...this.state, activation: this.activationState(request, candidate, previous.id, target.id, "committed") };
      await this.writeState();
      candidate.allowUnexpectedExitRecovery();
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
    const drained = session.waitForDrained(requestId);
    try {
      session.send({
        type: "DRAIN",
        protocolVersion: CORE_HOST_PROTOCOL_VERSION,
        generationId: session.generationId,
        requestId,
        deadlineMs: this.drainTimeoutMs,
      });
      await deadline(Promise.all([drained, session.exited]), this.drainTimeoutMs, this.timers, `Generation ${session.generationId} drain timed out`);
    } catch (error) {
      this.logger.error("Core Host is forcing Generation termination after drain failure", error, { generationId: session.generationId, requestId });
      await this.stopSession(session, `Generation ${session.generationId} ignored SIGTERM`);
    }
    if (this.active === session) this.active = undefined;
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
      await this.verifyRelease(previous);
      if (this.stopped) return;
      await this.commitCurrent(previous.id);
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
      this.fatal(new Error(`Core Generation exceeded ${this.maxCrashes} crashes in ${this.crashWindowMs}ms`));
      return;
    }
    if (this.restartTask) return;
    this.restartTask = (async () => {
      let recentCrashes = crashes;
      while (!this.stopped) {
        const delayMs = Math.min(30_000, 2 ** Math.max(0, recentCrashes.length - 1) * 1_000);
        await this.waitForRestartDelay(delayMs);
        if (this.stopped) return;
        try {
          const release = await this.resolveCommittedRelease();
          await this.verifyRelease(release);
          if (this.stopped) return;
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
            this.fatal(new AggregateError([error], `Core Generation exceeded ${this.maxCrashes} crashes in ${this.crashWindowMs}ms`));
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

  private async resolveCommittedRelease(): Promise<CoreReleaseIdentity> {
    try {
      const target = await readlink(this.currentPath);
      const match = /^releases\/([0-9a-f]{40})$/.exec(target.replaceAll("\\", "/"));
      if (!match) throw new Error(`Core current link has unsafe target ${target}`);
      return this.resolveRelease(match[1]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const directory = path.resolve(this.options.directReleaseDirectory);
      const entry = path.resolve(directory, this.options.directGenerationEntry ?? "dist/generation-entry.js");
      const configuredId = process.env.TAGENT_RELEASE_ID?.trim() ?? "";
      const id = RELEASE_ID.test(configuredId) ? configuredId : "development";
      return { id, directory, generationEntry: entry, managed: false };
    }
  }

  private async resolveTargetRelease(target: string, current: CoreReleaseIdentity): Promise<CoreReleaseIdentity> {
    if (target === "current") return current;
    if (!RELEASE_ID.test(target)) throw new Error("Target release must be current or a full lowercase Git commit");
    return this.resolveRelease(target);
  }

  private async resolveRelease(id: string): Promise<CoreReleaseIdentity> {
    if (!RELEASE_ID.test(id)) throw new Error(`Invalid release identity ${id}`);
    const root = path.resolve(this.options.releaseRoot);
    const directory = path.join(root, "releases", id);
    const resolved = await realpath(directory);
    const expected = await realpath(path.join(root, "releases")) + path.sep;
    if (!resolved.startsWith(expected)) throw new Error(`Release ${id} escapes the release root`);
    const manifest = JSON.parse(await readFile(path.join(resolved, "RELEASE_MANIFEST.json"), "utf8")) as CoreReleaseManifest;
    if (manifest.schemaVersion !== 2) throw new Error(`Release ${id} manifest schema is unsupported`);
    if (manifest.artifact !== "core" || manifest.commit !== id) throw new Error(`Release ${id} manifest identity is invalid`);
    if (manifest.core?.hostProtocolVersion !== CORE_HOST_PROTOCOL_VERSION) throw new Error(`Release ${id} Host protocol is incompatible`);
    if (manifest.core.stateProtocol !== CORE_STATE_PROTOCOL) throw new Error(`Release ${id} state protocol is incompatible`);
    const relativeEntry = manifest.core.generationEntry;
    if (!relativeEntry) throw new Error(`Release ${id} Generation entry is missing`);
    if (path.isAbsolute(relativeEntry) || relativeEntry.split(/[\\/]+/).includes("..")) throw new Error(`Release ${id} generation entry is unsafe`);
    return { id, directory: resolved, generationEntry: path.join(resolved, relativeEntry), managed: true };
  }

  private async verifyRelease(release: CoreReleaseIdentity): Promise<void> {
    if (!release.managed) return;
    if (this.options.verifyRelease) return this.options.verifyRelease(release);
    if (!this.trustedVerifierPath) throw new Error("Core Host trusted release verifier is unavailable");
    const verify = promisify(execFile);
    await verify(process.execPath, [this.trustedVerifierPath, "verify", release.directory], {
      cwd: release.directory,
      maxBuffer: 4 * 1024 * 1024,
    });
  }

  private async commitCurrent(releaseId: string): Promise<void> {
    const root = path.resolve(this.options.releaseRoot);
    const temporary = path.join(root, `.current.${releaseId}.${randomUUID()}`);
    await symlink(`releases/${releaseId}`, temporary);
    try {
      await rename(temporary, this.currentPath);
      const directory = await open(root, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async stopSession(
    session: GenerationSession,
    timeoutMessage: string,
    graceMs = this.forceKillGraceMs,
  ): Promise<void> {
    if (this.active === session) this.active = undefined;
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

  private async readState(): Promise<CoreHostDurableState> {
    try {
      const parsed = record(JSON.parse(await readFile(this.statePath, "utf8")), "Core Host state");
      exactKeys(parsed, ["schema", "crashTimestamps", "activation"], "Core Host state");
      if (parsed.schema !== "tagent-core/host-state-v1" || !Array.isArray(parsed.crashTimestamps)) throw new Error("Core Host state schema is unsupported");
      const crashTimestamps = parsed.crashTimestamps.map((item) => safeInteger(item, "Core Host crash timestamp"));
      return {
        schema: "tagent-core/host-state-v1",
        crashTimestamps,
        activation: parsed.activation === null ? null : this.parseActivationState(parsed.activation),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return initialState();
      throw error;
    }
  }

  private parseActivationState(value: unknown): CoreHostActivationState {
    const activation = record(value, "Core Host activation state");
    const expected = activation.error === undefined
      ? ["requestId", "runId", "operationId", "previousRelease", "targetRelease", "generationId", "phase", "updatedAt"]
      : ["requestId", "runId", "operationId", "previousRelease", "targetRelease", "generationId", "phase", "updatedAt", "error"];
    exactKeys(activation, expected, "Core Host activation state");
    const phase = text(activation.phase, "Core Host activation phase") as CoreHostActivationPhase;
    if (!new Set<CoreHostActivationPhase>(["validating", "draining", "starting", "committed", "rolled_back", "failed"]).has(phase)) {
      throw new TypeError(`Core Host activation phase ${phase} is unsupported`);
    }
    const previousRelease = text(activation.previousRelease, "Core Host previous release");
    const targetRelease = text(activation.targetRelease, "Core Host target release");
    if (!RELEASE_ID.test(previousRelease) || !RELEASE_ID.test(targetRelease)) {
      throw new TypeError("Core Host activation releases must be full lowercase Git commits");
    }
    return {
      requestId: text(activation.requestId, "Core Host activation requestId"),
      runId: text(activation.runId, "Core Host activation runId"),
      operationId: text(activation.operationId, "Core Host activation operationId"),
      previousRelease,
      targetRelease,
      generationId: text(activation.generationId, "Core Host activation generationId"),
      phase,
      updatedAt: safeInteger(activation.updatedAt, "Core Host activation updatedAt"),
      ...(activation.error === undefined ? {} : { error: text(activation.error, "Core Host activation error") }),
    };
  }

  private async writeState(): Promise<void> {
    await mkdir(this.runtimeDirectory, { recursive: true });
    const temporary = path.join(this.runtimeDirectory, `.activation.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(this.state)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.statePath);
      const directory = await open(this.runtimeDirectory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally {
      await rm(temporary, { force: true });
    }
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
