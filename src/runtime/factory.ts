import { PiRuntime } from "./pi-runtime.js";
import type { RuntimeFactory } from "./types.js";

export const createInProcessRuntime: RuntimeFactory = (options) => new PiRuntime(options);

export function resolveRuntimeFactory(runtime: string): RuntimeFactory {
  if (runtime === "in-process") return createInProcessRuntime;
  throw new Error(`Unsupported runtime: ${runtime}`);
}
