import { randomUUID } from "node:crypto";
import type { WorkflowService } from "./workflow-service.js";

export interface DistillationWorkerStatus {
  running: boolean;
  ready: boolean;
  owner: string;
  startedAt: number;
  lastPollAt: number;
  lastSuccessAt: number;
  lastErrorAt: number;
  lastError: string;
  processed: number;
  failures: number;
}

export class DistillationWorker {
  private timer?: ReturnType<typeof setInterval>;
  private polling = false;
  private readonly status: DistillationWorkerStatus;

  constructor(private readonly workflows: WorkflowService, private readonly intervalMs = 1_000, owner = `distiller-worker:${randomUUID()}`) {
    this.status = { running: false, ready: false, owner, startedAt: 0, lastPollAt: 0, lastSuccessAt: 0, lastErrorAt: 0, lastError: "", processed: 0, failures: 0 };
  }

  start() {
    if (this.timer) return;
    this.status.running = true; this.status.ready = true; this.status.startedAt = Date.now();
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.intervalMs); this.timer.unref?.();
  }

  private async poll() {
    if (this.polling || !this.status.running) return;
    this.polling = true; this.status.lastPollAt = Date.now();
    try {
      const result = this.workflows.runNextDistillationJob(this.status.owner);
      if (result !== undefined) { this.status.processed += 1; this.status.lastSuccessAt = Date.now(); }
      this.status.lastError = ""; this.status.ready = true;
    } catch (error) {
      this.status.failures += 1; this.status.lastErrorAt = Date.now(); this.status.lastError = error instanceof Error ? error.message : String(error);
    } finally { this.polling = false; }
  }

  snapshot() { return { ...this.status, metrics: this.workflows.getDistillationMetrics() }; }
  async stop() { this.status.running = false; this.status.ready = false; if (this.timer) clearInterval(this.timer); this.timer = undefined; while (this.polling) await new Promise((resolve) => setTimeout(resolve, 5)); }
  async close() { await this.stop(); }
}
