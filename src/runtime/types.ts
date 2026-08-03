import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Store } from "../store/store.js";
import type { RunEvent, RunId } from "../core/types.js";
import type { MemoryFacade } from "../memory/memory-service.js";

export type RuntimeQueueResult = "accepted" | "settled";

export interface AgentRuntime {
  initialize?(): Promise<unknown>;
  prompt(query: string): Promise<void>;
  steer(instruction: string): Promise<RuntimeQueueResult>;
  followUp?(instruction: string): Promise<RuntimeQueueResult>;
  compact?(instructions?: string): Promise<void>;
  abort(): void | Promise<void>;
  dispose?(): void;
  getMessages(): AgentMessage[];
  getError(): string | undefined;
}

export interface RuntimeOptions {
  store: Store;
  runId: RunId;
  workspace: string;
  systemPrompt: string;
  model?: Model<any>;
  fallbackModels?: Model<any>[];
  modelRuntime?: ModelRuntime;
  apiKey?: string;
  initialMessages?: AgentMessage[];
  providerTimeoutMs?: number;
  providerMaxRetries?: number;
  runTimeoutMs?: number;
  runHardTimeoutMs?: number;
  onActivity?: () => void;
  onEvent?: (event: RunEvent) => void;
  memory?: MemoryFacade;
  memoryScopeId?: string;
  memorySubjectId?: string;
}

export type RuntimeFactory = (options: RuntimeOptions) => AgentRuntime;
