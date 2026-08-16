import type { CoreApplicationCoordinator } from "./core-application-coordinator.js";
import {
  composeExecutionApplication,
  type ExecutionCompositionOptions,
} from "../composition/execution-composition.js";

export type CoreApplicationOptions = ExecutionCompositionOptions;

export function createCoreApplication(options: CoreApplicationOptions): CoreApplicationCoordinator {
  return composeExecutionApplication(options);
}
