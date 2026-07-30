import { Agent, type AgentMessage } from "@mariozechner/pi-agent-core";
import { getModels, type KnownProvider, type Model } from "@mariozechner/pi-ai";
import type { Store } from "../store/store.js";
import type { RunId, RunEvent } from "../core/types.js";
import { createTools } from "../tools/tools.js";

export interface RuntimeOptions {
  store: Store;
  runId: RunId;
  workspace: string;
  systemPrompt: string;
  model?: Model<any>;
  onEvent?: (event: RunEvent) => void;
}

function messageText(message: AgentMessage | undefined) {
  if (!message || !("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export class PiRuntime {
  readonly agent: Agent;
  private readonly store: Store;
  private readonly runId: RunId;
  private readonly onEvent?: (event: RunEvent) => void;

  constructor(options: RuntimeOptions) {
    this.store = options.store;
    this.runId = options.runId;
    this.onEvent = options.onEvent;
    const model = options.model ?? resolveModel();
    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model,
        thinkingLevel: "off",
        tools: createTools(options.store, options.runId, options.workspace),
      },
      toolExecution: "sequential",
      sessionId: options.runId,
      beforeToolCall: async ({ toolCall }) => {
        this.emit("tool.started", { toolCallId: toolCall.id, toolName: toolCall.name, args: toolCall.arguments });
        return undefined;
      },
      afterToolCall: async ({ toolCall, result, isError }) => {
        this.emit("tool.completed", { toolCallId: toolCall.id, toolName: toolCall.name, isError, result: result.details });
        return undefined;
      },
    });
    this.agent.subscribe((event) => {
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
    const event = this.store.appendEvent(this.runId, type, data);
    this.onEvent?.(event);
  }
}

function resolveModel(): Model<any> {
  const provider = (process.env.TAGENT_PROVIDER ?? "openai") as KnownProvider;
  const modelId = process.env.TAGENT_MODEL ?? "gpt-4o-mini";
  const model = getModels(provider).find((candidate) => candidate.id === modelId);
  if (!model) throw new Error(`Unknown pi model ${provider}/${modelId}`);
  return model;
}
