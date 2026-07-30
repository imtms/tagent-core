import { Agent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import { createModel, loadConfig } from "../config.js";
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
  readonly agent: Agent;

  constructor(private readonly options: RuntimeOptions) {
    const model = options.model ?? createModel(loadConfig().model);
    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model,
        thinkingLevel: model.reasoning ? "medium" : "off",
        tools: createTools(options.store, options.runId, options.workspace),
        messages: options.initialMessages ?? [],
      },
      toolExecution: "sequential",
      sessionId: options.runId,
      getApiKey: () => options.apiKey ?? process.env.OPENAI_API_KEY,
      streamFn: (streamModel, context, streamOptions) => streamSimple(streamModel, context, {
        ...streamOptions,
        maxTokens: streamModel.maxTokens,
        timeoutMs: options.providerTimeoutMs,
        maxRetries: options.providerMaxRetries,
      }),
      maxRetryDelayMs: 15_000,
      beforeToolCall: async ({ toolCall }) => {
        const run = this.options.store.getRun(this.options.runId);
        if (!run) return { block: true, reason: "Run not found" };
        const attempt = this.options.store.recordToolAttempt(this.options.runId, run.attempt, toolCall.id, toolCall.name, toolCall.arguments);
        if (attempt.guard.blocked) {
          this.options.store.completeToolAttempt(this.options.runId, run.attempt, toolCall.id, false, attempt.guard.reason);
          this.emit("tool.guard.blocked", { toolCallId: toolCall.id, toolName: toolCall.name, argsHash: attempt.argsHash, reason: attempt.guard.reason });
          return { block: true, reason: `${attempt.guard.reason}. Use a different approach or report the blocker.` };
        }
        this.emit("tool.started", { toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });
        return undefined;
      },
      afterToolCall: async ({ toolCall, result, isError }) => {
        const run = this.options.store.getRun(this.options.runId);
        if (run) this.options.store.completeToolAttempt(this.options.runId, run.attempt, toolCall.id, !isError, isError ? "Tool execution failed" : "");
        this.emit("tool.completed", { toolCallId: toolCall.id, toolName: toolCall.name, isError, result: result.details });
        return undefined;
      },
    });
    this.agent.subscribe((event) => {
      if (event.type === "message_end") {
        const run = this.options.store.getRun(this.options.runId);
        if (run) this.options.store.appendTranscript(this.options.runId, run.attempt, event.message);
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        this.emit("message.delta", { delta: event.assistantMessageEvent.delta });
      }
      if (event.type === "agent_end") {
        const final = [...event.messages].reverse().find((message) => message.role === "assistant");
        this.emit("message.completed", { content: messageText(final) });
      }
    });
  }

  async prompt(query: string) {
    await this.agent.prompt(query);
  }

  steer(instruction: string) {
    this.agent.steer({ role: "user", content: instruction, timestamp: Date.now() });
  }

  abort() {
    this.agent.abort();
  }

  getMessages() {
    return this.agent.state.messages;
  }

  getError() {
    return this.agent.state.errorMessage;
  }

  private emit(type: string, data: Record<string, unknown>) {
    const event = this.options.store.appendEvent(this.options.runId, type, data);
    this.options.onEvent?.(event);
  }
}
