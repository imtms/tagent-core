import type { AttemptRuntimeFactory } from "@tagent/execution/ports";
import type { MemoryFacade } from "@tagent/memory";
import type { LearningFeatureControl, SemanticJudge } from "@tagent/learning";
import type { CoreApplicationPersistencePort } from "./ports/index.js";
import type { CoreApplicationCoordinator } from "./core-application-coordinator.js";
import { composeExecutionApplication } from "../composition/execution-composition.js";
import type { ExecutionCoordinatorStartupOptions } from "@tagent/execution/composition";
import type { CoreRuntimeDefaults } from "../composition/execution-composition.js";
import type { AdditionalToolProviderFactory } from "../composition/runtime-host-adapter.js";

type CoreApplicationArguments = [
  persistence: CoreApplicationPersistencePort,
  workspace: string,
  runtimeFactory?: AttemptRuntimeFactory,
  runtimeDefaults?: CoreRuntimeDefaults,
  memory?: MemoryFacade,
  memoryScopeId?: string,
  learningControl?: LearningFeatureControl,
  semanticJudge?: SemanticJudge,
  startupOptions?: ExecutionCoordinatorStartupOptions,
  projectRuleFiles?: string[],
  toolArtifactMaxBytes?: number,
  additionalToolProviders?: AdditionalToolProviderFactory,
];

export function createCoreApplication(
  ...args: CoreApplicationArguments
): CoreApplicationCoordinator {
  const [persistence, workspace, runtimeFactory, runtimeDefaults, memory, memoryScopeId, learningControl, semanticJudge, startupOptions, projectRuleFiles, toolArtifactMaxBytes, additionalToolProviders] = args;
  return composeExecutionApplication({
    persistence, workspace, runtimeFactory, runtimeDefaults, memory,
    memoryScopeId, learningControl, semanticJudge, startupOptions, projectRuleFiles, toolArtifactMaxBytes, additionalToolProviders,
  });
}
