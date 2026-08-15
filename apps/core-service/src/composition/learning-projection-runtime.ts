interface LearningProjectionTickResult {
  kind: string;
}

export interface LearningProjectionWorker {
  runOnce(timestamp?: number): LearningProjectionTickResult | Promise<LearningProjectionTickResult>;
}

export interface LearningProjectionRuntimeOptions {
  intervalMs: number;
  maxItemsPerTick?: number;
  clock?: () => number;
  afterApplied?: () => void | Promise<void>;
  reportFailure?: (error: unknown) => void;
}

const DEFAULT_MAX_ITEMS_PER_TICK = 32;

/** Polls the sole durable Learning consumer and drains each available contiguous batch. */
export class LearningProjectionRuntime {
  private readonly maxItemsPerTick: number;
  private readonly clock: () => number;
  private readonly reportFailure: NonNullable<LearningProjectionRuntimeOptions["reportFailure"]>;
  private timer?: ReturnType<typeof setInterval>;
  private inFlight?: Promise<void>;
  private running = false;

  constructor(
    private readonly worker: LearningProjectionWorker,
    private readonly options: LearningProjectionRuntimeOptions,
  ) {
    assertPositiveInteger(options.intervalMs, "intervalMs");
    this.maxItemsPerTick = options.maxItemsPerTick ?? DEFAULT_MAX_ITEMS_PER_TICK;
    assertPositiveInteger(this.maxItemsPerTick, "maxItemsPerTick");
    this.clock = options.clock ?? Date.now;
    this.reportFailure = options.reportFailure
      ?? ((error) => console.error("Learning projection tick failed", error));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer = setInterval(() => this.poll(), this.options.intervalMs);
    this.timer.unref?.();
    this.poll();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  async close(): Promise<void> {
    await this.stop();
  }

  private poll(): void {
    if (!this.running || this.inFlight) return;
    const current = this.drain()
      .catch((error) => this.report(error))
      .finally(() => {
        if (this.inFlight === current) this.inFlight = undefined;
      });
    this.inFlight = current;
  }

  private async drain(): Promise<void> {
    for (let index = 0; index < this.maxItemsPerTick && this.running; index += 1) {
      const result = await this.worker.runOnce(this.clock());
      if (!this.running) return;
      if (result.kind === "failed") this.report(result);
      if (result.kind !== "applied" && result.kind !== "replayed") return;
      if (result.kind === "applied") await this.options.afterApplied?.();
    }
  }

  private report(error: unknown): void {
    try {
      this.reportFailure(error);
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
