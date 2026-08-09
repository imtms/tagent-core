import { monitorEventLoopDelay } from "node:perf_hooks";

const CORE_HEARTBEAT_INTERVAL_MS = 5_000;
const CORE_HEARTBEAT_MAX_AGE_MS = 10_000;

type CoreLifecycleTimerHandle = ReturnType<typeof setTimeout>;

export interface CoreLifecycleTimers {
  setInterval(callback: () => void, delayMs: number): CoreLifecycleTimerHandle;
  clearInterval(handle: CoreLifecycleTimerHandle): void;
  setTimeout(callback: () => void, delayMs: number): CoreLifecycleTimerHandle;
  clearTimeout(handle: CoreLifecycleTimerHandle): void;
}

const defaultTimers: CoreLifecycleTimers = {
  setInterval: (callback, delayMs) => setInterval(callback, delayMs),
  clearInterval: (handle) => clearInterval(handle),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export interface WriterReadiness {
  isWriterReady(): boolean;
}

export type CoreLifecyclePhase = "starting" | "ready" | "closing" | "closed";

export interface CoreLifecycleSnapshot {
  phase: CoreLifecyclePhase;
  writerReady: boolean;
  lastFailure: string | null;
}

export type CoreHeartbeatStage = "instance_lock" | "writer_lease" | "connection_guard";

export interface CoreHeartbeatStageDurations {
  instanceLockMs: number | null;
  writerLeaseMs: number | null;
  connectionGuardMs: number | null;
}

export interface CoreHeartbeatDiagnostics {
  maximumAgeMs: number;
  heartbeatAgeMs: number;
  activeStage: CoreHeartbeatStage | null;
  activeStageElapsedMs: number | null;
  stageDurationsMs: CoreHeartbeatStageDurations;
  eventLoopDelayMaxMs: number;
  eventLoopDelayP99Ms: number;
}

export class CoreHeartbeatDeadlineError extends Error {
  constructor(
    maximumAgeMs: number,
    readonly diagnostics: Readonly<CoreHeartbeatDiagnostics>,
  ) {
    super(`Core writer heartbeat exceeded ${maximumAgeMs}ms maximum age`);
    this.name = "CoreHeartbeatDeadlineError";
  }
}

export interface CoreEventLoopDelayMonitor {
  enable(): void;
  disable(): void;
  reset(): void;
  maxMs(): number;
  percentileMs(percentile: number): number;
}

export interface CoreLifecycleResources {
  instanceLock: {
    assertHeld(): Promise<void>;
    release(): Promise<void>;
  };
  writerLease: {
    heartbeat(): unknown;
    release(): boolean;
  };
  writerGuard: {
    assertConnectionGuardCurrent(): void;
    removeConnectionGuard(): void;
  };
  stopBackground?: () => void | Promise<void>;
  closeRuntimes?: () => void | Promise<void>;
  closeStore: () => void;
  requestServerClose?: (failure: unknown) => void | Promise<void>;
  onFailure?: (failure: unknown) => void;
}

export interface CoreLifecycleOptions {
  heartbeatIntervalMs?: number;
  maxHeartbeatAgeMs?: number;
  clock?: () => number;
  timers?: CoreLifecycleTimers;
  eventLoopDelayMonitor?: CoreEventLoopDelayMonitor;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function duration(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.max(0, value) * 1_000) / 1_000;
}

function emptyStageDurations(): CoreHeartbeatStageDurations {
  return { instanceLockMs: null, writerLeaseMs: null, connectionGuardMs: null };
}

function createEventLoopDelayMonitor(): CoreEventLoopDelayMonitor {
  const histogram = monitorEventLoopDelay({ resolution: 20 });
  const nanosecondsToMilliseconds = (value: number) => duration(value / 1_000_000);
  return {
    enable: () => { histogram.enable(); },
    disable: () => { histogram.disable(); },
    reset: () => { histogram.reset(); },
    maxMs: () => nanosecondsToMilliseconds(histogram.max),
    percentileMs: (percentile) => nanosecondsToMilliseconds(histogram.percentile(percentile)),
  };
}

export class CoreLifecycle implements WriterReadiness {
  private phase: CoreLifecyclePhase = "starting";
  private writerReady = false;
  private lastFailure: unknown = null;
  private heartbeatTimer?: CoreLifecycleTimerHandle;
  private heartbeatDeadlineTimer?: CoreLifecycleTimerHandle;
  private heartbeatTask: Promise<void> | null = null;
  private startTask: Promise<void> | null = null;
  private closeTask: Promise<void> | null = null;
  private heartbeatStarted = false;
  private lastSuccessfulHeartbeatAt: number | null = null;
  private heartbeatAttemptStartedAt: number | null = null;
  private activeHeartbeatStage: CoreHeartbeatStage | null = null;
  private activeHeartbeatStageStartedAt: number | null = null;
  private currentStageDurations: CoreHeartbeatStageDurations = emptyStageDurations();
  private lastStageDurations: CoreHeartbeatStageDurations = emptyStageDurations();
  private eventLoopDelayMonitorStarted = false;

  private readonly heartbeatIntervalMs: number;
  private readonly maxHeartbeatAgeMs: number;
  private readonly clock: () => number;
  private readonly timers: CoreLifecycleTimers;
  private readonly eventLoopDelayMonitor: CoreEventLoopDelayMonitor;

  constructor(
    private readonly resources: CoreLifecycleResources,
    options: CoreLifecycleOptions = {},
  ) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? CORE_HEARTBEAT_INTERVAL_MS;
    this.maxHeartbeatAgeMs = options.maxHeartbeatAgeMs ?? CORE_HEARTBEAT_MAX_AGE_MS;
    this.clock = options.clock ?? (() => performance.now());
    this.timers = options.timers ?? defaultTimers;
    this.eventLoopDelayMonitor = options.eventLoopDelayMonitor ?? createEventLoopDelayMonitor();
    if (!Number.isSafeInteger(this.heartbeatIntervalMs) || this.heartbeatIntervalMs <= 0) {
      throw new TypeError("Core lifecycle heartbeatIntervalMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxHeartbeatAgeMs) || this.maxHeartbeatAgeMs <= 0) {
      throw new TypeError("Core lifecycle maxHeartbeatAgeMs must be a positive safe integer");
    }
    if (this.heartbeatIntervalMs >= this.maxHeartbeatAgeMs) {
      throw new TypeError("Core lifecycle heartbeatIntervalMs must be shorter than maxHeartbeatAgeMs");
    }
  }

  isWriterReady(): boolean {
    if (!this.writerReady) return false;
    if (this.heartbeatIsFresh()) return true;
    this.fail(this.heartbeatDeadlineError());
    return false;
  }

  snapshot(): CoreLifecycleSnapshot {
    return {
      phase: this.phase,
      writerReady: this.isWriterReady(),
      lastFailure: this.lastFailure === null ? null : message(this.lastFailure),
    };
  }

  heartbeatDiagnostics(): CoreHeartbeatDiagnostics {
    const now = this.clock();
    const reference = this.lastSuccessfulHeartbeatAt ?? this.heartbeatAttemptStartedAt ?? now;
    const activeStageElapsedMs = this.activeHeartbeatStageStartedAt === null
      ? null
      : duration(now - this.activeHeartbeatStageStartedAt);
    const stageDurations = this.heartbeatAttemptStartedAt === null
      ? this.lastStageDurations
      : this.currentStageDurations;
    return {
      maximumAgeMs: this.maxHeartbeatAgeMs,
      heartbeatAgeMs: duration(now - reference),
      activeStage: this.activeHeartbeatStage,
      activeStageElapsedMs,
      stageDurationsMs: { ...stageDurations },
      eventLoopDelayMaxMs: this.eventLoopDelayMonitor.maxMs(),
      eventLoopDelayP99Ms: this.eventLoopDelayMonitor.percentileMs(99),
    };
  }

  start(): Promise<void> {
    if (this.startTask) return this.startTask;
    if (this.phase !== "starting" || this.closeTask) {
      return Promise.reject(new Error(`Core lifecycle cannot start while ${this.phase}`));
    }
    if (!this.eventLoopDelayMonitorStarted) {
      this.eventLoopDelayMonitor.enable();
      this.eventLoopDelayMonitorStarted = true;
    }
    this.startTask = this.heartbeatNow().then(() => {
      if (this.closeTask) return;
      this.heartbeatTimer = this.timers.setInterval(() => {
        if (this.heartbeatTask) return;
        const task = this.heartbeatNow().catch(() => undefined).finally(() => {
          if (this.heartbeatTask === task) this.heartbeatTask = null;
        });
        this.heartbeatTask = task;
      }, this.heartbeatIntervalMs);
      this.unrefTimer(this.heartbeatTimer);
      this.heartbeatStarted = true;
    });
    return this.startTask;
  }

  markReady(): void {
    if (this.phase !== "starting" || !this.heartbeatStarted || this.closeTask || this.lastFailure !== null) {
      throw new Error(`Core lifecycle cannot become ready while ${this.phase}`);
    }
    if (!this.heartbeatIsFresh()) {
      const error = this.heartbeatDeadlineError();
      this.fail(error);
      throw error;
    }
    this.phase = "ready";
    this.writerReady = true;
  }

  async heartbeatNow(): Promise<void> {
    if (this.phase === "closed") throw new Error("Core lifecycle is closed");
    this.heartbeatAttemptStartedAt = this.clock();
    this.currentStageDurations = emptyStageDurations();
    try {
      await this.runAsyncHeartbeatStage("instance_lock", () => this.resources.instanceLock.assertHeld());
      this.runSyncHeartbeatStage("writer_lease", () => this.resources.writerLease.heartbeat());
      this.runSyncHeartbeatStage("connection_guard", () => this.resources.writerGuard.assertConnectionGuardCurrent());
      const completedAt = this.clock();
      const heartbeatReferenceAt = this.lastSuccessfulHeartbeatAt ?? this.heartbeatAttemptStartedAt;
      if (heartbeatReferenceAt !== null
        && completedAt - heartbeatReferenceAt >= this.maxHeartbeatAgeMs) {
        throw this.heartbeatDeadlineError();
      }
      if (this.phase === "starting" || this.phase === "ready") this.recordSuccessfulHeartbeat(completedAt);
    } catch (error) {
      if (this.closeTask || this.phase === "closing") throw error;
      this.fail(error);
      throw error;
    } finally {
      this.activeHeartbeatStage = null;
      this.activeHeartbeatStageStartedAt = null;
      this.heartbeatAttemptStartedAt = null;
    }
  }

  close(failure?: unknown): Promise<void> {
    if (failure !== undefined) this.noteFailure(failure);
    if (this.closeTask) return this.closeTask;
    this.writerReady = false;
    if (this.eventLoopDelayMonitorStarted) {
      this.eventLoopDelayMonitor.disable();
      this.eventLoopDelayMonitorStarted = false;
    }
    this.clearHeartbeatDeadline();
    if (this.phase !== "closed") this.phase = "closing";
    this.closeTask = this.performClose();
    return this.closeTask;
  }

  private fail(error: unknown): void {
    const firstFailure = this.lastFailure === null;
    const shutdownAlreadyStarted = this.closeTask !== null;
    this.noteFailure(error);
    if (!firstFailure) return;
    this.resources.onFailure?.(error);
    if (shutdownAlreadyStarted) return;
    if (!this.resources.requestServerClose) {
      void this.close(error).catch((closeError) => this.resources.onFailure?.(closeError));
      return;
    }
    void Promise.resolve(this.resources.requestServerClose(error)).catch((closeError) => {
      this.resources.onFailure?.(closeError);
      void this.close(error).catch((fallbackError) => this.resources.onFailure?.(fallbackError));
    });
  }

  private noteFailure(error: unknown): void {
    this.writerReady = false;
    if (this.lastFailure === null) this.lastFailure = error;
  }

  private heartbeatIsFresh(): boolean {
    if (this.lastSuccessfulHeartbeatAt === null) return false;
    const age = this.clock() - this.lastSuccessfulHeartbeatAt;
    return age >= 0 && age < this.maxHeartbeatAgeMs;
  }

  private heartbeatDeadlineError(): CoreHeartbeatDeadlineError {
    return new CoreHeartbeatDeadlineError(this.maxHeartbeatAgeMs, this.heartbeatDiagnostics());
  }

  private recordSuccessfulHeartbeat(completedAt = this.clock()): void {
    if (this.closeTask || this.lastFailure !== null) return;
    this.lastSuccessfulHeartbeatAt = completedAt;
    this.lastStageDurations = { ...this.currentStageDurations };
    this.eventLoopDelayMonitor.reset();
    this.armHeartbeatDeadline();
  }

  private async runAsyncHeartbeatStage(stage: CoreHeartbeatStage, operation: () => Promise<void>): Promise<void> {
    const startedAt = this.beginHeartbeatStage(stage);
    const task = Promise.resolve().then(operation);
    try {
      await this.awaitHeartbeatDeadline(task);
    } finally {
      this.finishHeartbeatStage(stage, startedAt);
    }
  }

  private runSyncHeartbeatStage(stage: CoreHeartbeatStage, operation: () => unknown): void {
    const startedAt = this.beginHeartbeatStage(stage);
    try {
      operation();
    } finally {
      this.finishHeartbeatStage(stage, startedAt);
    }
  }

  private beginHeartbeatStage(stage: CoreHeartbeatStage): number {
    const startedAt = this.clock();
    this.activeHeartbeatStage = stage;
    this.activeHeartbeatStageStartedAt = startedAt;
    return startedAt;
  }

  private finishHeartbeatStage(stage: CoreHeartbeatStage, startedAt: number): void {
    const elapsed = duration(this.clock() - startedAt);
    if (stage === "instance_lock") this.currentStageDurations.instanceLockMs = elapsed;
    else if (stage === "writer_lease") this.currentStageDurations.writerLeaseMs = elapsed;
    else this.currentStageDurations.connectionGuardMs = elapsed;
    if (this.activeHeartbeatStage === stage) {
      this.activeHeartbeatStage = null;
      this.activeHeartbeatStageStartedAt = null;
    }
  }

  private async awaitHeartbeatDeadline<T>(task: Promise<T>): Promise<T> {
    const now = this.clock();
    const reference = this.lastSuccessfulHeartbeatAt ?? this.heartbeatAttemptStartedAt ?? now;
    const remaining = this.maxHeartbeatAgeMs - (now - reference);
    if (remaining <= 0) throw this.heartbeatDeadlineError();
    let timer: CoreLifecycleTimerHandle | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = this.timers.setTimeout(() => reject(this.heartbeatDeadlineError()), remaining);
      this.unrefTimer(timer);
    });
    try {
      return await Promise.race([task, deadline]);
    } finally {
      if (timer) this.timers.clearTimeout(timer);
    }
  }

  private armHeartbeatDeadline(): void {
    this.clearHeartbeatDeadline();
    if (this.closeTask || this.phase === "closing" || this.phase === "closed" || this.lastSuccessfulHeartbeatAt === null) return;
    const remaining = this.maxHeartbeatAgeMs - (this.clock() - this.lastSuccessfulHeartbeatAt);
    if (remaining <= 0) {
      this.fail(this.heartbeatDeadlineError());
      return;
    }
    this.heartbeatDeadlineTimer = this.timers.setTimeout(() => {
      this.heartbeatDeadlineTimer = undefined;
      if (this.closeTask || this.phase === "closing" || this.phase === "closed") return;
      if (this.heartbeatIsFresh()) {
        this.armHeartbeatDeadline();
        return;
      }
      this.fail(this.heartbeatDeadlineError());
    }, remaining);
    this.unrefTimer(this.heartbeatDeadlineTimer);
  }

  private clearHeartbeatDeadline(): void {
    if (this.heartbeatDeadlineTimer) this.timers.clearTimeout(this.heartbeatDeadlineTimer);
    this.heartbeatDeadlineTimer = undefined;
  }

  private unrefTimer(handle: CoreLifecycleTimerHandle): void {
    (handle as CoreLifecycleTimerHandle & { unref?: () => void }).unref?.();
  }

  private async performClose(): Promise<void> {
    const errors: unknown[] = [];
    const attempt = async (operation: () => void | Promise<void>) => {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    };

    await attempt(async () => this.resources.closeRuntimes?.());
    await attempt(async () => this.resources.stopBackground?.());

    if (this.heartbeatTimer) this.timers.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.clearHeartbeatDeadline();
    const heartbeatTask = this.heartbeatTask;
    if (heartbeatTask) await attempt(async () => heartbeatTask);
    const startTask = this.startTask;
    if (startTask) await Promise.allSettled([startTask]);

    await attempt(() => this.resources.writerGuard.removeConnectionGuard());
    await attempt(() => {
      const released = this.resources.writerLease.release();
      if (!released && this.lastFailure === null) throw new Error("Core writer lease release was rejected");
    });
    await attempt(() => this.resources.closeStore());
    await attempt(() => this.resources.instanceLock.release());

    this.phase = "closed";
    this.writerReady = false;
    if (errors.length) throw new AggregateError(errors, "Core lifecycle close failed");
  }
}
