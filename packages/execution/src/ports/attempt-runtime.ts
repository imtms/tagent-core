import type { StructuredToolError } from "./tool-error.js";

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

interface RuntimeTextPart { type: "text"; text: string; textSignature?: string }
interface RuntimeThinkingPart { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean }
interface RuntimeImagePart { type: "image"; data: string; mimeType: string }
interface RuntimeToolCallPart { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown>; thoughtSignature?: string }
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
      error?: StructuredToolError;
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
    signal: AbortSignal,
    onUpdate?: RuntimeToolUpdateCallback<TDetails>,
  ): Promise<RuntimeToolResult<TDetails>>;
  executionMode?: RuntimeToolExecutionMode;
  /** Core-enforced execution policy. Providers describe effects; they cannot settle their own guard. */
  policy?: RuntimeToolPolicy;
  /** Runs only for the process that durably settles a new successful operation receipt. */
  onOperationSettled?(toolCallId: string, params: TParameters, result: RuntimeToolResult<TDetails>): void;
}

export interface RuntimeToolPolicy {
  operationType?: string;
  workspaceAccess?: "none" | "read_only" | "mutation" | ((parameters: unknown) => "none" | "read_only" | "mutation");
  invalidatesChecks?: boolean | ((parameters: unknown) => boolean);
  /** `explicit` requires a consumed human approval even for an otherwise non-external TaskRun. */
  externalAction?: boolean | "explicit";
}

export interface RuntimeCapabilityCatalog {
  readonly tools: readonly RuntimeTool[];
}

export interface RuntimeEventSink {
  activity(): void;
  publish<TType extends import("../domain/task-run.js").RunEventType>(type: TType, data: import("../domain/task-run.js").RunEventMap[TType]): void;
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
    error?: StructuredToolError;
  }): void;
}

export interface RuntimeProviderFailure {
  kind: string;
  retryable: boolean;
  retryAfterMs?: number;
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
  /**
   * Permanently stop this runtime and await all work it owns.
   *
   * Implementations must make disposal idempotent. Resolution is a quiescence
   * guarantee: no callback, provider request, tool, or persistence-facing work
   * owned by this runtime may still be running afterwards.
   */
  dispose(): Promise<void>;
  getMessages(): RuntimeMessage[];
  getError(): string | undefined;
  /** Latest terminal provider failure, when the concrete runtime can classify it. */
  getProviderFailure?(): RuntimeProviderFailure | undefined;
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
  credential?: {
    reference: import("./credential-resolver-port.js").CredentialReference;
    resolver: import("./credential-resolver-port.js").CredentialResolverPort;
  };
  initialMessages?: RuntimeMessage[];
  skills?: readonly RuntimeSkill[];
  selectedSkillName?: string;
  providerTimeoutMs?: number;
  providerMaxRetries?: number;
  runTimeoutMs?: number;
  runHardTimeoutMs?: number;
  historicalToolResultChars?: number;
  historicalTaskRunReceiptChars?: number;
  /** Core-owned, ephemeral context refreshed and appended after history for every provider request. */
  dynamicContext?: () => string;
  requestEnvelopes?: import("./attempt-request-envelope-repository.js").AttemptRequestEnvelopeRepository;
}

export type AttemptRuntimeFactory = (spec: AttemptRuntimeSpec) => AttemptRuntimePort;
