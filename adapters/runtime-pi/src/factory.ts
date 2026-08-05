import { PiRuntime, type PiRuntimeOptions } from "./pi-runtime.js";
import type { AttemptRuntimeFactory } from "@tagent/execution/ports";

export const createInProcessRuntime: AttemptRuntimeFactory = (options) => new PiRuntime(options as PiRuntimeOptions);

export function resolveRuntimeFactory(runtime: string): AttemptRuntimeFactory {
  if (runtime === "in-process") return createInProcessRuntime;
  throw new Error(`Unsupported runtime: ${runtime}`);
}
