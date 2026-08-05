export interface LearningProjectionTickResult {
  kind: string;
}

export interface LearningProjectionWorker {
  runOnce(timestamp?: number): LearningProjectionTickResult | Promise<LearningProjectionTickResult>;
}

export interface ActiveLearningProjectionRuntimeWorker extends LearningProjectionWorker {
  renewAuthority(timestamp?: number): unknown | Promise<unknown>;
  pause(): void;
  resume(): void;
  releaseAuthority(): unknown | Promise<unknown>;
}

export interface LearningProjectionRuntimeCoordinator {
  cutover(timestamp?: number): unknown;
  rollback(timestamp?: number): unknown;
}

export interface LearningProjectionRuntimeWorkers {
  shadow: LearningProjectionWorker;
  active: ActiveLearningProjectionRuntimeWorker;
  coordinator: LearningProjectionRuntimeCoordinator;
}

export interface LearningProjectionRuntimeOptions {
  intervalMs: number;
  authorityHeartbeatMs?: number;
  maxItemsPerTick?: number;
  clock?: () => number;
  reportFailure?: (lane: "shadow" | "active" | "authority", error: unknown) => void;
}

const DEFAULT_MAX_ITEMS_PER_TICK = 32;
const ACTIVE_PROGRESS = new Set(["applied", "adopted", "replayed"]);

export class LearningProjectionRuntime {
  private readonly maxItemsPerTick: number;
  private readonly authorityHeartbeatMs: number;
  private readonly clock: () => number;
  private readonly reportFailure: NonNullable<LearningProjectionRuntimeOptions["reportFailure"]>;
  private shadowTimer?: ReturnType<typeof setInterval>;
  private activeTimer?: ReturnType<typeof setInterval>;
  private authorityHeartbeat?: ReturnType<typeof setInterval>;
  private shadowInFlight?: Promise<void>;
  private activeInFlight?: Promise<void>;
  private authorityRenewal?: Promise<void>;
  private authorityTransition?: Promise<unknown>;
  private shadowScheduled = false;
  private activeScheduled = false;
  private running = false;

  constructor(
    private readonly workers: LearningProjectionRuntimeWorkers,
    private readonly options: LearningProjectionRuntimeOptions,
  ) {
    assertPositiveInteger(options.intervalMs, "intervalMs");
    const maxItemsPerTick = options.maxItemsPerTick ?? DEFAULT_MAX_ITEMS_PER_TICK;
    assertPositiveInteger(maxItemsPerTick, "maxItemsPerTick");
    const authorityHeartbeatMs = options.authorityHeartbeatMs
      ?? Math.max(1, Math.floor(options.intervalMs / 3));
    assertPositiveInteger(authorityHeartbeatMs, "authorityHeartbeatMs");
    this.maxItemsPerTick = maxItemsPerTick;
    this.authorityHeartbeatMs = authorityHeartbeatMs;
    this.clock = options.clock ?? Date.now;
    this.reportFailure = options.reportFailure
      ?? ((lane, error) => console.error(`Learning projection ${lane} tick failed`, error));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startShadowLoop();
    this.resumeActiveLoop();
  }

  async stop(): Promise<void> {
    const releaseAuthority = this.running;
    this.running = false;
    this.stopShadowLoop();
    await this.pauseActiveLoop();
    await Promise.allSettled([
      this.shadowInFlight,
      this.authorityTransition,
    ].filter((task): task is Promise<unknown> => Boolean(task)));
    if (releaseAuthority) await this.workers.active.releaseAuthority();
  }

  async close(): Promise<void> {
    await this.stop();
  }

  cutover(timestamp = this.clock()): Promise<unknown> {
    return this.transitionAuthority(() => this.workers.coordinator.cutover(timestamp));
  }

  rollback(timestamp = this.clock()): Promise<unknown> {
    return this.transitionAuthority(() => this.workers.coordinator.rollback(timestamp));
  }

  private startShadowLoop(): void {
    if (!this.running || this.shadowScheduled) return;
    this.shadowScheduled = true;
    this.shadowTimer = setInterval(() => this.pollShadow(), this.options.intervalMs);
    this.shadowTimer.unref?.();
    this.pollShadow();
  }

  private stopShadowLoop(): void {
    this.shadowScheduled = false;
    if (this.shadowTimer) clearInterval(this.shadowTimer);
    this.shadowTimer = undefined;
  }

  private resumeActiveLoop(): void {
    if (!this.running || this.activeScheduled) return;
    this.workers.active.resume();
    this.activeScheduled = true;
    this.activeTimer = setInterval(() => this.pollActive(), this.options.intervalMs);
    this.authorityHeartbeat = setInterval(() => this.renewAuthority(), this.authorityHeartbeatMs);
    this.activeTimer.unref?.();
    this.authorityHeartbeat.unref?.();
    this.pollActive();
  }

  private async pauseActiveLoop(): Promise<void> {
    this.activeScheduled = false;
    this.workers.active.pause();
    if (this.activeTimer) clearInterval(this.activeTimer);
    if (this.authorityHeartbeat) clearInterval(this.authorityHeartbeat);
    this.activeTimer = undefined;
    this.authorityHeartbeat = undefined;
    await Promise.all([this.activeInFlight, this.authorityRenewal]);
  }

  private pollShadow(): void {
    if (!this.running || !this.shadowScheduled || this.shadowInFlight) return;
    const current = this.drain(
      this.workers.shadow,
      () => this.running && this.shadowScheduled,
      (result) => {
        if (result.kind === "blocked") this.report("shadow", result);
        return result.kind === "matched";
      },
    ).catch((error) => this.report("shadow", error)).finally(() => {
      if (this.shadowInFlight === current) this.shadowInFlight = undefined;
    });
    this.shadowInFlight = current;
  }

  private pollActive(): void {
    if (!this.running || !this.activeScheduled || this.activeInFlight || this.authorityRenewal) return;
    const current = this.drain(
      this.workers.active,
      () => this.running && this.activeScheduled,
      (result) => {
        if (result.kind === "failed") this.report("active", result);
        return ACTIVE_PROGRESS.has(result.kind);
      },
    ).catch((error) => this.report("active", error)).finally(() => {
      if (this.activeInFlight === current) this.activeInFlight = undefined;
    });
    this.activeInFlight = current;
  }

  private renewAuthority(): void {
    if (!this.running || !this.activeScheduled || this.activeInFlight
      || this.authorityRenewal || this.authorityTransition) return;
    const current = Promise.resolve()
      .then(() => this.workers.active.renewAuthority(this.clock()))
      .then(() => undefined)
      .catch((error) => this.report("authority", error))
      .finally(() => {
        if (this.authorityRenewal === current) this.authorityRenewal = undefined;
      });
    this.authorityRenewal = current;
  }

  private transitionAuthority(operation: () => unknown): Promise<unknown> {
    if (!this.running) return Promise.reject(new Error("Learning projection runtime is not running"));
    if (this.authorityTransition) {
      return Promise.reject(new Error("Learning projection authority transition is already in progress"));
    }
    const current = (async () => {
      await this.pauseActiveLoop();
      if (!this.running) throw new Error("Learning projection runtime stopped during authority transition");
      const result = operation();
      if (allowsActiveResume(result)) this.resumeActiveLoop();
      return result;
    })().finally(() => {
      if (this.authorityTransition === current) this.authorityTransition = undefined;
    });
    this.authorityTransition = current;
    return current;
  }

  private async drain(
    worker: LearningProjectionWorker,
    scheduled: () => boolean,
    madeProgress: (result: LearningProjectionTickResult) => boolean,
  ): Promise<void> {
    for (let index = 0; index < this.maxItemsPerTick && scheduled(); index += 1) {
      const result = await worker.runOnce(this.clock());
      if (!scheduled() || !madeProgress(result)) return;
    }
  }

  private report(lane: "shadow" | "active" | "authority", error: unknown): void {
    try {
      this.reportFailure(lane, error);
    } catch (reportingError) {
      console.error("Learning projection failure reporting failed", reportingError);
    }
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Learning projection runtime ${field} must be a positive safe integer`);
  }
}

function allowsActiveResume(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const transition = result as { kind?: unknown; phase?: unknown };
  return transition.kind === "activated"
    || (transition.kind === "blocked" && transition.phase === "prepare");
}
