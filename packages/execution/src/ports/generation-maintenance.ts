import type { RunId } from "../domain/task-run.js";

export const GENERATION_ACTIVATION_OPERATION = "maintenance.activate_generation" as const;
export const GENERATION_HANDOFF_MARKER = "restart-handoff" as const;

export interface GenerationActivationRequest {
  requestId: string;
  operationId: string;
  runId: RunId;
  targetRelease: string;
  expectedCurrent: string;
  reason: string;
}

export interface GenerationActivationResult {
  requestId: string;
  status: "succeeded" | "rolled_back" | "failed" | "blocked";
  activeRelease: string;
  error?: string;
}

export interface GenerationMaintenanceRepository {
  listPendingGenerationActivations(): GenerationActivationRequest[];
  prepareGenerationHandoff(request: GenerationActivationRequest): {
    continuationId: string;
    created: boolean;
  };
  recordGenerationActivationResult(result: GenerationActivationResult): {
    runId: RunId;
    recorded: boolean;
  } | undefined;
}
