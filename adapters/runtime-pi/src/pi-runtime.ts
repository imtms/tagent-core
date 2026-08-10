import {
  AgentHarness,
  AgentHarnessError,
  DEFAULT_COMPACTION_SETTINGS,
  InMemorySessionStorage,
  Session,
  estimateContextTokens,
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
import { classifyProviderFailure, isRetryableProviderFailure } from "./provider-errors.js";
import { withProviderIdleTimeout } from "./provider-transport.js";
import type {
  AttemptRuntimePort,
  AttemptRuntimeSpec,
  RuntimeMessage,
  RuntimeModelSpec,
  RuntimeTool,
} from "@tagent/execution/ports";

export interface PiRuntimeOptions extends AttemptRuntimeSpec {
  /** Test-only injection point for a preconfigured pi-ai model collection. */
  models?: MutableModels;
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
      // Preserve the conservative generic OpenAI-compatible contract used by
      // the previous runtime. Unknown endpoints frequently reject OpenAI-only
      // optional fields such as `store`.
      compat: {
        supportsStore: false,
        supportsDeveloperRole: true,
        supportsReasoningEffort: spec.reasoning ?? false,
        supportsUsageInStreaming: true,
        maxTokensField: "max_completion_tokens" as const,
        requiresToolResultName: false,
        requiresAssistantAfterToolResult: false,
        requiresThinkingAsText: false,
        requiresReasoningContentOnAssistantMessages: false,
        thinkingFormat: "openai" as const,
        supportsStrictMode: true,
        sendSessionAffinityHeaders: false,
        supportsLongCacheRetention: false,
      },
    } : {}),
  };
}

function providerApi(api: string, idleTimeoutMs: number | undefined, lifetimeSignal: AbortSignal): ProviderStreams {
  if (api === "openai-completions") return withProviderIdleTimeout(openAICompletionsApi(), idleTimeoutMs, lifetimeSignal);
  if (api === "anthropic-messages") return withProviderIdleTimeout(anthropicMessagesApi(), idleTimeoutMs, lifetimeSignal);
  throw new Error(`Unsupported Pi runtime API: ${api}`);
}

function buildModels(options: PiRuntimeOptions, models: Model<Api>[], lifetimeSignal: AbortSignal): MutableModels {
  if (options.models) return options.models;
  const collection = createModels();
  const grouped = new Map<string, Model<Api>[]>();
  for (const model of models) grouped.set(model.provider, [...(grouped.get(model.provider) ?? []), model]);
  for (const [providerId, providerModels] of grouped) {
    const api = Object.fromEntries([...new Set(providerModels.map((model) => model.api))].map((name) => [name, providerApi(name, options.providerTimeoutMs, lifetimeSignal)]));
    collection.setProvider(createProvider({
      id: providerId,
      name: providerId,
      baseUrl: providerModels[0]?.baseUrl,
      models: providerModels,
      auth: {
        apiKey: {
          name: `${providerId} API key`,
          resolve: async () => options.apiKey ? { auth: { apiKey: options.apiKey } } : undefined,
        },
      },
      api,
    }));
  }
  return collection;
}

function toPiTool(tool: RuntimeTool): AgentHarnessTool<undefined> {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.parameters as AgentHarnessTool<undefined>["parameters"],
    prepareArguments: tool.prepareArguments,
    executionMode: tool.executionMode,
    execute: async (toolCallId, params, signal, onUpdate) => tool.execute(
      toolCallId,
      params,
      signal,
      onUpdate ? (update) => onUpdate(update) : undefined,
    ),
  };
}

function messageText(message: AgentMessage | undefined) {
  if (!message || message.role !== "assistant") return "";
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

function projectRuntimeHistory(
  messages: AgentMessage[],
  toolResultLimit: number,
  taskRunReceiptLimit: number,
  isInternalMessage: (message: AgentMessage) => boolean,
): AgentMessage[] {
  const visibleMessages = messages.filter((message) => !isInternalMessage(message));
  const latestUserIndex = visibleMessages.reduce((latest, message, index) => message.role === "user" ? index : latest, -1);
  return visibleMessages.map((message, index) => {
    if (index >= latestUserIndex || (message.role !== "assistant" && message.role !== "toolResult")) return message;
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
  constructor(private readonly isInternalMessage: (message: AgentMessage) => boolean) {
    super(new InMemorySessionStorage());
  }

  override async appendMessage(message: AgentMessage) {
    if (!this.isInternalMessage(message)) return super.appendMessage(message);
    const leafId = await this.getLeafId();
    if (!leafId) throw new Error("Internal continuation requires an existing session context");
    return leafId;
  }
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
  private session?: Session;
  private initializing?: Promise<AgentHarness<undefined>>;
  private unsubscribe?: () => void;
  private disposed = false;
  private streaming = false;
  private abortRequested = false;
  private abortPromise?: Promise<void>;
  private assistantMessageOrdinal = 0;
  private pendingDelta = "";
  private pendingThinkingDelta = "";
  private deltaTimer?: ReturnType<typeof setTimeout>;
  private thinkingDeltaTimer?: ReturnType<typeof setTimeout>;
  private lastToolProgressAt = new Map<string, number>();
  private fallbackIndex = 0;
  private lastError?: string;
  private messages: RuntimeMessage[];
  private compacting = false;
  private compactionPromise?: Promise<void>;
  private readonly lifetimeAbort = new AbortController();
  private harnessTurnActive = false;
  private internalPromptOrdinal = 0;
  private readonly internalPrompts = new Set<string>();
  private deferredControls: Array<{ mode: "steer" | "followUp"; instruction: string }> = [];
  private harnessPendingMessageCount = 0;
  private retryDelayAbort?: AbortController;
  private pendingManualCompaction?: {
    instructions?: string;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  };

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
    const models = buildModels(this.options, [primary, ...fallbacks], this.lifetimeAbort.signal);
    const session = new RuntimeSession((message) => this.isInternalMessage(message));
    this.session = session;
    for (const message of this.options.initialMessages ?? []) await session.appendMessage(message as AgentMessage);
    const harness = new AgentHarness({
      session,
      models,
      model: primary,
      systemPrompt: this.options.systemPrompt,
      tools: this.options.capabilities.tools.map(toPiTool),
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
    harness.on("context", ({ messages }) => ({ messages: projectRuntimeHistory(
      messages,
      this.options.historicalToolResultChars ?? 4_000,
      this.options.historicalTaskRunReceiptChars ?? 600,
      (message) => this.isInternalMessage(message),
    ) }));
    harness.on("tool_call", ({ toolCallId, toolName, input }) => {
      const guard = this.options.eventSink.beforeToolCall({ toolCallId, toolName, args: input });
      if (!guard.blocked) return undefined;
      this.emit("tool.guard.blocked", { toolCallId, toolName, reason: guard.reason });
      return { block: true, reason: `${guard.reason}. Use a different approach or report the blocker.` };
    });
    harness.on("tool_result", ({ toolCallId, toolName, isError }) => {
      this.options.eventSink.afterToolCall({ toolCallId, toolName, success: !isError, error: isError ? "Tool execution failed" : "" });
      if (this.options.eventSink.isWaitingForInput()) setImmediate(() => void harness.abort());
      return undefined;
    });
    this.unsubscribe = harness.subscribe((event) => this.handleEvent(event));
    if (this.disposed) void harness.abort();
    return harness;
  }

  private handleEvent(event: AgentHarnessEvent) {
    this.options.eventSink.activity();
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.assistantMessageOrdinal += 1;
      this.emit("message.started", { ordinal: this.assistantMessageOrdinal });
    }
    if (event.type === "message_end") {
      this.flushDelta(); this.flushThinkingDelta();
      const message = event.message as RuntimeMessage;
      if (this.isInternalMessage(message as AgentMessage)) return;
      if (message.role === "assistant") this.lastError = message.stopReason === "error" || message.stopReason === "aborted" ? message.errorMessage : undefined;
      if (this.abortRequested && message.role === "assistant" && message.stopReason === "aborted") return;
      this.messages.push(message);
      const transcriptSeq = this.options.eventSink.appendTranscript(message);
      if (transcriptSeq !== undefined) this.emit("transcript.updated", { transcriptSeq, role: message.role, ordinal: message.role === "assistant" ? this.assistantMessageOrdinal : undefined });
      if (message.role === "assistant") {
        const kind = classifyProviderFailure(message, this.harness?.getModel().contextWindow ?? this.options.model?.contextWindow);
        const summary = (message.errorMessage ?? "").replace(/\s+/g, " ").slice(0, 500);
        if (kind && !(kind === "aborted" && this.pendingManualCompaction)) {
          this.emit("provider.failure", { kind, retryable: isRetryableProviderFailure(kind), summary, stopReason: message.stopReason });
        }
      }
    }
    if (event.type === "tool_execution_start") this.emit("tool.started", { toolCallId: event.toolCallId, toolName: event.toolName });
    if (event.type === "tool_execution_update") {
      const timestamp = Date.now(), previous = this.lastToolProgressAt.get(event.toolCallId) ?? 0;
      if (timestamp - previous >= 1_000) { this.lastToolProgressAt.set(event.toolCallId, timestamp); this.emit("tool.progress", { toolCallId: event.toolCallId, toolName: event.toolName }); }
    }
    if (event.type === "tool_execution_end") { this.lastToolProgressAt.delete(event.toolCallId); this.emit("tool.completed", { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError }); }
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

  async prompt(query: string) {
    const harness = await this.initialize();
    if (this.disposed) throw new Error("Runtime disposed");
    if (this.abortRequested) throw new Error("Runtime aborted");
    this.streaming = true;
    try {
      await this.compactIfNeeded();
      let assistant = await this.runHarnessPrompt(harness, query, false);
      let retryAttempt = 0;
      const maxRetries = this.options.providerMaxRetries ?? 1;
      let overflowRecoveryAttempted = false;
      while (!this.abortRequested && this.options.eventSink.isRunning()) {
        if (this.pendingManualCompaction) {
          await this.removeTrailingAssistantFromActiveContext(assistant);
          await this.runPendingManualCompaction();
          if (this.abortRequested || !this.options.eventSink.isRunning()) break;
          assistant = await this.continueHarness(harness);
          continue;
        }
        const failure = classifyProviderFailure(assistant, harness.getModel().contextWindow);
        if (failure === "context_overflow" && !overflowRecoveryAttempted) {
          overflowRecoveryAttempted = true;
          const willRetry = assistant.stopReason !== "stop";
          if (willRetry) await this.removeTrailingAssistantFromActiveContext(assistant);
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
          retryAttempt += 1;
          const delayMs = 1_000 * 2 ** (retryAttempt - 1);
          const summary = (assistant.errorMessage ?? "").replace(/\s+/g, " ").slice(0, 500);
          this.emit("provider.retry", { attempt: retryAttempt, maxAttempts: maxRetries, delayMs, summary });
          this.emit("message.retrying", { content: messageText(assistant), willRetry: true, ordinal: this.assistantMessageOrdinal });
          await this.removeTrailingAssistantFromActiveContext(assistant);
          if (!await this.waitForRetry(delayMs)) {
            this.emit("provider.retry.completed", {
              success: false,
              attempt: retryAttempt,
              finalError: this.pendingManualCompaction ? "Retry superseded by manual compaction" : "Retry cancelled",
            });
            if (this.pendingManualCompaction) continue;
            break;
          }
          assistant = await this.continueHarness(harness);
          const nextFailure = classifyProviderFailure(assistant, harness.getModel().contextWindow);
          this.emit("provider.retry.completed", { success: !nextFailure, attempt: retryAttempt, finalError: assistant.errorMessage?.replace(/\s+/g, " ").slice(0, 500) });
          continue;
        }
        if (failure === "rate_limit") {
          const fallback = this.options.fallbackModels?.[this.fallbackIndex++];
          if (fallback) {
            await this.removeTrailingAssistantFromActiveContext(assistant);
            const previousModel = harness.getModel().id;
            await harness.setModel(toPiModel(fallback));
            retryAttempt = 0;
            this.emit("provider.fallback", { kind: "rate_limit", previousModel, model: fallback.id, ordinal: this.fallbackIndex });
            assistant = await this.continueHarness(harness);
            continue;
          }
        }
        if (failure && (this.harnessPendingMessageCount > 0 || this.deferredControls.length > 0)) {
          await this.removeTrailingAssistantFromActiveContext(assistant);
          retryAttempt = 0;
          assistant = await this.continueHarness(harness);
          continue;
        }
        if (failure) break;
        retryAttempt = 0;
        if (!overflowRecoveryAttempted) await this.compactIfNeeded();
        if (this.pendingManualCompaction || this.harnessPendingMessageCount > 0 || this.deferredControls.length > 0) {
          if (this.pendingManualCompaction) continue;
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
      if (this.pendingManualCompaction) {
        const pending = this.pendingManualCompaction;
        this.pendingManualCompaction = undefined;
        pending.reject(new Error("Runtime settled before manual compaction could run"));
      }
      this.emit("runtime.settled", { pendingMessageCount: this.harnessPendingMessageCount + this.deferredControls.length });
    }
  }

  async steer(instruction: string) { return this.queueControl("steer", instruction); }
  async followUp(instruction: string) { return this.queueControl("followUp", instruction); }
  async compact(instructions?: string) {
    const harness = await this.initialize();
    if (this.compactionPromise) return this.compactionPromise;
    if (!this.streaming) return this.compactWithReason("manual", instructions);
    if (this.pendingManualCompaction) return this.pendingManualCompaction.promise;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
    this.pendingManualCompaction = { instructions, promise, resolve, reject };
    this.retryDelayAbort?.abort();
    await harness.abort();
    return promise;
  }
  private async compactIfNeeded() {
    if (!this.session || !this.harness || this.compacting) return;
    const context = await this.session.buildContext();
    const contextTokens = estimateContextTokens(context.messages).tokens;
    if (!shouldCompact(contextTokens, this.harness.getModel().contextWindow, DEFAULT_COMPACTION_SETTINGS)) return;
    await this.tryAutomaticCompaction("threshold");
  }
  private async tryAutomaticCompaction(reason: "threshold" | "overflow", instructions?: string, willRetry = reason === "overflow") {
    try { await this.compactWithReason(reason, instructions, willRetry); return true; }
    catch { return false; }
  }
  private async runPendingManualCompaction() {
    const pending = this.pendingManualCompaction;
    if (!pending) return;
    try {
      await this.compactWithReason("manual", pending.instructions);
      this.lastError = undefined;
      pending.resolve();
    } catch (error) {
      pending.reject(error);
      throw error;
    } finally {
      if (this.pendingManualCompaction === pending) this.pendingManualCompaction = undefined;
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
    if (this.pendingManualCompaction) {
      const pending = this.pendingManualCompaction;
      this.pendingManualCompaction = undefined;
      pending.reject(new Error("Runtime aborted"));
    }
    if (!this.abortPromise) this.abortPromise = (async () => {
      const harness = this.harness ?? await this.initializing?.catch(() => undefined);
      if (harness) await harness.abort();
      await this.compactionPromise?.catch(() => undefined);
    })();
    await this.abortPromise;
  }
  dispose() {
    this.flushDelta();
    this.flushThinkingDelta();
    this.disposed = true;
    if (!this.streaming && !this.compactionPromise && !this.initializing) {
      this.lifetimeAbort.abort(new Error("Runtime disposed"));
      this.unsubscribe?.();
      if (this.harness) void this.harness.abort().catch(() => undefined);
      return;
    }
    void this.abort().finally(() => this.unsubscribe?.()).catch(() => undefined);
  }
  getMessages() { return this.messages; }
  getError() { return this.lastError; }
  getActiveToolNames() { return this.harness?.getActiveTools().map((tool) => tool.name) ?? []; }

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
  private continueHarness(harness: AgentHarness<undefined>) {
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
    while (this.deferredControls.length > 0) {
      const control = this.deferredControls[0];
      // A response already ended before controls entered this adapter-owned
      // gap queue. Inject both modes at the start of the continuation so a
      // follow-up does not cause an unprompted retry before it is delivered.
      await harness.steer(control.instruction);
      this.deferredControls.shift();
    }
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
  private async removeTrailingAssistantFromActiveContext(assistant: AgentMessage) {
    if (!this.session || assistant.role !== "assistant") return;
    const leafId = await this.session.getLeafId();
    if (!leafId) return;
    const leaf = await this.session.getEntry(leafId);
    if (leaf?.type !== "message" || leaf.message !== assistant) return;
    await this.session.getStorage().setLeafId(leaf.parentId);
    const index = this.messages.lastIndexOf(assistant as RuntimeMessage);
    if (index !== -1) this.messages.splice(index, 1);
  }
  private async refreshActiveMessages() {
    if (!this.session) return;
    const context = await this.session.buildContext();
    this.messages = context.messages as RuntimeMessage[];
  }

  private queueDelta(delta: string) { this.pendingDelta += delta; if (this.pendingDelta.length >= 1024) return this.flushDelta(); if (!this.deltaTimer) { this.deltaTimer = setTimeout(() => this.flushDelta(), 150); this.deltaTimer.unref?.(); } }
  private flushDelta() { if (this.deltaTimer) clearTimeout(this.deltaTimer); this.deltaTimer = undefined; if (!this.pendingDelta) return; const delta = this.pendingDelta; this.pendingDelta = ""; this.emit("message.delta", { delta, ordinal: this.assistantMessageOrdinal }); }
  private queueThinkingDelta(delta: string) { this.pendingThinkingDelta += delta; if (this.pendingThinkingDelta.length >= 1024) return this.flushThinkingDelta(); if (!this.thinkingDeltaTimer) { this.thinkingDeltaTimer = setTimeout(() => this.flushThinkingDelta(), 150); this.thinkingDeltaTimer.unref?.(); } }
  private flushThinkingDelta() { if (this.thinkingDeltaTimer) clearTimeout(this.thinkingDeltaTimer); this.thinkingDeltaTimer = undefined; if (!this.pendingThinkingDelta) return; const delta = this.pendingThinkingDelta; this.pendingThinkingDelta = ""; this.emit("message.thinking.delta", { delta, ordinal: this.assistantMessageOrdinal }); }
  private emit(type: string, data: Record<string, unknown>) { this.options.eventSink.publish(type, data); }
}
