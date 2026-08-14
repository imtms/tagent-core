import { access, mkdir } from "node:fs/promises";
import { ToolExecutionPipeline, ToolRegistry, type ToolProvider } from "@tagent/execution/composition";
import type { RuntimeCapabilityCatalog, SubprocessPort, ToolCapabilityApplicationPort } from "@tagent/execution/ports";
import { BashToolProvider } from "./bash-tool-provider.js";
import { EditToolProvider, ListToolProvider, PatchToolProvider, ReadToolProvider, WriteToolProvider } from "./filesystem-tool-providers.js";
import { MemoryToolProvider } from "./memory-tool-provider.js";
import { HistoryToolProvider } from "./history-tool-provider.js";
import { TaskRunToolProvider } from "./task-run-tool-provider.js";
export { bashInvalidatesChecks } from "./shared.js";

export interface WorkspaceToolComposition {
  readonly catalog: RuntimeCapabilityCatalog;
  readonly pipeline: ToolExecutionPipeline;
}

function createToolProviders(capabilities: ToolCapabilityApplicationPort, workspace: string, subprocess: SubprocessPort): readonly ToolProvider[] {
  return [
    new ListToolProvider(capabilities, workspace), new ReadToolProvider(capabilities, workspace),
    new WriteToolProvider(workspace), new EditToolProvider(capabilities), new PatchToolProvider(capabilities),
    new BashToolProvider(capabilities, workspace, subprocess), new TaskRunToolProvider(capabilities),
    new MemoryToolProvider(capabilities), new HistoryToolProvider(capabilities),
  ];
}

export function composeWorkspaceTools(capabilities: ToolCapabilityApplicationPort, workspace: string, subprocess: SubprocessPort): WorkspaceToolComposition {
  const registry = new ToolRegistry();
  for (const provider of createToolProviders(capabilities, workspace, subprocess)) registry.register(provider);
  const pipeline = new ToolExecutionPipeline(capabilities);
  return { pipeline, catalog: pipeline.bindCatalog(registry.snapshot()) };
}

export async function ensureWorkspace(workspace: string) { await mkdir(workspace, { recursive: true }); await access(workspace); }
