import type { AccessContext } from "./types.js";
import type { MemoryCaptureWorker } from "./capture-worker.js";
import type { MemoryConsolidator } from "./consolidator.js";
import type { MemoryLifecycle } from "./lifecycle.js";
import type { ColdStorageReconciler } from "./reconciler.js";
import type { DurableReindexWorker } from "./reindex-worker.js";
import type { CoreMemorySnapshotService } from "./core-snapshot.js";
import type { BlobStorePort, OperationsStatePort, RecordStorePort } from "./ports.js";
import type { MemoryHistoryBackfillPort } from "./history-backfill.js";

type MemoryWorkerState = "idle" | "running" | "stopping" | "closed";

export class LocalMemoryWorker {
  private state: MemoryWorkerState = "idle";
  private captureTimer?: ReturnType<typeof setInterval>;
  private maintenanceTimer?: ReturnType<typeof setInterval>;
  private captureTask?: Promise<boolean>;
  private maintenanceTask?: Promise<boolean>;
  private readonly inFlight = new Set<Promise<unknown>>();
  private stopTask?: Promise<void>;

  constructor(
    private readonly capture: MemoryCaptureWorker,
    private readonly lifecycle: MemoryLifecycle,
    private readonly consolidator: MemoryConsolidator,
    private readonly reconciler: ColdStorageReconciler,
    private readonly access: AccessContext,
    private readonly captureIntervalMs: number,
    private readonly maintenanceIntervalMs: number,
    private readonly onHeartbeat?: () => void | Promise<void>,
    private readonly onConsolidation?: () => void,
    private readonly reindex?: DurableReindexWorker,
    private readonly core?: CoreMemorySnapshotService,
    private readonly operations?: OperationsStatePort,
    private readonly blobs?: BlobStorePort,
    private readonly records?: RecordStorePort,
    private readonly backfill?: MemoryHistoryBackfillPort,
  ) {}

  start(): void {
    if (this.state === "running" || this.state === "stopping" || this.state === "closed") return;
    this.state = "running";
    this.captureTimer = setInterval(() => this.scheduleCapture(), this.captureIntervalMs);
    this.maintenanceTimer = setInterval(() => this.scheduleMaintenance(), this.maintenanceIntervalMs);
    this.captureTimer.unref?.();
    this.maintenanceTimer.unref?.();
    this.scheduleCapture();
    this.scheduleMaintenance();
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.state = "stopping";
    if (this.captureTimer) clearInterval(this.captureTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.captureTimer = undefined;
    this.maintenanceTimer = undefined;
    this.stopTask = this.drainInFlight();
    return this.stopTask;
  }

  captureTick(): Promise<boolean> {
    if (!this.acceptsWork() || this.captureTask) return Promise.resolve(false);
    const task = this.runCaptureTick();
    this.captureTask = task;
    this.track(task, () => {
      if (this.captureTask === task) this.captureTask = undefined;
    });
    return task;
  }

  maintenanceTick(): Promise<boolean> {
    if (!this.acceptsWork() || this.maintenanceTask) return Promise.resolve(false);
    const task = this.runMaintenanceTick();
    this.maintenanceTask = task;
    this.track(task, () => {
      if (this.maintenanceTask === task) this.maintenanceTask = undefined;
    });
    return task;
  }

  private acceptsWork(): boolean {
    return this.state === "idle" || this.state === "running";
  }

  private scheduleCapture(): void {
    if (!this.acceptsWork() || this.captureTask) return;
    void this.captureTick().catch((error) => {
      console.error("Memory capture tick failed", error);
    });
  }

  private scheduleMaintenance(): void {
    if (!this.acceptsWork() || this.maintenanceTask) return;
    void this.maintenanceTick().catch((error) => {
      console.error("Memory maintenance tick failed", error);
    });
  }

  private async drainInFlight(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
    this.state = "closed";
  }

  private track<T>(task: Promise<T>, onSettled?: () => void): Promise<T> {
    this.inFlight.add(task);
    const settled = () => {
      this.inFlight.delete(task);
      onSettled?.();
    };
    void task.then(settled, settled);
    return task;
  }

  private trackHeartbeat(): void {
    if (!this.onHeartbeat || !this.acceptsWork()) return;
    let task: Promise<void>;
    try {
      task = Promise.resolve(this.onHeartbeat());
    } catch (error) {
      console.error("Memory heartbeat failed", error);
      return;
    }
    this.track(task);
    void task.catch((error) => {
      console.error("Memory heartbeat failed", error);
    });
  }

  private async runCaptureTick(): Promise<boolean> {
    this.trackHeartbeat();
    const started = Date.now();
    try {
      const backfilled = await this.backfill?.runOnce() ?? false;
      let count = 0;
      while (count < 20 && await this.capture.runOnce()) count += 1;
      await this.operations?.recordMetric(this.access.scopes[0], "capture_total", count, Date.now());
      await this.operations?.recordMetric(
        this.access.scopes[0],
        count ? "capture_active_poll_total" : "capture_idle_poll_total",
        1,
        Date.now(),
      );
      await this.operations?.recordMetric(this.access.scopes[0], "capture_latency_ms", Date.now() - started, Date.now());
      await this.reindex?.runOnce().catch(async (error) => {
        await this.operations?.recordDegraded(this.access.scopes[0], `reindex:${String(error)}`, Date.now());
      });
      return backfilled || count > 0;
    } catch (error) {
      await this.operations?.recordMetric(this.access.scopes[0], "capture_error", 1, Date.now());
      throw error;
    }
  }

  private async runMaintenanceTick(): Promise<boolean> {
    this.trackHeartbeat();
    const started = Date.now();
    try {
      const scopes = uniqueScopes([...(await this.records?.listScopes?.() ?? []), ...this.access.scopes]);
      for (const scope of scopes) {
        const scopedAccess = { ...this.access, scopes: [scope] };
        const promoted = await this.lifecycle.promote(scopedAccess);
        const batch = this.lifecycle.topicCandidateBatch
          ? await this.lifecycle.topicCandidateBatch(scopedAccess)
          : { topics: await this.lifecycle.topicCandidates(scopedAccess), evidence: undefined };
        const candidates = batch.topics;
        for (const topic of candidates.slice(0, 20)) {
          await this.consolidator.consolidate(
            scopedAccess,
            topic.topicId,
            batch.evidence
              ? { descriptor: topic, records: batch.evidence.get(topic.topicId) ?? [] }
              : undefined,
          );
        }
        await this.reconciler.verify(scopedAccess, candidates.map((candidate) => candidate.topicId));
        await this.reconciler.purgeExpired?.(scopedAccess);
        if ((promoted?.updated ?? 0) > 0) await this.core?.generate(scopedAccess);
      }
      await this.reconciler.cleanupStaged();
      this.onConsolidation?.();
      await this.operations?.recordMetric(this.access.scopes[0], "consolidation_total", 1, Date.now());
      await this.operations?.recordMetric(
        this.access.scopes[0],
        "consolidation_latency_ms",
        Date.now() - started,
        Date.now(),
      );
      return true;
    } catch (error) {
      await this.operations?.recordMetric(this.access.scopes[0], "consolidation_error", 1, Date.now());
      throw error;
    }
  }
}

function uniqueScopes(scopes:AccessContext["scopes"]){return[...new Map(scopes.map((scope)=>[`${scope.type}:${scope.id}`,scope])).values()];}
