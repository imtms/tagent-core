import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type ContextSource = "session" | "transcript";

export interface ContextAssemblerOptions {
  contextWindow: number;
  maxOutputTokens: number;
  maxTurns: number;
  reserveTokens?: number;
  historicalToolResultChars?: number;
}

export interface ContextAssembly {
  messages: AgentMessage[];
  droppedMessages: AgentMessage[];
  stats: {
    source: ContextSource;
    contextWindow: number;
    systemTokens: number;
    promptTokens: number;
    outputReserveTokens: number;
    safetyReserveTokens: number;
    messageBudgetTokens: number;
    originalMessages: number;
    originalTurns: number;
    keptMessages: number;
    keptTurns: number;
    estimatedMessageTokens: number;
    compressedTurns: number;
    droppedTurns: number;
  };
}

interface Turn {
  messages: AgentMessage[];
  compressed: boolean;
}

export class ContextAssembler {
  constructor(private readonly options: ContextAssemblerOptions) {}

  assemble(source: ContextSource, messages: AgentMessage[], systemPrompt: string, prompt: string): ContextAssembly {
    const contextWindow = this.options.contextWindow;
    const systemTokens = estimateTextTokens(systemPrompt);
    const promptTokens = estimateTextTokens(prompt);
    const outputReserveTokens = Math.min(contextWindow, Math.max(1, this.options.maxOutputTokens));
    const configuredReserve = this.options.reserveTokens;
    const safetyReserveTokens = Math.min(
      contextWindow,
      configuredReserve ?? Math.max(10_000, Math.min(200_000, Math.floor(contextWindow * 0.1))),
    );
    const messageBudgetTokens = Math.max(0, contextWindow - systemTokens - promptTokens - outputReserveTokens - safetyReserveTokens);
    const originalTurns = identifyTurns(messages);
    const turnLimited = originalTurns.slice(-Math.max(1, this.options.maxTurns));
    const prepared = turnLimited.map((turn, index) => this.prepareHistoricalTurn(turn, index === turnLimited.length - 1));
    const kept: Turn[] = [];
    let estimatedMessageTokens = 0;

    for (let index = prepared.length - 1; index >= 0; index -= 1) {
      let turn = prepared[index];
      let turnTokens = estimateTurnTokens(turn);
      if (estimatedMessageTokens + turnTokens > messageBudgetTokens && !turn.compressed) {
        turn = compressTurnToText(turn);
        turnTokens = estimateTurnTokens(turn);
      }
      if (estimatedMessageTokens + turnTokens > messageBudgetTokens) break;
      kept.unshift(turn);
      estimatedMessageTokens += turnTokens;
    }

    const keptMessages = kept.flatMap((turn) => turn.messages);
    const keptSourceTurns = Math.min(kept.length, turnLimited.length);
    const droppedMessages = originalTurns.slice(0, originalTurns.length - keptSourceTurns).flatMap((turn) => turn.messages);
    return {
      messages: keptMessages,
      droppedMessages,
      stats: {
        source,
        contextWindow,
        systemTokens,
        promptTokens,
        outputReserveTokens,
        safetyReserveTokens,
        messageBudgetTokens,
        originalMessages: messages.length,
        originalTurns: originalTurns.length,
        keptMessages: keptMessages.length,
        keptTurns: kept.length,
        estimatedMessageTokens,
        compressedTurns: kept.filter((turn) => turn.compressed).length,
        droppedTurns: originalTurns.length - kept.length,
      },
    };
  }

  private prepareHistoricalTurn(turn: Turn, isLatest: boolean): Turn {
    if (isLatest) return turn;
    const limit = this.options.historicalToolResultChars ?? 20_000;
    return {
      compressed: turn.compressed,
      messages: turn.messages.map((message) => truncateToolContent(message, limit)),
    };
  }
}

export function estimateTextTokens(text: string) {
  if (!text) return 0;
  let nonAscii = 0;
  for (const character of text) if (character.charCodeAt(0) > 127) nonAscii += 1;
  return Math.max(1, Math.ceil(nonAscii * 1.5 + (text.length - nonAscii) * 0.25));
}

export function estimateMessageTokens(message: AgentMessage): number {
  if (!("content" in message)) return 1;
  if (typeof message.content === "string") return estimateTextTokens(message.content);
  let total = 0;
  for (const part of message.content) {
    if (part.type === "text") total += estimateTextTokens(part.text);
    else if (part.type === "image") total += 1_200;
    else if (part.type === "toolCall") total += 50 + estimateTextTokens(JSON.stringify(part.arguments));
    else if (part.type === "thinking") total += estimateTextTokens(part.thinking);
    else total += 30 + estimateTextTokens(JSON.stringify(part));
  }
  return Math.max(1, total);
}

function identifyTurns(messages: AgentMessage[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    if (message.role === "user" || turns.length === 0) turns.push({ messages: [message], compressed: false });
    else turns.at(-1)!.messages.push(message);
  }
  return turns;
}

function estimateTurnTokens(turn: Turn) {
  return turn.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function messageText(message: AgentMessage) {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content.trim();
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function compressTurnToText(turn: Turn): Turn {
  const user = turn.messages.find((message) => message.role === "user");
  const assistant = [...turn.messages].reverse().find((message) => message.role === "assistant" && messageText(message));
  const compressed = [user && textOnlyMessage(user, 10_000), assistant && textOnlyMessage(assistant, 10_000)].filter(Boolean) as AgentMessage[];
  return { messages: compressed, compressed: true };
}

function textOnlyMessage(message: AgentMessage, limit: number): AgentMessage {
  const original = messageText(message);
  const text = original.length > limit ? `${original.slice(0, limit)}\n[Historical text truncated: ${original.length} chars]` : original;
  if (message.role === "user") return { role: "user", content: text, timestamp: message.timestamp };
  if (message.role === "assistant") return { ...message, content: [{ type: "text", text }] };
  return message;
}

function truncateToolContent(message: AgentMessage, limit: number): AgentMessage {
  if (!("content" in message) || typeof message.content === "string") return message;
  let changed = false;
  const content = message.content.map((part) => {
    if (part.type !== "toolCall") return part;
    const argumentsJson = JSON.stringify(part.arguments);
    if (argumentsJson.length <= limit) return part;
    changed = true;
    return { ...part, arguments: { truncated: `${argumentsJson.slice(0, limit)}\n[Historical tool arguments truncated: ${argumentsJson.length} chars]` } };
  });
  return changed ? { ...message, content } as AgentMessage : message;
}
