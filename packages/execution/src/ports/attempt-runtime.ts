/** Execution-owned identity and fencing token for one bounded Attempt. */
export interface AttemptExecutionToken {
  runId: string;
  attemptId: string;
  ordinal: number;
  expectedVersion: number;
  ownerId: string;
  leaseToken: string;
  executionFence: number;
}

export interface RuntimeTextPart { type: "text"; text: string; textSignature?: string }
export interface RuntimeThinkingPart { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean }
export interface RuntimeImagePart { type: "image"; data: string; mimeType: string }
export interface RuntimeToolCallPart { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; thoughtSignature?: string }
export type RuntimeMessagePart = RuntimeTextPart | RuntimeThinkingPart | RuntimeImagePart | RuntimeToolCallPart;

export interface RuntimeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/**
 * Storage-neutral transcript shape crossing the Execution/Runtime boundary.
 * Runtime adapters own conversion from their SDK-specific message types.
 */
export type RuntimeMessage =
  | { role: "user"; content: string | Array<RuntimeTextPart | RuntimeImagePart>; timestamp: number }
  | {
      role: "assistant";
      content: Array<RuntimeTextPart | RuntimeThinkingPart | RuntimeToolCallPart>;
      api: string;
      provider: string;
      model: string;
      usage: RuntimeUsage;
      stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted";
      errorMessage?: string;
      timestamp: number;
    }
  | {
      role: "toolResult";
      toolCallId: string;
      toolName: string;
      content: Array<RuntimeTextPart | RuntimeImagePart>;
      details?: unknown;
      usage?: RuntimeUsage;
      isError: boolean;
      timestamp: number;
    }
  | { role: "bashExecution"; command: string; output: string; exitCode?: number; cancelled: boolean; truncated: boolean; timestamp: number }
  | { role: "custom"; customType: string; content: string | Array<RuntimeTextPart | RuntimeImagePart>; display: boolean; details?: unknown; timestamp: number }
  | { role: "branchSummary"; summary: string; fromId: string; timestamp: number }
  | { role: "compactionSummary"; summary: string; tokensBefore: number; timestamp: number };

export interface RuntimeToolResult<TDetails = unknown> {
  content: Array<RuntimeTextPart | RuntimeImagePart>;
  details: TDetails;
  usage?: RuntimeUsage;
  addedToolNames?: string[];
  terminate?: boolean;
}

export type RuntimeToolUpdateCallback<TDetails = unknown> = (partialResult: RuntimeToolResult<TDetails>) => void;
export type RuntimeToolExecutionMode = "sequential" | "parallel";

/** Runtime-neutral tool ABI owned by Execution and adapted at the concrete runtime boundary. */
export interface RuntimeTool<TParameters = unknown, TDetails = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  prepareArguments?: (args: unknown) => TParameters;
  execute(
    toolCallId: string,
    params: TParameters,
    signal?: AbortSignal,
    onUpdate?: RuntimeToolUpdateCallback<TDetails>,
  ): Promise<RuntimeToolResult<TDetails>>;
  executionMode?: RuntimeToolExecutionMode;
}

export interface RuntimeCapabilityCatalog {
  readonly tools: readonly RuntimeTool[];
}

export interface RuntimeEventSink {
  activity(): void;
  publish(type: string, data: Record<string, unknown>): void;
  appendTranscript(message: RuntimeMessage): number | undefined;
  isRunning(): boolean;
  isWaitingForInput(): boolean;
  beforeToolCall(input: {
    toolCallId: string;
    toolName: string;
    args: unknown;
  }): { blocked: boolean; reason?: string };
  afterToolCall(input: {
    toolCallId: string;
    toolName: string;
    success: boolean;
    error?: string;
  }): void;
}

export type RuntimeQueueResult = "accepted" | "settled";

export interface AttemptRuntimePort {
  initialize?(): Promise<unknown>;
  prompt(query: string): Promise<void>;
  /** Explicitly invoke one Core-selected Skill; never inferred from prompt text. */
  invokeSkill?(name: string, query: string): Promise<void>;
  steer(instruction: string): Promise<RuntimeQueueResult>;
  followUp?(instruction: string): Promise<RuntimeQueueResult>;
  compact?(instructions?: string): Promise<void>;
  abort(): void | Promise<void>;
  dispose?(): void;
  getMessages(): RuntimeMessage[];
  getError(): string | undefined;
}

/** Neutral model projection used only for Execution sizing and runtime selection. */
export interface RuntimeModelSpec {
  id: string;
  provider: string;
  api: string;
  baseUrl: string;
  reasoning?: boolean;
  contextWindow: number;
  maxTokens: number;
}

/** Runtime-neutral projection of one immutable Core-managed Skill revision. */
export interface RuntimeSkill {
  name: string;
  description: string;
  content: string;
  filePath: string;
  sha256: string;
  disableModelInvocation?: boolean;
}

export type RuntimeReasoningEffort = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface AttemptRuntimeSpec {
  token: AttemptExecutionToken;
  workspace: string;
  systemPrompt: string;
  capabilities: RuntimeCapabilityCatalog;
  eventSink: RuntimeEventSink;
  model?: RuntimeModelSpec;
  fallbackModels?: RuntimeModelSpec[];
  reasoningEffort?: RuntimeReasoningEffort;
  apiKey?: string;
  initialMessages?: RuntimeMessage[];
  skills?: readonly RuntimeSkill[];
  selectedSkillName?: string;
  providerTimeoutMs?: number;
  providerMaxRetries?: number;
  runTimeoutMs?: number;
  runHardTimeoutMs?: number;
  historicalToolResultChars?: number;
  historicalTaskRunReceiptChars?: number;
}

export type AttemptRuntimeFactory = (spec: AttemptRuntimeSpec) => AttemptRuntimePort;
