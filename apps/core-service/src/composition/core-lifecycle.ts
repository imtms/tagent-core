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
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

  private readonly heartbeatIntervalMs: number;
  private readonly maxHeartbeatAgeMs: number;
  private readonly clock: () => number;
  private readonly timers: CoreLifecycleTimers;

  constructor(
    private readonly resources: CoreLifecycleResources,
    options: CoreLifecycleOptions = {},
  ) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? CORE_HEARTBEAT_INTERVAL_MS;
    this.maxHeartbeatAgeMs = options.maxHeartbeatAgeMs ?? CORE_HEARTBEAT_MAX_AGE_MS;
    this.clock = options.clock ?? (() => performance.now());
    this.timers = options.timers ?? defaultTimers;
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

  start(): Promise<void> {
    if (this.startTask) return this.startTask;
    if (this.phase !== "starting" || this.closeTask) {
      return Promise.reject(new Error(`Core lifecycle cannot start while ${this.phase}`));
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
    try {
      await this.resources.instanceLock.assertHeld();
      this.resources.writerLease.heartbeat();
      this.resources.writerGuard.assertConnectionGuardCurrent();
      if (this.phase === "starting" || this.phase === "ready") this.recordSuccessfulHeartbeat();
    } catch (error) {
      if (this.closeTask || this.phase === "closing") throw error;
      this.fail(error);
      throw error;
    }
  }

  close(failure?: unknown): Promise<void> {
    if (failure !== undefined) this.noteFailure(failure);
    if (this.closeTask) return this.closeTask;
    this.writerReady = false;
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

  private heartbeatDeadlineError(): Error {
    return new Error(`Core writer heartbeat exceeded ${this.maxHeartbeatAgeMs}ms maximum age`);
  }

  private recordSuccessfulHeartbeat(): void {
    if (this.closeTask || this.lastFailure !== null) return;
    this.lastSuccessfulHeartbeatAt = this.clock();
    this.armHeartbeatDeadline();
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

    await attempt(async () => this.resources.stopBackground?.());
    await attempt(async () => this.resources.closeRuntimes?.());

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
