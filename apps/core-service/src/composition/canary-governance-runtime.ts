import type {
  CanaryGovernanceWorker,
  CanaryGovernanceWorkerResult,
} from "@tagent/governance/application";

export interface CanaryGovernanceRuntimeOptions {
  intervalMs: number;
  onError?: (error: unknown) => void;
}

/** Small polling host for the durable worker; at most one bounded unit runs at a time. */
export class CanaryGovernanceRuntime {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<CanaryGovernanceWorkerResult> | undefined;

  constructor(
    private readonly worker: CanaryGovernanceWorker,
    private readonly options: CanaryGovernanceRuntimeOptions,
  ) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
      throw new TypeError("Canary Governance runtime intervalMs must be a positive integer");
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.runInBackground(); }, this.options.intervalMs);
    this.timer.unref?.();
    this.runInBackground();
  }

  runOnce(): Promise<CanaryGovernanceWorkerResult> {
    if (this.inFlight) return this.inFlight;
    const running = Promise.resolve().then(() => this.worker.runOnce());
    const tracked = running.finally(() => {
      if (this.inFlight === tracked) this.inFlight = undefined;
    });
    this.inFlight = tracked;
    return tracked;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.inFlight;
  }

  close(): Promise<void> {
    return this.stop();
  }

  private runInBackground(): void {
    void this.runOnce().catch((error) => {
      try {
        this.options.onError?.(error);
      } catch {
        // A diagnostics hook must never turn a contained worker failure into an unhandled rejection.
      }
    });
  }
}
