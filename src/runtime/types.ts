import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Store } from "../store/store.js";
import type { RunEvent, RunId } from "../core/types.js";

export interface AgentRuntime {
  prompt(query: string): Promise<void>;
  steer(instruction: string): Promise<void>;
  followUp?(instruction: string): Promise<void>;
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
  modelRuntime?: ModelRuntime;
  apiKey?: string;
  initialMessages?: AgentMessage[];
  providerTimeoutMs?: number;
  providerMaxRetries?: number;
  runTimeoutMs?: number;
  runHardTimeoutMs?: number;
  onActivity?: () => void;
  onEvent?: (event: RunEvent) => void;
}

export type RuntimeFactory = (options: RuntimeOptions) => AgentRuntime;
