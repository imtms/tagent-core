import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAgentSession,
  DefaultResourceLoader,
  type AgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createTools } from "../tools/tools.js";
import type { AgentRuntime, RuntimeOptions } from "./types.js";

function messageText(message: AgentMessage | undefined) {
  if (!message || !("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export class PiRuntime implements AgentRuntime {
  private session?: AgentSession;
  private initializing?: Promise<AgentSession>;
  private unsubscribe?: () => void;
  private disposed = false;

  constructor(private readonly options: RuntimeOptions) {}

  private async initialize() {
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
    await session.followUp(instruction);
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
      retry: {
        enabled: retries > 0,
        maxRetries: retries,
        baseDelayMs: 1_000,
        provider: { timeoutMs: this.options.providerTimeoutMs, maxRetries: 0, maxRetryDelayMs: 15_000 },
      },
    }, { projectTrusted: false });
    const modelRuntime = this.options.modelRuntime ?? await ModelRuntime.create({ modelsPath: null, allowModelNetwork: false });
    if (this.options.model && this.options.apiKey) await modelRuntime.setRuntimeApiKey(this.options.model.provider, this.options.apiKey);
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
      thinkingLevel: this.options.model?.reasoning ? "medium" : "off",
      noTools: "builtin",
      customTools: createTools(this.options.store, this.options.runId, this.options.workspace),
      resourceLoader,
      sessionManager: SessionManager.inMemory(this.options.workspace),
      settingsManager,
    });
    session.agent.state.messages = [...(this.options.initialMessages ?? [])];
    session.agent.beforeToolCall = async ({ toolCall }) => {
      const run = this.options.store.getRun(this.options.runId);
      if (!run) return { block: true, reason: "Run not found" };
      const attempt = this.options.store.recordToolAttempt(this.options.runId, run.attempt, toolCall.id, toolCall.name, toolCall.arguments);
      if (!attempt.guard.blocked) return undefined;
      this.options.store.completeToolAttempt(this.options.runId, run.attempt, toolCall.id, false, attempt.guard.reason);
      this.emit("tool.guard.blocked", { toolCallId: toolCall.id, toolName: toolCall.name, argsHash: attempt.argsHash, reason: attempt.guard.reason });
      return { block: true, reason: `${attempt.guard.reason}. Use a different approach or report the blocker.` };
    };
    session.agent.afterToolCall = async ({ toolCall, isError }) => {
      const run = this.options.store.getRun(this.options.runId);
      if (run) this.options.store.completeToolAttempt(this.options.runId, run.attempt, toolCall.id, !isError, isError ? "Tool execution failed" : "");
      return undefined;
    };
    this.unsubscribe = session.subscribe((event) => this.handleEvent(event));
    if (this.disposed) session.dispose();
    return session;
  }

  private handleEvent(event: Parameters<AgentSession["subscribe"]>[0] extends (event: infer Event) => void ? Event : never) {
    this.options.onActivity?.();
    if (event.type === "message_end") {
      const run = this.options.store.getRun(this.options.runId);
      if (run) this.options.store.appendTranscript(this.options.runId, run.attempt, event.message);
    }
    if (event.type === "tool_execution_start") this.emit("tool.started", { toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
    if (event.type === "tool_execution_update") this.emit("tool.progress", { toolCallId: event.toolCallId, toolName: event.toolName });
    if (event.type === "tool_execution_end") this.emit("tool.completed", { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError });
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") this.emit("message.delta", { delta: event.assistantMessageEvent.delta });
    if (event.type === "agent_end") {
      const final = [...event.messages].reverse().find((message) => message.role === "assistant");
      this.emit("message.completed", { content: messageText(final), willRetry: event.willRetry });
    }
    if (event.type === "queue_update") this.emit("runtime.queue", { steering: event.steering, followUp: event.followUp });
    if (event.type === "auto_retry_start") this.emit("provider.retry", { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, summary: event.errorMessage.replace(/\s+/g, " ").slice(0, 500) });
    if (event.type === "auto_retry_end") this.emit("provider.retry.completed", { success: event.success, attempt: event.attempt, finalError: event.finalError?.replace(/\s+/g, " ").slice(0, 500) });
    if (event.type === "compaction_start") this.emit("context.compaction.started", { reason: event.reason });
    if (event.type === "compaction_end") this.emit("context.compaction.completed", { reason: event.reason, aborted: event.aborted, willRetry: event.willRetry, error: event.errorMessage?.replace(/\s+/g, " ").slice(0, 500) });
  }

  async prompt(query: string) {
    const session = await this.initialize();
    if (this.disposed) throw new Error("Runtime disposed");
    await session.prompt(query);
  }

  async steer(instruction: string) {
    const session = await this.initialize();
    await session.steer(instruction);
  }

  abort() {
    if (this.session) void this.session.abort();
  }

  dispose() {
    this.disposed = true;
    this.unsubscribe?.();
    this.session?.dispose();
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

  private emit(type: string, data: Record<string, unknown>) {
    const event = this.options.store.appendEvent(this.options.runId, type, data);
    this.options.onEvent?.(event);
  }
}
