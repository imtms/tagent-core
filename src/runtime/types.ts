import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { Model } from "@mariozechner/pi-ai";
import type { Store } from "../store/store.js";
import type { RunEvent, RunId } from "../core/types.js";

export interface AgentRuntime {
  prompt(query: string): Promise<void>;
  steer(instruction: string): void;
  abort(): void;
  getMessages(): AgentMessage[];
  getError(): string | undefined;
}

export interface RuntimeOptions {
  store: Store;
  runId: RunId;
  workspace: string;
  systemPrompt: string;
  model?: Model<any>;
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
