import type { TaskRun } from "../domain/task-run.js";
import type { RuntimeModelSpec, RuntimeReasoningEffort } from "../ports/attempt-runtime.js";

export interface RuntimeModelSelection {
  model: RuntimeModelSpec | undefined;
  fallbackModels: RuntimeModelSpec[];
  reasoningEffort: RuntimeReasoningEffort;
}

export function selectRuntimeModel(
  run: Pick<TaskRun, "modelId" | "reasoningEffort">,
  primary: RuntimeModelSpec | undefined,
  fallbacks: RuntimeModelSpec[] = [],
): RuntimeModelSelection {
  const configured = [primary, ...fallbacks].filter((model): model is RuntimeModelSpec =>
    typeof model?.id === "string" && Boolean(model.id.trim()));
  const requestedModelId = run.modelId.trim();
  if (!requestedModelId) throw new Error("TaskRun modelId is required");
  // Test and embedded runtimes may intentionally provide no model catalogue.
  // Production Core always supplies its configured primary model and therefore
  // still enforces the persisted allowlist below.
  if (!configured.length) return {
    model: undefined,
    fallbackModels: [],
    reasoningEffort: run.reasoningEffort,
  };
  const selected = configured.find((model) => model.id === requestedModelId);
  if (!selected) throw new Error(`Model is not allowed: ${requestedModelId}`);
  return {
    model: selected,
    fallbackModels: configured.filter((model) => model.id !== selected?.id),
    reasoningEffort: selected?.reasoning === false ? "off" : run.reasoningEffort,
  };
}
