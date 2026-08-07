import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { classifyProviderFailure, isRetryableProviderFailure } from "./provider-errors.js";
import type { AttemptRuntimePort, AttemptRuntimeSpec } from "@tagent/execution/ports";

export interface PiRuntimeOptions extends Omit<AttemptRuntimeSpec, "fallbackModels" | "model"> {
  model?: Model<Api>;
  fallbackModels?: Model<Api>[];
  modelRuntime?: ModelRuntime;
}

function messageText(message: AgentMessage | undefined) {
  if (!message || !("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function projectRuntimeHistory(messages: AgentMessage[], toolResultLimit: number, taskRunReceiptLimit: number): AgentMessage[] {
  const latestUserIndex = messages.reduce((latest, message, index) => message.role === "user" ? index : latest, -1);
  return messages.map((message, index) => {
    if (index >= latestUserIndex || !("content" in message) || typeof message.content === "string") return message;
    let changed = false;
    const content = message.content.map((part) => {
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
        ? message.details.artifactUri
        : undefined;
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

function compactTaskRunReceipt(text: string, limit: number) {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (!value || value.ok !== true || typeof value.action !== "string") return text.length <= limit ? text : `${text.slice(0, limit)}\n[Historical task_run output projected]`;
    const gate = value.completionGate && typeof value.completionGate === "object" ? value.completionGate as { passed?: unknown; failures?: unknown[] } : undefined;
    return JSON.stringify({
      ok: true,
      action: value.action,
      status: value.status,
      phase: value.phase,
      counts: value.counts,
      completionGate: gate ? { passed: Boolean(gate.passed), failureCount: Array.isArray(gate.failures) ? gate.failures.length : 0 } : undefined,
      historicalReceipt: true,
    }).slice(0, limit);
  } catch {
    return text.length <= limit ? text : `${text.slice(0, limit)}\n[Historical task_run output projected]`;
  }
}

export class PiRuntime implements AttemptRuntimePort {
  private session?: AgentSession;
  private initializing?: Promise<AgentSession>;
  private unsubscribe?: () => void;
  private disposed = false;
  private abortRequested = false;
  private abortPromise?: Promise<void>;
  private assistantMessageOrdinal = 0;
  private pendingDelta = "";
  private pendingThinkingDelta = "";
  private deltaTimer?: ReturnType<typeof setTimeout>;
  private thinkingDeltaTimer?: ReturnType<typeof setTimeout>;
  private lastToolProgressAt = new Map<string, number>();
  private fallbackIndex = 0;

  constructor(private readonly options: PiRuntimeOptions) {}

  async initialize() {
    if (this.session) return this.session;
    if (this.initializing) return this.initializing;
    this.initializing = this.createSession();
    try {
      this.session = await this.initializing;
      return this.session;
    } finally {
      this.initializing = undefined;
    }
  }

  async followUp(instruction: string) {
    const session = await this.initialize();
    if (!session.isStreaming) return "settled" as const;
    await session.followUp(instruction);
    return "accepted" as const;
  }

  async compact(instructions?: string) {
    const session = await this.initialize();
    await session.compact(instructions);
  }

  private async createSession() {
    const retries = this.options.providerMaxRetries ?? 1;
    const settingsManager = SettingsManager.inMemory({
      enableInstallTelemetry: false,
      defaultProjectTrust: "never",
      compaction: { enabled: true },
      httpIdleTimeoutMs: this.options.providerTimeoutMs,
      retry: {
        enabled: retries > 0,
        maxRetries: retries,
        baseDelayMs: 1_000,
        // The OpenAI SDK timeout is an absolute request deadline. Keep it effectively
        // disabled and let undici's header/body idle timeout enforce inactivity instead.
        provider: { timeoutMs: 2_147_483_647, maxRetries: 0, maxRetryDelayMs: 15_000 },
      },
    }, { projectTrusted: false });
    const modelRuntime = this.options.modelRuntime ?? await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    if (this.options.model && !modelRuntime.getProvider(this.options.model.provider)) {
      const configuredModels = [this.options.model, ...(this.options.fallbackModels ?? [])].filter((model) => model.provider === this.options.model!.provider);
      modelRuntime.registerProvider(this.options.model.provider, {
        name: this.options.model.provider,
        api: this.options.model.api,
        baseUrl: this.options.model.baseUrl,
        models: configuredModels.map((model) => ({
          id: model.id,
          name: model.name,
          api: model.api,
          baseUrl: model.baseUrl,
          reasoning: model.reasoning,
          thinkingLevelMap: model.thinkingLevelMap,
          input: [...model.input],
          cost: model.cost,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          headers: model.headers,
          compat: model.compat,
        })),
      });
      await modelRuntime.refresh({ allowNetwork: false });
    }
    if (this.options.apiKey) for (const provider of new Set([this.options.model, ...(this.options.fallbackModels ?? [])].map((model) => model?.provider).filter((value): value is string => Boolean(value)))) await modelRuntime.setRuntimeApiKey(provider, this.options.apiKey, { allowNetwork: false });
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.options.workspace,
      agentDir: this.options.workspace,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => this.options.systemPrompt,
    });
    await resourceLoader.reload();
    const { session } = await createAgentSession({
      cwd: this.options.workspace,
      model: this.options.model,
      modelRuntime,
      thinkingLevel: this.options.model?.reasoning ? (this.options.reasoningEffort ?? "high") : "off",
      noTools: "builtin",
      customTools: [...this.options.capabilities.tools] as AgentTool[],
      resourceLoader,
      sessionManager: SessionManager.inMemory(this.options.workspace),
      settingsManager,
    });
    session.agent.state.messages = [...(this.options.initialMessages ?? [])] as AgentMessage[];
    const piTransformContext = session.agent.transformContext;
    session.agent.transformContext = async (messages, signal) => {
      const transformed = piTransformContext ? await piTransformContext(messages, signal) : messages;
      return projectRuntimeHistory(
        transformed,
        this.options.historicalToolResultChars ?? 4_000,
        this.options.historicalTaskRunReceiptChars ?? 600,
      );
    };
    const piBeforeToolCall = session.agent.beforeToolCall;
    const piAfterToolCall = session.agent.afterToolCall;
    session.agent.beforeToolCall = async (context, signal) => {
      const piResult = await piBeforeToolCall?.(context, signal);
      if (piResult?.block) return piResult;
      const { toolCall, args } = context;
      const guard = this.options.eventSink.beforeToolCall({ toolCallId: toolCall.id, toolName: toolCall.name, args });
      if (!guard.blocked) return undefined;
      this.emit("tool.guard.blocked", { toolCallId: toolCall.id, toolName: toolCall.name, reason: guard.reason });
      return { block: true, reason: `${guard.reason}. Use a different approach or report the blocker.` };
    };
    session.agent.afterToolCall = async (context, signal) => {
      const piResult = await piAfterToolCall?.(context, signal);
      const { toolCall, isError } = context;
      const effectiveError = piResult?.isError ?? isError;
      this.options.eventSink.afterToolCall({ toolCallId: toolCall.id, toolName: toolCall.name, success: !effectiveError, error: effectiveError ? "Tool execution failed" : "" });
      if (this.options.eventSink.isWaitingForInput()) setImmediate(() => void session.abort());
      return piResult;
    };
    this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
    if (this.disposed) session.dispose();
    return session;
  }

  private handleEvent(event: Parameters<AgentSession["subscribe"]>[0] extends (event: infer Event) => void ? Event : never) {
    this.options.eventSink.activity();
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.assistantMessageOrdinal += 1;
      this.emit("message.started", { ordinal: this.assistantMessageOrdinal });
    }
    if (event.type === "message_end") {
      this.flushDelta();
      this.flushThinkingDelta();
      const transcriptSeq = this.options.eventSink.appendTranscript(event.message);
      if (transcriptSeq !== undefined) {
        this.emit("transcript.updated", { transcriptSeq, role: event.message.role, ordinal: event.message.role === "assistant" ? this.assistantMessageOrdinal : undefined });
      }
      if (this.options.eventSink.isRunning() && event.message.role === "assistant") {
        const kind = classifyProviderFailure(event.message, this.options.model?.contextWindow);
        const summary = (event.message.errorMessage ?? "").replace(/\s+/g, " ").slice(0, 500);
        if (kind) this.emit("provider.failure", { kind, retryable: isRetryableProviderFailure(kind), summary, stopReason: event.message.stopReason });
      }
    }
    if (event.type === "tool_execution_start") this.emit("tool.started", { toolCallId: event.toolCallId, toolName: event.toolName });
    if (event.type === "tool_execution_update") {
      const timestamp = Date.now();
      const previous = this.lastToolProgressAt.get(event.toolCallId) ?? 0;
      if (timestamp - previous >= 1_000) {
        this.lastToolProgressAt.set(event.toolCallId, timestamp);
        this.emit("tool.progress", { toolCallId: event.toolCallId, toolName: event.toolName });
      }
    }
    if (event.type === "tool_execution_end") {
      this.lastToolProgressAt.delete(event.toolCallId);
      this.emit("tool.completed", { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") this.queueDelta(event.assistantMessageEvent.delta);
    if (event.type === "message_update" && event.assistantMessageEvent.type === "thinking_delta") this.queueThinkingDelta(event.assistantMessageEvent.delta);
    if (event.type === "agent_end") {
      if (this.options.eventSink.isRunning()) {
        const final = [...event.messages].reverse().find((message) => message.role === "assistant");
        this.emit(event.willRetry ? "message.retrying" : "message.completed", { content: messageText(final), willRetry: event.willRetry, ordinal: this.assistantMessageOrdinal });
      }
    }
    if (event.type === "queue_update") this.emit("runtime.queue", { steering: event.steering, followUp: event.followUp, pendingMessageCount: event.steering.length + event.followUp.length });
    if (event.type === "agent_settled") this.emit("runtime.settled", { pendingMessageCount: this.session?.pendingMessageCount ?? 0 });
    if (event.type === "auto_retry_start") this.emit("provider.retry", { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, summary: event.errorMessage.replace(/\s+/g, " ").slice(0, 500) });
    if (event.type === "auto_retry_end") this.emit("provider.retry.completed", { success: event.success, attempt: event.attempt, finalError: event.finalError?.replace(/\s+/g, " ").slice(0, 500) });
    if (event.type === "compaction_start") this.emit("context.compaction.started", { reason: event.reason });
    if (event.type === "compaction_end") this.emit("context.compaction.completed", { reason: event.reason, aborted: event.aborted, willRetry: event.willRetry, error: event.errorMessage?.replace(/\s+/g, " ").slice(0, 500) });
    if (event.type === "summarization_retry_scheduled") this.emit("context.summarization.retry", { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, summary: event.errorMessage.replace(/\s+/g, " ").slice(0, 500) });
    if (event.type === "summarization_retry_attempt_start") this.emit("context.summarization.retry.started", { source: event.source, ...(event.source === "compaction" ? { reason: event.reason } : {}) });
    if (event.type === "summarization_retry_finished") this.emit("context.summarization.retry.finished", {});
  }

  async prompt(query: string) {
    const session = await this.initialize();
    if (this.disposed) throw new Error("Runtime disposed");
    if (this.abortRequested) throw new Error("Runtime aborted");
    await session.prompt(query);
    while (!this.abortRequested && this.options.eventSink.isRunning()) {
      const last = [...session.messages].reverse().find((message) => message.role === "assistant");
      if (!last || classifyProviderFailure(last, session.model?.contextWindow) !== "rate_limit") break;
      const fallback = this.options.fallbackModels?.[this.fallbackIndex++];
      if (!fallback) break;
      const previousModel = session.model?.id ?? this.options.model?.id ?? "unknown";
      await session.setModel(fallback);
      this.emit("provider.fallback", { kind: "rate_limit", previousModel, model: fallback.id, ordinal: this.fallbackIndex });
      await session.prompt("Retry the same unresolved request using the persisted conversation and tool state. Do not repeat completed work.");
    }
    if (this.options.eventSink.isWaitingForInput() && session.isStreaming) await session.abort();
  }

  async steer(instruction: string) {
    const session = await this.initialize();
    if (!session.isStreaming) return "settled" as const;
    await session.steer(instruction);
    return "accepted" as const;
  }

  async abort() {
    this.abortRequested = true;
    if (!this.abortPromise) {
      this.abortPromise = (async () => {
        const session = this.session ?? await this.initializing?.catch(() => undefined);
        if (session) {
          const cleared = session.clearQueue();
          if (cleared.steering.length || cleared.followUp.length) this.emit("runtime.queue.cleared", cleared);
          await session.abort();
        }
      })();
    }
    await this.abortPromise;
  }

  dispose() {
    this.flushDelta();
    this.flushThinkingDelta();
    this.disposed = true;
    const session = this.session;
    if (!session) return;
    if (session.isIdle) {
      this.unsubscribe?.();
      session.dispose();
      return;
    }
    void this.abort().finally(() => {
      this.unsubscribe?.();
      session.dispose();
    });
  }

  getMessages() {
    return this.session?.messages ?? this.options.initialMessages ?? [];
  }

  getError() {
    return this.session?.agent.state.errorMessage;
  }

  getActiveToolNames() {
    return this.session?.getActiveToolNames() ?? [];
  }

  private queueDelta(delta: string) {
    this.pendingDelta += delta;
    if (this.pendingDelta.length >= 256) return this.flushDelta();
    if (this.deltaTimer) return;
    this.deltaTimer = setTimeout(() => this.flushDelta(), 50);
    this.deltaTimer.unref?.();
  }

  private flushDelta() {
    if (this.deltaTimer) clearTimeout(this.deltaTimer);
    this.deltaTimer = undefined;
    if (!this.pendingDelta) return;
    const delta = this.pendingDelta;
    this.pendingDelta = "";
    this.emit("message.delta", { delta, ordinal: this.assistantMessageOrdinal });
  }

  private queueThinkingDelta(delta: string) {
    this.pendingThinkingDelta += delta;
    if (this.pendingThinkingDelta.length >= 256) return this.flushThinkingDelta();
    if (this.thinkingDeltaTimer) return;
    this.thinkingDeltaTimer = setTimeout(() => this.flushThinkingDelta(), 50);
    this.thinkingDeltaTimer.unref?.();
  }

  private flushThinkingDelta() {
    if (this.thinkingDeltaTimer) clearTimeout(this.thinkingDeltaTimer);
    this.thinkingDeltaTimer = undefined;
    if (!this.pendingThinkingDelta) return;
    const delta = this.pendingThinkingDelta;
    this.pendingThinkingDelta = "";
    this.emit("message.thinking.delta", { delta, ordinal: this.assistantMessageOrdinal });
  }

  private emit(type: string, data: Record<string, unknown>) {
    this.options.eventSink.publish(type, data);
  }
}
