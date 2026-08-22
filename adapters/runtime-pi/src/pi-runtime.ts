import {
  AgentHarness,
  AgentHarnessError,
  DEFAULT_COMPACTION_SETTINGS,
  InMemorySessionStorage,
  Session,
  shouldCompact,
  type AgentHarnessEvent,
  type AgentHarnessTool,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import {
  createModels,
  createProvider,
  type Api,
  type Model,
  type MutableModels,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { randomUUID } from "node:crypto";
import { classifyProviderFailure, describeProviderFailure, isRetryableProviderFailure } from "./provider-errors.js";
import { withProviderIdleTimeout } from "./provider-transport.js";
import {
  createAttemptRequestEnvelope,
  classifyToolError,
  requestHash,
  structuredToolErrorFromDetails,
  type RunEventMap,
  type RunEventType,
  type AttemptRuntimePort,
  type AttemptRuntimeSpec,
  type RuntimeMessage,
  type RuntimeModelSpec,
  type RuntimeProviderFailure,
  type RuntimeTool,
  type StructuredToolError,
} from "@tagent/execution/ports";

const MAX_TIMER_DELAY_MS = 2_147_483_647;
const RETRY_DELAY_SAFETY_MARGIN_MS = 1;
const CORE_CONTEXT_CHECKPOINT_ENTRY = "tagent_core_context_checkpoint";

interface CoreContextCheckpoint {
  hash: string;
  text: string;
  timestamp: number;
}

interface ProviderContextBudget {
  inputTokens: number;
  outputReserveTokens: number;
  compact: boolean;
}

type PendingCompactionReason = "manual" | "threshold" | "overflow";

interface PendingCompaction {
  reason: PendingCompactionReason;
  instructions?: string;
  promise?: Promise<void>;
  resolve?: () => void;
  reject?: (error: unknown) => void;
}

export function providerRetryDelayMs(retryAttempt: number, runTimeoutMs?: number, runHardTimeoutMs?: number, retryAfterMs?: number) {
  const idleBudget = runTimeoutMs === undefined ? Number.POSITIVE_INFINITY : Math.max(0, runTimeoutMs - RETRY_DELAY_SAFETY_MARGIN_MS);
  const hardBudget = runHardTimeoutMs === undefined ? Number.POSITIVE_INFINITY : Math.max(0, runHardTimeoutMs - RETRY_DELAY_SAFETY_MARGIN_MS);
  const cap = Math.min(MAX_TIMER_DELAY_MS, idleBudget, hardBudget);
  if (cap <= 0) return 0;
  const exponent = Math.max(0, Math.floor(retryAttempt) - 1);
  const localBackoff = exponent >= 31 ? cap : Math.min(1_000 * 2 ** exponent, cap);
  const providerWindow = retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0
    ? Math.ceil(retryAfterMs)
    : 0;
  return Math.min(Math.max(localBackoff, providerWindow), cap);
}

export interface PiRuntimeOptions extends AttemptRuntimeSpec {
  /** Test-only injection point for a preconfigured pi-ai model collection. */
  models?: MutableModels;
}

export interface DeferredRuntimeControl {
  mode: "steer" | "followUp";
  instruction: string;
}

export async function deliverDeferredControls(
  controls: DeferredRuntimeControl[],
  harness: Pick<AgentHarness<undefined>, "steer" | "followUp">,
) {
  while (controls.length > 0) {
    const control = controls[0];
    if (control.mode === "steer") await harness.steer(control.instruction);
    else await harness.followUp(control.instruction);
    controls.shift();
  }
}

function toPiModel(spec: RuntimeModelSpec): Model<Api> {
  return {
    id: spec.id,
    name: spec.id,
    api: spec.api,
    provider: spec.provider,
    baseUrl: spec.baseUrl,
    reasoning: spec.reasoning ?? false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
    ...(spec.api === "openai-completions" ? {
      // Unknown endpoints frequently reject the OpenAI-only `store` field.
      // Leave every provider-specific field unset so pi-ai can auto-detect
      // DeepSeek, ZAI, Moonshot, Together, OpenRouter, NVIDIA, and other dialects.
      compat: {
        supportsStore: false,
      },
    } : {}),
  };
}

function providerApi(api: string, idleTimeoutMs: number | undefined, lifetimeSignal: AbortSignal, onRetryAfter: (retryAfterMs: number | undefined) => void): ProviderStreams {
  if (api === "openai-completions") return withProviderIdleTimeout(openAICompletionsApi(), idleTimeoutMs, lifetimeSignal, true, onRetryAfter);
  if (api === "anthropic-messages") return withProviderIdleTimeout(anthropicMessagesApi(), idleTimeoutMs, lifetimeSignal, false, onRetryAfter);
  throw new Error(`Unsupported Pi runtime API: ${api}`);
}

function buildModels(options: PiRuntimeOptions, models: Model<Api>[], lifetimeSignal: AbortSignal, onRetryAfter: (retryAfterMs: number | undefined) => void): MutableModels {
  if (options.models) return options.models;
  const collection = createModels();
  const grouped = new Map<string, Model<Api>[]>();
  for (const model of models) grouped.set(model.provider, [...(grouped.get(model.provider) ?? []), model]);
  for (const [providerId, providerModels] of grouped) {
    const api = Object.fromEntries([...new Set(providerModels.map((model) => model.api))].map((name) => [name, providerApi(name, options.providerTimeoutMs, lifetimeSignal, onRetryAfter)]));
    collection.setProvider(createProvider({
      id: providerId,
      name: providerId,
      baseUrl: providerModels[0]?.baseUrl,
      models: providerModels,
      auth: {
        apiKey: {
          name: `${providerId} API key`,
          resolve: async () => {
            const apiKey = options.credential
              ? await options.credential.resolver.resolve(options.credential.reference)
              : undefined;
            return apiKey ? { auth: { apiKey } } : undefined;
          },
        },
      },
      api,
    }));
  }
  return collection;
}

function toPiTool(tool: RuntimeTool, runtimeSignal: AbortSignal): AgentHarnessTool<undefined> {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters as AgentHarnessTool<undefined>["parameters"],
    prepareArguments: tool.prepareArguments,
    executionMode: tool.executionMode,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const operationSignal = signal ?? runtimeSignal;
      try {
        return await tool.execute(
          toolCallId,
          params,
          operationSignal,
          onUpdate ? (update) => onUpdate(update) : undefined,
        );
      } catch (error) {
        const structured = classifyToolError(error, { signal: operationSignal }).toJSON();
        return {
          content: [{ type: "text", text: structured.message }],
          details: { error: structured },
        };
      }
    },
  };
}

function mergeToolErrorDetails(details: unknown, error: StructuredToolError) {
  return details && typeof details === "object"
    ? { ...details, error }
    : { value: details, error };
}

function messageText(message: AgentMessage | undefined) {
  if (!message || message.role !== "assistant") return "";
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

/** One classification owner for Session retention, public runtime history, and transcript visibility. */
function retainInActiveContext(message: AgentMessage, contextWindow?: number, desiredMaxOutput?: number) {
  if (message.role !== "assistant") return true;
  if (message.stopReason === "error" || message.stopReason === "aborted") return false;
  const failure = describeProviderFailure(message, contextWindow, desiredMaxOutput);
  if (failure?.kind === "empty_response") return false;
  // A successful stop may merely report input usage above the compaction
  // threshold. Keep that answer; omit only an overflow response that will be
  // replaced by recovery.
  if (failure?.kind === "context_overflow" && message.stopReason !== "stop") return false;
  return true;
}

function projectRuntimeHistory(
  messages: AgentMessage[],
  toolResultLimit: number,
  taskRunReceiptLimit: number,
  isInternalMessage: (message: AgentMessage) => boolean,
  isCoreContextMessage: (message: AgentMessage) => boolean,
): AgentMessage[] {
  const visibleMessages = messages.filter((message) => !isInternalMessage(message));
  const latestUserIndex = visibleMessages.reduce((latest, message, index) => message.role === "user" && !isCoreContextMessage(message) ? index : latest, -1);
  return visibleMessages.map((message, index) => {
    if (isCoreContextMessage(message) || index >= latestUserIndex || (message.role !== "assistant" && message.role !== "toolResult")) return message;
    let changed = false;
    const content = message.content.flatMap((part) => {
      if (part.type === "thinking") { changed = true; return []; }
      if (part.type === "toolCall") {
        const serialized = JSON.stringify(part.arguments);
        const limit = part.name === "task_run" ? taskRunReceiptLimit : toolResultLimit;
        if (serialized.length <= limit) return part;
        changed = true;
        return { ...part, arguments: { historicalSummary: `${part.name} arguments omitted (${serialized.length} chars)`, durableTranscript: true } };
      }
      if (message.role !== "toolResult" || part.type !== "text") return part;
      if (message.toolName === "task_run") {
        const projected = compactTaskRunReceipt(part.text, taskRunReceiptLimit);
        if (projected !== part.text) changed = true;
        return projected === part.text ? part : { ...part, text: projected };
      }
      if (part.text.length <= toolResultLimit) return part;
      changed = true;
      const artifactUri = message.details && typeof message.details === "object" && "artifactUri" in message.details && typeof message.details.artifactUri === "string"
        ? message.details.artifactUri : undefined;
      const suffix = artifactUri
        ? `\n[Historical result projected from ${part.text.length} chars; full output: ${artifactUri}]`
        : `\n[Historical result projected from ${part.text.length} chars; full result remains in durable transcript]`;
      const headBudget = Math.max(0, Math.floor((toolResultLimit - suffix.length) * .6));
      const tailBudget = Math.max(0, toolResultLimit - suffix.length - headBudget);
      return { ...part, text: `${part.text.slice(0, headBudget)}${suffix}${tailBudget ? part.text.slice(-tailBudget) : ""}` };
    });
    return changed ? { ...message, content } as AgentMessage : message;
  });
}

class RuntimeSession extends Session {
  private readonly coreContextMessages: WeakSet<AgentMessage>;

  constructor(
    private readonly isInternalMessage: (message: AgentMessage) => boolean,
    private readonly retainMessage: (message: AgentMessage) => boolean,
  ) {
    const coreContextMessages = new WeakSet<AgentMessage>();
    super(new InMemorySessionStorage(), {
      entryProjectors: {
        [CORE_CONTEXT_CHECKPOINT_ENTRY]: (entry) => {
          const checkpoint = entry.data as Partial<CoreContextCheckpoint> | undefined;
          if (!checkpoint || typeof checkpoint.hash !== "string" || typeof checkpoint.text !== "string" || typeof checkpoint.timestamp !== "number") return [];
          const message: AgentMessage = {
            role: "user",
            content: [{ type: "text", text: checkpoint.text }],
            timestamp: checkpoint.timestamp,
          };
          coreContextMessages.add(message);
          return [message];
        },
      },
    });
    this.coreContextMessages = coreContextMessages;
  }

  override async appendMessage(message: AgentMessage) {
    if (!this.isInternalMessage(message) && this.retainMessage(message)) return super.appendMessage(message);
    const leafId = await this.getLeafId();
    if (!leafId) throw new Error("Transient message requires an existing session context");
    return leafId;
  }

  async appendCoreContextCheckpoint(checkpoint: CoreContextCheckpoint) {
    await this.appendCustomEntry(CORE_CONTEXT_CHECKPOINT_ENTRY, checkpoint);
    return this.projectCoreContextCheckpoint(checkpoint);
  }

  projectCoreContextCheckpoint(checkpoint: CoreContextCheckpoint) {
    const message: AgentMessage = {
      role: "user",
      content: [{ type: "text", text: checkpoint.text }],
      timestamp: checkpoint.timestamp,
    };
    this.coreContextMessages.add(message);
    return message;
  }

  isCoreContextMessage(message: AgentMessage) {
    return this.coreContextMessages.has(message);
  }
}

function estimateTextTokens(text: string) {
  return Math.ceil(text.length / 4);
}

function estimateContentTokens(content: string | Array<{ type: string; text?: string; data?: string }>) {
  if (typeof content === "string") return estimateTextTokens(content);
  const chars = content.reduce((total, part) => total + (part.type === "text" ? part.text?.length ?? 0 : 4_800), 0);
  return Math.ceil(chars / 4);
}

function estimateAgentMessageTokens(message: AgentMessage) {
  if (message.role === "user" || message.role === "toolResult") return estimateContentTokens(message.content);
  if (message.role === "assistant") {
    let chars = 0;
    for (const part of message.content) {
      if (part.type === "text") chars += part.text.length;
      else if (part.type === "thinking") chars += part.thinking.length;
      else {
        try { chars += part.name.length + JSON.stringify(part.arguments).length; }
        catch { chars += part.name.length + 64; }
      }
    }
    return Math.ceil(chars / 4);
  }
  if (message.role === "bashExecution") return estimateTextTokens(message.command + message.output);
  if (message.role === "compactionSummary" || message.role === "branchSummary") return estimateTextTokens(message.summary);
  if (message.role === "custom") return estimateContentTokens(message.content);
  return 0;
}

function estimateProjectedMessages(messages: AgentMessage[]) {
  let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
  let usageInfo: { index: number; tokens: number } | undefined;
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === "assistant") {
      const usageTokens = message.usage.totalTokens
        || message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
      if (message.timestamp >= latestPrefixTimestamp
        && message.stopReason !== "error" && message.stopReason !== "aborted" && usageTokens > 0) {
        usageInfo = { index, tokens: usageTokens };
      }
    }
    latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
  }
  if (!usageInfo) return {
    tokens: messages.reduce((tokens, message) => tokens + estimateAgentMessageTokens(message), 0),
    lastUsageIndex: null,
  };
  return {
    tokens: usageInfo.tokens + messages.slice(usageInfo.index + 1).reduce((tokens, message) => tokens + estimateAgentMessageTokens(message), 0),
    lastUsageIndex: usageInfo.index,
  };
}

function estimateToolSchemaTokens(tools: readonly AgentHarnessTool<undefined>[]) {
  if (tools.length === 0) return 0;
  const schemas = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  try { return estimateTextTokens(JSON.stringify(schemas)); }
  catch { return estimateTextTokens("[unserializable tool schemas]"); }
}

function providerPrefixHash(systemPrompt: string, tools: readonly AgentHarnessTool<undefined>[], model: Model<Api>) {
  return requestHash({
    model: `${model.provider}:${model.id}`,
    systemPrompt,
    tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
  });
}

/** Estimate the exact projected input plus a conservative, intended output reserve. */
function providerContextBudget(
  messages: AgentMessage[],
  systemPrompt: string,
  tools: readonly AgentHarnessTool<undefined>[],
  model: Model<Api>,
  measuredPrefixHash?: string,
): ProviderContextBudget {
  const estimate = estimateProjectedMessages(messages);
  // A valid assistant usage block already measures the system prompt, tools,
  // and all messages through that response. Add the fixed prefix only when no
  // provider measurement is available, avoiding systematic double counting.
  const currentPrefixHash = providerPrefixHash(systemPrompt, tools, model);
  const unmeasuredPrefixTokens = estimate.lastUsageIndex === null || measuredPrefixHash !== currentPrefixHash
    ? estimateTextTokens(systemPrompt) + estimateToolSchemaTokens(tools)
    : 0;
  const inputTokens = estimate.tokens + unmeasuredPrefixTokens;
  // Pi's fixed 16k reserve is appropriate for large windows but would leave
  // almost no usable input on small local/test models. Scale that safety band
  // down while always reserving the model's intended (pre-clamp) output cap.
  const adaptiveSafetyReserve = Math.min(
    DEFAULT_COMPACTION_SETTINGS.reserveTokens,
    Math.max(1_024, Math.floor(model.contextWindow * 0.25)),
  );
  const outputReserveTokens = Math.max(adaptiveSafetyReserve, Math.max(0, model.maxTokens));
  return {
    inputTokens,
    outputReserveTokens,
    compact: shouldCompact(inputTokens, model.contextWindow, {
      ...DEFAULT_COMPACTION_SETTINGS,
      reserveTokens: outputReserveTokens,
    }),
  };
}

function compactTaskRunReceipt(text: string, limit: number) {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || value.ok !== true || typeof value.action !== "string") return text.length <= limit ? text : `${text.slice(0, limit)}\n[Historical task_run output projected]`;
    const gate = value.completionGate && typeof value.completionGate === "object" ? value.completionGate as { passed?: unknown; failures?: unknown[] } : undefined;
    return JSON.stringify({
      ok: true, action: value.action, status: value.status, phase: value.phase, counts: value.counts,
      completionGate: gate ? { passed: Boolean(gate.passed), failureCount: Array.isArray(gate.failures) ? gate.failures.length : 0 } : undefined,
      historicalReceipt: true,
    }).slice(0, limit);
  } catch {
    return text.length <= limit ? text : `${text.slice(0, limit)}\n[Historical task_run output projected]`;
  }
}

export class PiRuntime implements AttemptRuntimePort {
  private harness?: AgentHarness<undefined>;
  private session?: RuntimeSession;
  private initializing?: Promise<AgentHarness<undefined>>;
  private unsubscribe?: () => void;
  private disposed = false;
  private streaming = false;
  private abortRequested = false;
  private abortPromise?: Promise<void>;
  private disposePromise?: Promise<void>;
  private assistantMessageOrdinal = 0;
  private pendingDelta = "";
  private pendingThinkingDelta = "";
  private deltaTimer?: ReturnType<typeof setTimeout>;
  private thinkingDeltaTimer?: ReturnType<typeof setTimeout>;
  private lastToolProgressAt = new Map<string, number>();
  private readonly toolLivenessTimers = new Map<string, ReturnType<typeof setInterval>>();
  private fallbackIndex = 0;
  private lastError?: string;
  private lastProviderFailure?: RuntimeProviderFailure;
  private transportRetryAfterMs?: number;
  private messages: RuntimeMessage[];
  private compacting = false;
  private compactionPromise?: Promise<void>;
  private readonly lifetimeAbort = new AbortController();
  private harnessTurnActive = false;
  private internalPromptOrdinal = 0;
  private readonly internalPrompts = new Set<string>();
  private readonly blockedToolErrors = new Map<string, StructuredToolError>();
  private approvalPauseActive = false;
  private providerRequestOrdinal = 0;
  private deferredControls: DeferredRuntimeControl[] = [];
  private harnessPendingMessageCount = 0;
  private retryDelayAbort?: AbortController;
  private pendingCompaction?: PendingCompaction;
  private attemptContextMessage?: AgentMessage;
  private lastLiveContextHash?: string;
  private lastMeasuredProviderPrefixHash?: string;
  private turnNeedsProviderContinuation = false;
  private currentTurnTerminated = false;
  private recoverableOverflowPending = false;
  private readonly discardedProviderMessages = new WeakSet<AgentMessage>();
  private readonly discardedToolCallIds = new Set<string>();

  constructor(private readonly options: PiRuntimeOptions) {
    this.messages = [...(options.initialMessages ?? [])];
  }

  async initialize() {
    if (this.harness) return this.harness;
    if (this.initializing) return this.initializing;
    this.initializing = this.createHarness();
    try { this.harness = await this.initializing; return this.harness; }
    finally { this.initializing = undefined; }
  }

  private async createHarness() {
    if (!this.options.model) throw new Error("Pi runtime requires a model");
    const primary = toPiModel(this.options.model);
    const fallbacks = (this.options.fallbackModels ?? []).map(toPiModel);
    const models = buildModels(this.options, [primary, ...fallbacks], this.lifetimeAbort.signal, (retryAfterMs) => {
      this.transportRetryAfterMs = retryAfterMs;
    });
    const session = new RuntimeSession(
      (message) => this.isInternalMessage(message),
      (message) => this.shouldRetainSessionMessage(message),
    );
    this.session = session;
    for (const message of this.options.initialMessages ?? []) await session.appendMessage(message as AgentMessage);
    const attemptContext = this.options.attemptContext?.trim();
    const attemptContextMessage: AgentMessage | undefined = attemptContext
      ? {
        role: "user",
        content: [{ type: "text", text: attemptContext }],
        timestamp: Date.now(),
      }
      : undefined;
    this.attemptContextMessage = attemptContextMessage;
    if (attemptContextMessage) await session.appendMessage(attemptContextMessage);
    const harness = new AgentHarness({
      session,
      models,
      model: primary,
      systemPrompt: this.options.systemPrompt,
      tools: this.options.capabilities.tools.map((tool) => toPiTool(tool, this.lifetimeAbort.signal)),
      resources: { skills: this.options.skills?.map((skill) => ({ ...skill })) },
      thinkingLevel: primary.reasoning ? (this.options.reasoningEffort ?? "high") : "off",
      steeringMode: "one-at-a-time",
      followUpMode: "one-at-a-time",
      streamOptions: {
        // Disable provider-library retries so transient failures are audited once
        // and retried as complete turns from the persisted Harness session below.
        maxRetries: 0,
        maxRetryDelayMs: 15_000,
      },
      retry: { enabled: (this.options.providerMaxRetries ?? 1) > 0, maxRetries: this.options.providerMaxRetries ?? 1, baseDelayMs: 1_000 },
    });
    harness.on("before_provider_request", () => {
      if (this.options.eventSink.isRunning() && !this.options.eventSink.isWaitingForInput()) return undefined;
      throw new Error("Provider continuation blocked because the TaskRun is paused");
    });
    harness.on("before_provider_request", () => {
      if (!this.pendingCompaction) return undefined;
      throw new Error(`Provider dispatch deferred for ${this.pendingCompaction.reason} context compaction`);
    });
    harness.on("context", async ({ messages }) => {
      const checkpoint = await this.appendLiveContextCheckpoint(session);
      const contextMessages = checkpoint ? [...messages, checkpoint] : messages;
      const projected = this.projectProviderMessages(contextMessages, session);
      const budget = providerContextBudget(projected, this.options.systemPrompt, harness.getActiveTools(), harness.getModel(), this.lastMeasuredProviderPrefixHash);
      if (budget.compact && !this.compacting && !this.pendingCompaction) this.schedulePendingCompaction("threshold");
      return { messages: projected };
    });
    harness.on("before_provider_payload", ({ model, payload }) => {
      if (!this.options.requestEnvelopes) return undefined;
      const requestOrdinal = ++this.providerRequestOrdinal;
      const envelope = createAttemptRequestEnvelope({
        runId: this.options.token.runId,
        attemptId: this.options.token.attemptId,
        attempt: this.options.token.ordinal,
        requestOrdinal,
        model: {
          id: model.id, provider: model.provider, api: model.api, baseUrl: model.baseUrl,
          reasoning: model.reasoning, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
        },
        providerPayload: payload,
        createdAt: Date.now(),
      });
      this.options.requestEnvelopes.record(envelope);
      const durable = this.options.requestEnvelopes.get(envelope.id);
      if (!durable || durable.envelopeHash !== envelope.envelopeHash
        || requestHash(payload) !== durable.providerPayloadHash
        || requestHash(durable.providerPayload) !== durable.providerPayloadHash) {
        throw new Error(`Provider request does not match durable envelope ${envelope.id}`);
      }
      this.emit("request.envelope.persisted", {
        envelopeId: durable.id, requestOrdinal, envelopeHash: durable.envelopeHash,
        providerPayloadHash: durable.providerPayloadHash, model: durable.model.id,
      });
      return { payload: durable.providerPayload };
    });
    harness.on("tool_call", ({ toolCallId, toolName, input }) => {
      const guard = this.options.eventSink.beforeToolCall({ toolCallId, toolName, args: input });
      if (!guard.blocked) return undefined;
      const error = classifyToolError(new Error(guard.reason ?? "Tool call blocked"), { code: "NOT_AUTHORIZED" }).toJSON();
      this.blockedToolErrors.set(toolCallId, error);
      this.emit("tool.guard.blocked", { toolCallId, toolName, reason: guard.reason });
      const paused = !this.options.eventSink.isRunning() || this.options.eventSink.isWaitingForInput();
      if (paused) {
        this.approvalPauseActive = true;
        void harness.abort();
      }
      return {
        block: true,
        reason: paused
          ? `${guard.reason}. The TaskRun is paused until the hard approval is resolved.`
          : `${guard.reason}. Use a different approach or report the blocker.`,
      };
    });
    harness.on("tool_result", ({ toolCallId, toolName, content, details, isError }) => {
      const text = content.find((part) => part.type === "text")?.text ?? "Tool execution failed";
      const error = this.blockedToolErrors.get(toolCallId)
        ?? structuredToolErrorFromDetails(details)
        ?? (isError ? classifyToolError(new Error(text)).toJSON() : undefined);
      this.blockedToolErrors.delete(toolCallId);
      this.options.eventSink.afterToolCall({ toolCallId, toolName, success: !error && !isError, error });
      const terminate = !this.options.eventSink.isRunning() || this.options.eventSink.isWaitingForInput();
      if (terminate) this.currentTurnTerminated = true;
      if (error) return { details: mergeToolErrorDetails(details, error), isError: true, terminate };
      return terminate ? { terminate: true } : undefined;
    });
    this.unsubscribe = harness.subscribe((event) => this.handleEvent(event));
    if (this.disposed) void harness.abort();
    return harness;
  }

  private async handleEvent(event: AgentHarnessEvent) {
    this.options.eventSink.activity();
    if (event.type === "message_start" && event.message.role === "assistant") {
      if (this.suppressApprovalPauseFailure(event.message as RuntimeMessage)) return;
      this.assistantMessageOrdinal += 1;
      this.emit("message.started", { ordinal: this.assistantMessageOrdinal });
    }
    if (event.type === "message_end") {
      this.flushDelta(); this.flushThinkingDelta();
      const sourceMessage = event.message as RuntimeMessage;
      if (this.suppressApprovalPauseFailure(sourceMessage)) return;
      const message = sourceMessage.role === "toolResult" && !sourceMessage.error
        ? { ...sourceMessage, error: structuredToolErrorFromDetails(sourceMessage.details) }
        : sourceMessage;
      if (this.isInternalMessage(message as AgentMessage)) return;
      if (message.role === "assistant") this.lastError = message.stopReason === "error" || message.stopReason === "aborted" ? message.errorMessage : undefined;
      if (this.abortRequested && message.role === "assistant" && message.stopReason === "aborted") return;
      const model = this.harness?.getModel();
      const retained = !this.isDiscardedProviderMessage(sourceMessage as AgentMessage)
        && retainInActiveContext(message as AgentMessage, model?.contextWindow ?? this.options.model?.contextWindow, model?.maxTokens ?? this.options.model?.maxTokens);
      if (retained) {
        this.messages.push(message);
        const transcriptSeq = this.options.eventSink.appendTranscript(message);
        if (transcriptSeq !== undefined) this.emit("transcript.updated", { transcriptSeq, role: message.role, ordinal: message.role === "assistant" ? this.assistantMessageOrdinal : undefined });
      }
      if (message.role === "assistant") {
        const usageTokens = message.usage.totalTokens
          || message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
        if (usageTokens > 0 && message.stopReason !== "error" && message.stopReason !== "aborted" && this.harness) {
          this.lastMeasuredProviderPrefixHash = providerPrefixHash(this.options.systemPrompt, this.harness.getActiveTools(), this.harness.getModel());
        }
        const failure = describeProviderFailure(message, model?.contextWindow ?? this.options.model?.contextWindow, model?.maxTokens ?? this.options.model?.maxTokens);
        const kind = failure?.kind;
        const retryAfterMs = failure?.retryAfterMs ?? this.transportRetryAfterMs;
        this.lastProviderFailure = failure ? {
          kind: failure.kind,
          retryable: isRetryableProviderFailure(failure.kind),
          ...(retryAfterMs ? { retryAfterMs } : {}),
        } : undefined;
        const summary = (message.errorMessage ?? "").replace(/\s+/g, " ").slice(0, 500);
        if (kind && !this.pendingCompaction) {
          this.emit("provider.failure", { kind, retryable: isRetryableProviderFailure(kind), summary, stopReason: message.stopReason, ...(retryAfterMs ? { retryAfterMs } : {}) });
        }
      }
    }
    if (event.type === "turn_end") {
      this.turnNeedsProviderContinuation = (event.toolResults.length > 0 && !this.currentTurnTerminated
        || this.harnessPendingMessageCount > 0 || this.deferredControls.length > 0)
        && this.options.eventSink.isRunning() && !this.options.eventSink.isWaitingForInput();
      this.currentTurnTerminated = false;
    }
    if (event.type === "save_point") {
      await this.appendLiveContextCheckpoint();
      if (this.recoverableOverflowPending) {
        this.recoverableOverflowPending = false;
        this.schedulePendingCompaction("overflow", "Recover from provider context overflow. Preserve unresolved work, completed tool effects, blockers, and exact file paths.");
      } else if (this.turnNeedsProviderContinuation && !this.pendingCompaction && await this.providerContextNeedsCompaction()) {
        this.schedulePendingCompaction("threshold");
      }
      this.turnNeedsProviderContinuation = false;
    }
    if (event.type === "tool_execution_start") {
      this.emit("tool.started", { toolCallId: event.toolCallId, toolName: event.toolName });
      const timer = setInterval(() => this.options.eventSink.activity(), 15_000);
      timer.unref?.();
      this.toolLivenessTimers.set(event.toolCallId, timer);
    }
    if (event.type === "tool_execution_update") {
      const timestamp = Date.now(), previous = this.lastToolProgressAt.get(event.toolCallId) ?? 0;
      if (timestamp - previous >= 1_000) { this.lastToolProgressAt.set(event.toolCallId, timestamp); this.emit("tool.progress", { toolCallId: event.toolCallId, toolName: event.toolName }); }
    }
    if (event.type === "tool_execution_end") {
      const timer = this.toolLivenessTimers.get(event.toolCallId);
      if (timer) clearInterval(timer);
      this.toolLivenessTimers.delete(event.toolCallId);
      this.lastToolProgressAt.delete(event.toolCallId);
      this.emit("tool.completed", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        error: structuredToolErrorFromDetails(event.result?.details),
      });
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") this.queueDelta(event.assistantMessageEvent.delta);
    if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") this.queueThinkingDelta(event.assistantMessageEvent.delta);
    if (event.type === "queue_update") {
      this.harnessPendingMessageCount = event.steer.length + event.followUp.length + event.nextTurn.length;
      this.emit("runtime.queue", { steering: event.steer, followUp: event.followUp, pendingMessageCount: event.steer.length + event.followUp.length + event.nextTurn.length });
    }
    if (event.type === "abort" && (event.clearedSteer.length || event.clearedFollowUp.length)) {
      const text = (message: AgentMessage) => message.role === "user"
        ? (typeof message.content === "string" ? message.content : message.content.filter((part) => part.type === "text").map((part) => part.text).join(""))
        : "";
      this.emit("runtime.queue.cleared", { steering: event.clearedSteer.map(text), followUp: event.clearedFollowUp.map(text) });
    }
    if (event.type === "retry_scheduled") this.emit("context.summarization.retry", { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, summary: event.errorMessage.replace(/\s+/g, " ").slice(0, 500) });
    if (event.type === "retry_attempt_start") this.emit("context.summarization.retry.started", { source: event.operation });
    if (event.type === "retry_finished") this.emit("context.summarization.retry.finished", { source: event.operation });
  }

  private async executeQuery(query: string, skillName?: string) {
    const harness = await this.initialize();
    if (this.disposed) throw new Error("Runtime disposed");
    if (this.abortRequested) throw new Error("Runtime aborted");
    this.streaming = true;
    try {
      const skillPrompt = skillName
        ? `${this.options.skills?.find((skill) => skill.name === skillName)?.content ?? ""}\n${query}`
        : query;
      await this.compactIfNeeded(skillPrompt);
      let assistant = skillName
        ? await this.runHarnessSkill(harness, skillName, query)
        : await this.runHarnessPrompt(harness, query, false);
      let retryAttempt = 0;
      const maxRetries = this.options.providerMaxRetries ?? 1;
      let overflowRecoveryAttempted = false;
      while (!this.abortRequested && this.options.eventSink.isRunning()) {
        if (this.pendingCompaction) {
          const reason = this.pendingCompaction.reason;
          if (reason === "overflow" && overflowRecoveryAttempted) {
            this.rejectPendingCompaction(new Error("Context overflow recovery already attempted for this input"));
            break;
          }
          const compacted = await this.runPendingCompaction();
          if (!compacted) break;
          if (reason === "overflow") overflowRecoveryAttempted = true;
          if (this.abortRequested || !this.options.eventSink.isRunning()) break;
          assistant = await this.continueHarness(harness);
          continue;
        }
        const failure = classifyProviderFailure(assistant, harness.getModel().contextWindow, harness.getModel().maxTokens);
        if (failure === "context_overflow" && !overflowRecoveryAttempted) {
          overflowRecoveryAttempted = true;
          this.recoverableOverflowPending = false;
          const willRetry = assistant.stopReason !== "stop";
          const compacted = await this.tryAutomaticCompaction(
            "overflow",
            "Recover from provider context overflow. Preserve unresolved work, completed tool effects, blockers, and exact file paths.",
            willRetry,
          );
          if (!compacted || !willRetry) break;
          assistant = await this.continueHarness(harness);
          continue;
        }
        if (failure && isRetryableProviderFailure(failure) && retryAttempt < maxRetries) {
          const nextRetryAttempt = retryAttempt + 1;
          const retryAfterMs = this.lastProviderFailure?.kind === failure ? this.lastProviderFailure.retryAfterMs : undefined;
          const delayMs = providerRetryDelayMs(nextRetryAttempt, this.options.runTimeoutMs, this.options.runHardTimeoutMs, retryAfterMs);
          // Never send an inline retry before a provider-supplied window. If the
          // window cannot fit the remaining watchdog budget, the durable
          // continuation scheduler applies it outside this Attempt instead.
          if (retryAfterMs !== undefined && delayMs < retryAfterMs) break;
          retryAttempt = nextRetryAttempt;
          const summary = (assistant.errorMessage ?? "").replace(/\s+/g, " ").slice(0, 500);
          // Establish cancellation ownership before publishing the observable
          // retry state. A controller installed after the event creates a race
          // where manual compaction cannot interrupt the advertised backoff.
          const retryDelay = this.waitForRetry(delayMs);
          this.emit("provider.retry", { attempt: retryAttempt, maxAttempts: maxRetries, delayMs, summary });
          this.emit("message.retrying", { content: messageText(assistant), willRetry: true, ordinal: this.assistantMessageOrdinal });
          if (!await retryDelay) {
            this.emit("provider.retry.completed", {
              success: false,
              attempt: retryAttempt,
              finalError: this.pendingCompactionReason() === "manual" ? "Retry superseded by manual compaction" : "Retry cancelled",
            });
            if (this.pendingCompaction) continue;
            break;
          }
          assistant = await this.continueHarness(harness);
          const nextFailure = classifyProviderFailure(assistant, harness.getModel().contextWindow, harness.getModel().maxTokens);
          this.emit("provider.retry.completed", { success: !nextFailure, attempt: retryAttempt, finalError: assistant.errorMessage?.replace(/\s+/g, " ").slice(0, 500) });
          continue;
        }
        if (failure === "rate_limit" || failure === "model_cooldown") {
          const fallback = this.options.fallbackModels?.[this.fallbackIndex++];
          if (fallback) {
            const previousModel = harness.getModel().id;
            await harness.setModel(toPiModel(fallback));
            retryAttempt = 0;
            this.emit("provider.fallback", { kind: failure, previousModel, model: fallback.id, ordinal: this.fallbackIndex });
            assistant = await this.continueHarness(harness);
            continue;
          }
        }
        if (failure && (this.harnessPendingMessageCount > 0 || this.deferredControls.length > 0)) {
          retryAttempt = 0;
          assistant = await this.continueHarness(harness);
          continue;
        }
        if (failure) break;
        retryAttempt = 0;
        if (!overflowRecoveryAttempted) await this.compactIfNeeded();
        if (this.pendingCompaction || this.harnessPendingMessageCount > 0 || this.deferredControls.length > 0) {
          if (this.pendingCompaction) continue;
          assistant = await this.continueHarness(harness);
          continue;
        }
        break;
      }
      if (this.options.eventSink.isWaitingForInput()) await harness.abort();
      if (!this.abortRequested && this.options.eventSink.isRunning()) {
        this.emit("message.completed", { content: messageText(assistant), willRetry: false, ordinal: this.assistantMessageOrdinal });
      }
    } finally {
      this.streaming = false;
      if (this.approvalPauseActive) {
        this.lastError = undefined;
        this.lastProviderFailure = undefined;
      }
      if (this.pendingCompaction) this.rejectPendingCompaction(new Error("Runtime settled before pending compaction could run"));
      this.emit("runtime.settled", { pendingMessageCount: this.harnessPendingMessageCount + this.deferredControls.length });
    }
  }

  async prompt(query: string) { return this.executeQuery(query); }
  async invokeSkill(name: string, query: string) {
    this.emit("skill.invoked", {
      name,
      sha256: this.options.skills?.find((skill) => skill.name === name)?.sha256 ?? "",
    });
    return this.executeQuery(query, name);
  }

  async steer(instruction: string) { return this.queueControl("steer", instruction); }
  async followUp(instruction: string) { return this.queueControl("followUp", instruction); }
  async compact(instructions?: string) {
    const harness = await this.initialize();
    if (this.compactionPromise) return this.compactionPromise;
    if (!this.streaming) return this.compactWithReason("manual", instructions);
    if (this.pendingCompaction?.promise) return this.pendingCompaction.promise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
    this.pendingCompaction = { reason: "manual", instructions, promise, resolve, reject };
    this.retryDelayAbort?.abort();
    await harness.abort();
    return promise;
  }
  private async compactIfNeeded(upcomingInput?: string) {
    if (!this.session || !this.harness || this.compacting) return;
    if (!await this.providerContextNeedsCompaction(upcomingInput)) return false;
    return this.tryAutomaticCompaction("threshold");
  }
  private async tryAutomaticCompaction(reason: "threshold" | "overflow", instructions?: string, willRetry = reason === "overflow") {
    try { await this.compactWithReason(reason, instructions, willRetry); return true; }
    catch { return false; }
  }
  private async runPendingCompaction() {
    const pending = this.pendingCompaction;
    if (!pending) return false;
    this.pendingCompaction = undefined;
    try {
      await this.compactWithReason(pending.reason, pending.instructions, pending.reason === "overflow");
      this.lastError = undefined;
      this.lastProviderFailure = undefined;
      pending.resolve?.();
      return true;
    } catch (error) {
      pending.reject?.(error);
      if (pending.reason === "manual") throw error;
      return false;
    }
  }
  private async waitForRetry(delayMs: number) {
    if (this.abortRequested) return false;
    const controller = new AbortController();
    this.retryDelayAbort = controller;
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delayMs);
        timer.unref?.();
        controller.signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
      return !controller.signal.aborted && !this.abortRequested;
    } finally {
      if (this.retryDelayAbort === controller) this.retryDelayAbort = undefined;
    }
  }
  private compactWithReason(reason: "manual" | "threshold" | "overflow", instructions?: string, willRetry = reason === "overflow") {
    if (this.compactionPromise) return this.compactionPromise;
    const operation = this.runCompaction(reason, instructions, willRetry);
    this.compactionPromise = operation;
    void operation.finally(() => {
      if (this.compactionPromise === operation) this.compactionPromise = undefined;
    }).catch(() => undefined);
    return operation;
  }
  private async runCompaction(reason: "manual" | "threshold" | "overflow", instructions: string | undefined, willRetry: boolean) {
    const harness = await this.initialize();
    this.compacting = true;
    this.emit("context.compaction.started", { reason });
    try {
      const result = await harness.compact(instructions);
      this.lastLiveContextHash = undefined;
      this.discardedToolCallIds.clear();
      this.recoverableOverflowPending = false;
      await this.refreshActiveMessages();
      this.emit("context.compaction.completed", { reason, aborted: false, willRetry, tokensBefore: result.tokensBefore });
    } catch (error) {
      this.emit("context.compaction.completed", { reason, aborted: this.abortRequested || this.disposed, willRetry: false, error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      this.compacting = false;
    }
  }
  async abort() {
    this.abortRequested = true;
    this.lifetimeAbort.abort(new Error("Runtime aborted"));
    this.retryDelayAbort?.abort();
    this.clearDeferredControls();
    if (this.pendingCompaction) this.rejectPendingCompaction(new Error("Runtime aborted"));
    if (!this.abortPromise) this.abortPromise = (async () => {
      const harness = this.harness ?? await this.initializing?.catch(() => undefined);
      if (harness) await harness.abort();
      await this.compactionPromise?.catch(() => undefined);
    })();
    await this.abortPromise;
  }
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    for (const timer of this.toolLivenessTimers.values()) clearInterval(timer);
    this.toolLivenessTimers.clear();
    this.flushDelta();
    this.flushThinkingDelta();
    this.disposed = true;
    this.disposePromise = this.abort().finally(() => {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
    });
    return this.disposePromise;
  }
  getMessages() { return this.messages; }
  getError() { return this.lastError; }
  getProviderFailure() { return this.lastProviderFailure; }
  getActiveToolNames() { return this.harness?.getActiveTools().map((tool) => tool.name) ?? []; }

  private shouldRetainSessionMessage(message: AgentMessage) {
    const model = this.harness?.getModel();
    if (message.role === "toolResult" && this.discardedToolCallIds.has(message.toolCallId)) {
      this.discardedProviderMessages.add(message);
      return false;
    }
    const retained = retainInActiveContext(
      message,
      model?.contextWindow ?? this.options.model?.contextWindow,
      model?.maxTokens ?? this.options.model?.maxTokens,
    );
    if (!retained && message.role === "assistant") {
      this.discardedProviderMessages.add(message);
      const failure = describeProviderFailure(
        message,
        model?.contextWindow ?? this.options.model?.contextWindow,
        model?.maxTokens ?? this.options.model?.maxTokens,
      );
      if (failure?.kind === "context_overflow" && message.stopReason !== "stop") {
        this.recoverableOverflowPending = true;
        for (const part of message.content) if (part.type === "toolCall") this.discardedToolCallIds.add(part.id);
      }
    }
    return retained;
  }

  private isDiscardedProviderMessage(message: AgentMessage) {
    return this.discardedProviderMessages.has(message)
      || message.role === "toolResult" && this.discardedToolCallIds.has(message.toolCallId);
  }

  private currentLiveContextCheckpoint(): CoreContextCheckpoint | undefined {
    const text = this.options.liveContext?.().trim();
    if (!text) return undefined;
    return { hash: requestHash(text), text, timestamp: Date.now() };
  }

  private async appendLiveContextCheckpoint(session = this.session) {
    if (!session) return undefined;
    const checkpoint = this.currentLiveContextCheckpoint();
    if (!checkpoint || checkpoint.hash === this.lastLiveContextHash) return undefined;
    const previousHash = this.lastLiveContextHash;
    this.lastLiveContextHash = checkpoint.hash;
    try { return await session.appendCoreContextCheckpoint(checkpoint); }
    catch (error) { this.lastLiveContextHash = previousHash; throw error; }
  }

  private projectProviderMessages(messages: AgentMessage[], session = this.session) {
    if (!session) return messages;
    let projected = projectRuntimeHistory(
      messages.filter((message) => !this.isDiscardedProviderMessage(message)),
      this.options.historicalToolResultChars ?? 4_000,
      this.options.historicalTaskRunReceiptChars ?? 600,
      (message) => this.isInternalMessage(message),
      (message) => session.isCoreContextMessage(message),
    );
    if (this.attemptContextMessage && !projected.some((message) => this.isAttemptContextMessage(message))) {
      projected = [this.attemptContextMessage, ...projected];
    }
    return projected;
  }

  private async providerContextNeedsCompaction(upcomingInput?: string) {
    if (!this.session || !this.harness) return false;
    const context = await this.session.buildContext();
    const messages = [...context.messages];
    if (upcomingInput) {
      messages.push({ role: "user", content: [{ type: "text", text: upcomingInput }], timestamp: Date.now() });
    }
    const liveCheckpoint = this.currentLiveContextCheckpoint();
    if (liveCheckpoint && liveCheckpoint.hash !== this.lastLiveContextHash) {
      messages.push(this.session.projectCoreContextCheckpoint(liveCheckpoint));
    }
    const projected = this.projectProviderMessages(messages);
    const budget = providerContextBudget(projected, this.options.systemPrompt, this.harness.getActiveTools(), this.harness.getModel(), this.lastMeasuredProviderPrefixHash);
    return budget.compact;
  }

  private schedulePendingCompaction(reason: Exclude<PendingCompactionReason, "manual">, instructions?: string) {
    if (this.pendingCompaction?.reason === "manual") return;
    if (this.pendingCompaction) {
      if (reason === "overflow") this.pendingCompaction = { ...this.pendingCompaction, reason, instructions };
      return;
    }
    this.pendingCompaction = { reason, instructions };
    this.retryDelayAbort?.abort();
  }

  private rejectPendingCompaction(error: Error) {
    const pending = this.pendingCompaction;
    this.pendingCompaction = undefined;
    pending?.reject?.(error);
  }

  private pendingCompactionReason() {
    return this.pendingCompaction?.reason;
  }

  private suppressApprovalPauseFailure(message: RuntimeMessage) {
    return this.approvalPauseActive
      && message.role === "assistant"
      && (message.stopReason === "error" || message.stopReason === "aborted");
  }

  private isInternalMessage(message: AgentMessage) {
    if (message.role !== "user" || typeof message.content === "string") return false;
    const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
    return this.internalPrompts.has(text);
  }
  private async runHarnessPrompt(harness: AgentHarness<undefined>, text: string, internal: boolean) {
    if (internal) this.internalPrompts.add(text);
    this.harnessTurnActive = true;
    const run = harness.prompt(text);
    try {
      await this.flushDeferredControls(harness);
      return await run;
    } finally {
      this.harnessTurnActive = false;
      if (internal) this.internalPrompts.delete(text);
    }
  }
  private async runHarnessSkill(harness: AgentHarness<undefined>, name: string, instructions: string) {
    this.harnessTurnActive = true;
    const run = harness.skill(name, instructions);
    try {
      await this.flushDeferredControls(harness);
      return await run;
    } finally {
      this.harnessTurnActive = false;
    }
  }
  private continueHarness(harness: AgentHarness<undefined>) {
    const next = this.deferredControls[0];
    if (next?.mode === "followUp") {
      this.deferredControls.shift();
      return this.runHarnessPrompt(harness, next.instruction, false);
    }
    const marker = `[TAgent internal continuation ${++this.internalPromptOrdinal}:${randomUUID()}]`;
    return this.runHarnessPrompt(harness, marker, true);
  }
  private async queueControl(mode: "steer" | "followUp", instruction: string) {
    const harness = await this.initialize();
    if (!this.streaming) return "settled" as const;
    if (this.harnessTurnActive) {
      try {
        if (mode === "steer") await harness.steer(instruction);
        else await harness.followUp(instruction);
        return "accepted" as const;
      } catch (error) {
        if (!(error instanceof AgentHarnessError) || error.code !== "invalid_state" || !this.streaming) throw error;
      }
    }
    this.deferredControls.push({ mode, instruction });
    this.emitDeferredQueue();
    return "accepted" as const;
  }
  private async flushDeferredControls(harness: AgentHarness<undefined>) {
    await deliverDeferredControls(this.deferredControls, harness);
  }
  private emitDeferredQueue() {
    this.emit("runtime.queue", {
      steering: this.deferredControls.filter((control) => control.mode === "steer").map((control) => control.instruction),
      followUp: this.deferredControls.filter((control) => control.mode === "followUp").map((control) => control.instruction),
      pendingMessageCount: this.harnessPendingMessageCount + this.deferredControls.length,
    });
  }
  private clearDeferredControls() {
    if (this.deferredControls.length === 0) return;
    const controls = this.deferredControls.splice(0);
    this.emit("runtime.queue.cleared", {
      steering: controls.filter((control) => control.mode === "steer").map((control) => control.instruction),
      followUp: controls.filter((control) => control.mode === "followUp").map((control) => control.instruction),
    });
  }
  private async refreshActiveMessages() {
    if (!this.session) return;
    const context = await this.session.buildContext();
    this.messages = context.messages.filter((message) => !this.isAttemptContextMessage(message)
      && !this.session?.isCoreContextMessage(message)
      && !this.isDiscardedProviderMessage(message)) as RuntimeMessage[];
  }

  private isAttemptContextMessage(message: AgentMessage) {
    const attemptContext = this.options.attemptContext?.trim();
    if (!attemptContext || message.role !== "user") return false;
    const text = typeof message.content === "string"
      ? message.content
      : message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
    return text === attemptContext;
  }

  private queueDelta(delta: string) { this.pendingDelta += delta; if (this.pendingDelta.length >= 1024) return this.flushDelta(); if (!this.deltaTimer) { this.deltaTimer = setTimeout(() => this.flushDelta(), 150); this.deltaTimer.unref?.(); } }
  private flushDelta() { if (this.deltaTimer) clearTimeout(this.deltaTimer); this.deltaTimer = undefined; if (!this.pendingDelta) return; const delta = this.pendingDelta; this.pendingDelta = ""; this.emit("message.delta", { delta, ordinal: this.assistantMessageOrdinal }); }
  private queueThinkingDelta(delta: string) { this.pendingThinkingDelta += delta; if (this.pendingThinkingDelta.length >= 1024) return this.flushThinkingDelta(); if (!this.thinkingDeltaTimer) { this.thinkingDeltaTimer = setTimeout(() => this.flushThinkingDelta(), 150); this.thinkingDeltaTimer.unref?.(); } }
  private flushThinkingDelta() { if (this.thinkingDeltaTimer) clearTimeout(this.thinkingDeltaTimer); this.thinkingDeltaTimer = undefined; if (!this.pendingThinkingDelta) return; const delta = this.pendingThinkingDelta; this.pendingThinkingDelta = ""; this.emit("message.thinking.delta", { delta, ordinal: this.assistantMessageOrdinal }); }
  private emit<TType extends RunEventType>(type: TType, data: RunEventMap[TType]) { this.options.eventSink.publish(type, data); }
}
