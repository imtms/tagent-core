import type { GenerationMaintenanceRepository } from "@tagent/execution/ports";
import type { AdditionalToolProviderFactory } from "./runtime-host-adapter.js";
import { CoreGenerationMaintenanceToolProvider } from "./core-generation-maintenance-tool.js";
import type { GenerationHostBridge } from "./generation-host-bridge.js";
import { GenerationMaintenanceCoordinator } from "./generation-maintenance-coordinator.js";

const DEFAULT_PARENT_DISCONNECT_GRACE_MS = 30_000;
const DEFAULT_HOST_HEARTBEAT_INTERVAL_MS = 2_000;

export interface ManagedGenerationAdapterOptions {
  persistence: GenerationMaintenanceRepository;
  bridge: GenerationHostBridge;
  terminate?: () => void;
  parentDisconnectGraceMs?: number;
  hostHeartbeatIntervalMs?: number;
  logger?: Pick<Console, "error">;
}

/**
 * The sole Generation-side integration point for the external Core Host.
 * Domain services and the Generation bootstrap depend only on its small
 * lifecycle/tool extension surface, never on Host supervision internals.
 */
export class ManagedGenerationAdapter {
  readonly coordinator: GenerationMaintenanceCoordinator;
  private readonly bridge: GenerationHostBridge;
  private readonly terminateProcess?: () => void;
  private readonly parentDisconnectGraceMs: number;
  private readonly logger: Pick<Console, "error">;
  private readonly hostHeartbeatIntervalMs: number;
  private terminationRequested = false;
  private parentDisconnected = false;
  private parentDisconnectFailStop?: ReturnType<typeof setTimeout>;
  private parentDisconnectCloseTask?: Promise<void>;
  private closeGeneration?: () => Promise<void>;
  private hostHeartbeat?: ReturnType<typeof setInterval>;
  private hostHeartbeatSequence = 0;

  constructor(options: ManagedGenerationAdapterOptions) {
    this.bridge = options.bridge;
    this.terminateProcess = options.terminate;
    this.parentDisconnectGraceMs = options.parentDisconnectGraceMs ?? DEFAULT_PARENT_DISCONNECT_GRACE_MS;
    this.hostHeartbeatIntervalMs = options.hostHeartbeatIntervalMs ?? DEFAULT_HOST_HEARTBEAT_INTERVAL_MS;
    this.logger = options.logger ?? console;
    if (!Number.isSafeInteger(this.parentDisconnectGraceMs) || this.parentDisconnectGraceMs <= 0) {
      throw new TypeError("Managed Generation parentDisconnectGraceMs must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.hostHeartbeatIntervalMs) || this.hostHeartbeatIntervalMs <= 0) {
      throw new TypeError("Managed Generation hostHeartbeatIntervalMs must be a positive safe integer");
    }
    this.coordinator = new GenerationMaintenanceCoordinator(options.persistence, this.bridge);
    this.bridge.onActivationResult((result) => this.handleActivationResult(result));
    if (this.bridge.managed) this.bridge.onParentDisconnect(() => this.handleParentDisconnect());
  }

  get defersInitialRecovery(): boolean {
    return this.bridge.activationRequestId !== null || this.coordinator.hasPendingActivation();
  }

  toolProviderFactory(): AdditionalToolProviderFactory {
    return (capabilities) => [new CoreGenerationMaintenanceToolProvider(
      capabilities,
      this.bridge,
      this.coordinator,
    )];
  }

  bindRecovery(recover: () => void): void {
    this.coordinator.bindRecovery(recover);
  }

  hostStatus(): ReturnType<GenerationHostBridge["hostStatus"]> {
    return this.bridge.hostStatus();
  }

  prepareHandoffBeforeWriterRelease(): void {
    this.coordinator.prepareHandoffBeforeWriterRelease();
  }

  announceReady(closeGeneration: () => Promise<void>, writerFence: number): void {
    if (!this.bridge.managed) return;
    this.closeGeneration = closeGeneration;
    this.bridge.onDrain(async ({ requestId }) => {
      this.stopHostHeartbeat();
      this.coordinator.beginDrain(requestId);
      try {
        await closeGeneration();
        await this.bridge.drained(requestId, writerFence);
        this.terminate();
      } catch (error) {
        this.logger.error("TAgent Core Generation drain failed", error);
      }
    });
    if (this.parentDisconnected) {
      void this.closeAfterParentDisconnect();
      return;
    }
    this.bridge.ready(writerFence);
    this.hostHeartbeat = setInterval(() => {
      try {
        this.hostHeartbeatSequence += 1;
        this.bridge.heartbeat(writerFence, this.hostHeartbeatSequence);
      } catch (error) {
        this.logger.error("TAgent Core Generation heartbeat delivery failed", error);
        this.handleParentDisconnect();
      }
    }, this.hostHeartbeatIntervalMs);
    this.hostHeartbeat.unref?.();
    setImmediate(() => this.coordinator.redispatchPending());
  }

  private handleParentDisconnect(): void {
    if (this.parentDisconnected) return;
    this.parentDisconnected = true;
    this.stopHostHeartbeat();
    this.parentDisconnectFailStop = setTimeout(() => this.terminate(), this.parentDisconnectGraceMs);
    this.parentDisconnectFailStop.unref?.();
    if (this.closeGeneration) void this.closeAfterParentDisconnect();
  }

  private closeAfterParentDisconnect(): Promise<void> {
    if (this.parentDisconnectCloseTask) return this.parentDisconnectCloseTask;
    this.parentDisconnectCloseTask = (async () => {
      try {
        await this.closeGeneration?.();
      } catch (error) {
        this.logger.error("TAgent Core Generation parent-disconnect close failed", error);
      } finally {
        if (this.parentDisconnectFailStop) clearTimeout(this.parentDisconnectFailStop);
        this.parentDisconnectFailStop = undefined;
        this.terminate();
      }
    })();
    return this.parentDisconnectCloseTask;
  }

  private async handleActivationResult(result: Parameters<GenerationMaintenanceCoordinator["activationResult"]>[0]): Promise<void> {
    try {
      this.coordinator.activationResult(result);
    } catch (error) {
      // A terminal result is the ordering barrier for Continuation recovery.
      // If it cannot be durably reconciled, stop serving and let the Host
      // restart this Generation so the durable Host result can be replayed.
      this.logger.error("TAgent Core Generation activation result reconciliation failed", error);
      const failStop = setTimeout(() => this.terminate(), this.parentDisconnectGraceMs);
      failStop.unref?.();
      try {
        await this.closeGeneration?.();
      } catch (closeError) {
        this.logger.error("TAgent Core Generation close after activation result failure failed", closeError);
      } finally {
        clearTimeout(failStop);
        this.terminate();
      }
    }
  }

  private terminate(): void {
    if (this.terminationRequested) return;
    this.terminationRequested = true;
    this.stopHostHeartbeat();
    this.terminateProcess?.();
  }

  private stopHostHeartbeat(): void {
    if (this.hostHeartbeat) clearInterval(this.hostHeartbeat);
    this.hostHeartbeat = undefined;
  }
}
