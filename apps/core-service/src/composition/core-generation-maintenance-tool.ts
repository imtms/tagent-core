import type { ToolProvider } from "@tagent/execution/composition";
import {
  GENERATION_ACTIVATION_OPERATION,
  type GenerationActivationRequest,
  type RuntimeTool,
} from "@tagent/execution/ports";
import type { ToolCapabilityApplicationPort as ToolCapabilities } from "@tagent/execution/ports";
import type { GenerationMaintenanceCoordinator } from "./generation-maintenance-coordinator.js";
import type { GenerationHostBridge } from "./generation-host-bridge.js";

interface ActivationParameters {
  targetRelease: string;
  reason?: string;
}

const ActivationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["targetRelease"],
  properties: {
    targetRelease: { type: "string", minLength: 1, maxLength: 40 },
    reason: { type: "string", maxLength: 2_000 },
  },
} as const;

export class CoreGenerationMaintenanceToolProvider implements ToolProvider {
  readonly id = "core.generation.maintenance";

  constructor(
    private readonly capabilities: ToolCapabilities,
    private readonly bridge: GenerationHostBridge,
    private readonly coordinator: GenerationMaintenanceCoordinator,
  ) {}

  provideTools(): readonly RuntimeTool[] {
    if (!this.bridge.activationAvailable) return [];
    const tool: RuntimeTool<ActivationParameters, Record<string, unknown>> = {
      name: "core_generation_activate",
      label: "Activate Core Generation",
      description: "Restart the current Core Generation or activate one already installed immutable release. The accepted request is handed off durably; never call systemctl or a deployment script for this action.",
      parameters: ActivationSchema,
      executionMode: "sequential",
      policy: {
        operationType: GENERATION_ACTIVATION_OPERATION,
        workspaceAccess: "none",
        invalidatesChecks: false,
        externalAction: "explicit",
      },
      execute: (toolCallId, parameters, signal) => this.execute(toolCallId, parameters, signal),
      onOperationSettled: (toolCallId, parameters) => this.onOperationSettled(toolCallId, parameters),
    };
    return [tool];
  }

  private async execute(toolCallId: string, parameters: ActivationParameters, signal: AbortSignal) {
    signal.throwIfAborted();
    const targetRelease = parameters.targetRelease.trim();
    if (targetRelease !== "current" && !/^[0-9a-f]{40}$/.test(targetRelease)) {
      throw new Error("targetRelease must be current or a full lowercase Git commit");
    }
    const request = this.request(toolCallId, parameters, targetRelease);
    return {
      content: [{ type: "text" as const, text: `Core Generation activation accepted as ${request.requestId}. Stop starting new work; the next Generation will resume from the durable handoff.` }],
      details: {
        accepted: true,
        requestId: request.requestId,
        targetRelease,
        expectedCurrent: request.expectedCurrent,
        reason: request.reason,
      },
    };
  }

  private request(toolCallId: string, parameters: ActivationParameters, targetRelease = parameters.targetRelease.trim()): GenerationActivationRequest {
    const execution = this.capabilities.getRunExecutionState?.();
    if (!execution) throw new Error("Generation activation requires the current running Attempt");
    const operationId = `${this.capabilities.runId}:${execution.attempt}:${toolCallId}`;
    return {
      requestId: operationId,
      operationId,
      runId: this.capabilities.runId,
      targetRelease,
      expectedCurrent: this.bridge.releaseId,
      reason: parameters.reason?.trim() || "Agent requested Core Generation activation",
    };
  }

  private onOperationSettled(toolCallId: string, parameters: ActivationParameters): void {
    let request: GenerationActivationRequest;
    try {
      request = this.request(toolCallId, parameters);
    } catch {
      // The accepted receipt is authoritative. Startup reconciliation will
      // redispatch it if the Attempt fence disappeared before this callback.
      return;
    }
    setImmediate(() => {
      try { this.coordinator.accept(request); }
      catch (error) {
        try {
          this.capabilities.publish("maintenance.activation.dispatch_failed", {
            requestId: request.requestId,
            operationId: request.operationId,
            targetRelease: request.targetRelease,
            error: error instanceof Error ? error.message : String(error),
          });
        } catch {
          // The settled operation remains the recovery authority. A stale
          // Attempt fence may also reject this diagnostic event, so startup
          // reconciliation redispatches the pending activation instead.
        }
      }
    });
  }
}
