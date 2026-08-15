import type {
  GenerationActivationRequest,
  GenerationActivationResult,
  GenerationMaintenanceRepository,
} from "@tagent/execution/ports";
import type { GenerationHostBridge } from "./generation-host-bridge.js";

export class GenerationMaintenanceCoordinator {
  private drainRequestId: string | null = null;
  private dispatchedRequestId: string | null;
  private recover?: () => void;

  constructor(
    private readonly persistence: GenerationMaintenanceRepository,
    private readonly bridge: GenerationHostBridge,
  ) {
    // A candidate carrying this identity is still inside the Host activation
    // barrier until ACTIVATION_RESULT arrives. Do not let its READY-time
    // reconciliation race a second durable request into a busy Host.
    this.dispatchedRequestId = bridge.activationRequestId;
  }

  bindRecovery(recover: () => void): void { this.recover = recover; }

  hasPendingActivation(): boolean {
    return this.persistence.listPendingGenerationActivations().length > 0;
  }

  accept(request: GenerationActivationRequest): void {
    if (!this.bridge.activationAvailable) {
      throw new Error("Core Generation activation requires a managed immutable release");
    }
    const pending = this.persistence.listPendingGenerationActivations()
      .find((item) => item.requestId === request.requestId);
    if (!pending || JSON.stringify(pending) !== JSON.stringify(request)) {
      throw new Error(`Generation activation ${request.requestId} is not durably accepted`);
    }
    if (this.dispatchedRequestId) return;
    this.dispatch(request);
  }

  redispatchPending(): void {
    if (!this.bridge.activationAvailable || this.dispatchedRequestId) return;
    const request = this.persistence.listPendingGenerationActivations()
      .find((item) => item.requestId !== this.bridge.activationRequestId);
    if (request) this.dispatch(request);
  }

  beginDrain(requestId: string): void { this.drainRequestId = requestId; }

  prepareHandoffBeforeWriterRelease(): void {
    if (!this.drainRequestId) return;
    const request = this.persistence.listPendingGenerationActivations()
      .find((item) => item.requestId === this.drainRequestId);
    if (!request) throw new Error(`Generation activation ${this.drainRequestId} is not pending during drain`);
    this.persistence.prepareGenerationHandoff(request);
  }

  activationResult(result: GenerationActivationResult): void {
    const request = this.persistence.listPendingGenerationActivations()
      .find((item) => item.requestId === result.requestId);
    if (request) this.persistence.prepareGenerationHandoff(request);
    const recorded = this.persistence.recordGenerationActivationResult(result);
    if (this.dispatchedRequestId === result.requestId) this.dispatchedRequestId = null;
    if (recorded || this.bridge.activationRequestId === result.requestId) {
      this.recover?.();
      setImmediate(() => this.redispatchPending());
    }
  }

  private dispatch(request: GenerationActivationRequest): void {
    this.dispatchedRequestId = request.requestId;
    try {
      this.bridge.activate(request);
    } catch (error) {
      this.dispatchedRequestId = null;
      throw error;
    }
  }
}
