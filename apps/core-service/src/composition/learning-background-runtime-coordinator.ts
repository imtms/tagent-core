export interface LearningBackgroundRuntime {
  readonly name: string;
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

/** Serializes feature-policy transitions and continuously converges to the latest state. */
export class LearningBackgroundRuntimeCoordinator {
  private readonly running = new Map<string, boolean>();
  private desiredEnabled = false;
  private closed = false;
  private tail = Promise.resolve();

  constructor(
    private readonly startOrder: readonly LearningBackgroundRuntime[],
    private readonly stopOrder: readonly LearningBackgroundRuntime[],
  ) {
    const startNames = startOrder.map(({ name }) => name);
    const stopNames = stopOrder.map(({ name }) => name);
    if (new Set(startNames).size !== startNames.length
      || startNames.length !== stopNames.length
      || startNames.some((name) => !stopNames.includes(name))) {
      throw new TypeError("Learning background runtime orders must contain the same unique names");
    }
    for (const name of startNames) this.running.set(name, false);
  }

  reconcile(enabled: boolean): Promise<void> {
    if (enabled && this.closed) {
      return Promise.reject(new Error("Learning background runtime coordinator is closed"));
    }
    this.desiredEnabled = enabled;
    const scheduled = this.tail.catch(() => undefined).then(() => this.converge());
    this.tail = scheduled;
    return scheduled;
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.reconcile(false);
  }

  private async converge(): Promise<void> {
    for (;;) {
      const target = this.desiredEnabled;
      const order = target ? this.startOrder : this.stopOrder;
      for (const runtime of order) {
        if (this.desiredEnabled !== target) break;
        if (this.running.get(runtime.name) === target) continue;
        if (target) await runtime.start();
        else await runtime.stop();
        this.running.set(runtime.name, target);
        if (this.desiredEnabled !== target) break;
      }
      if ([...this.running.values()].every((running) => running === this.desiredEnabled)) return;
    }
  }
}
