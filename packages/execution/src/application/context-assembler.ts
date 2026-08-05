import type { RuntimeMessage as AgentMessage } from "../ports/attempt-runtime.js";
import type { ContextManifestItem } from "../domain/task-run.js";

export type ContextSource = "session" | "transcript";

export interface ContextAssemblerOptions {
  contextWindow: number;
  maxOutputTokens: number;
  maxTurns: number;
  historicalToolResultChars?: number;
}

export interface ContextAssembly {
  messages: AgentMessage[];
  droppedMessages: AgentMessage[];
  contextItems: ContextManifestItem[];
  stats: {
    source: ContextSource;
    contextWindow: number;
    systemTokens: number;
    promptTokens: number;
    originalMessages: number;
    originalTurns: number;
    keptMessages: number;
    keptTurns: number;
    estimatedMessageTokens: number;
    compressedTurns: number;
    droppedTurns: number;
  };
}

interface ContextEntry {
  message: AgentMessage;
  sourceId: string;
}

interface Turn {
  entries: ContextEntry[];
  compressed: boolean;
}

export class ContextAssembler {
  constructor(private readonly options: ContextAssemblerOptions) {}

  assemble(source: ContextSource, messages: AgentMessage[], systemPrompt: string, prompt: string, sourceIds: string[] = []): ContextAssembly {
    const contextWindow = this.options.contextWindow;
    const systemTokens = estimateTextTokens(systemPrompt);
    const promptTokens = estimateTextTokens(prompt);
    const entries = messages.map((message, index) => ({ message, sourceId: sourceIds[index] || legacyMessageIdentity(message, index) }));
    const originalTurns = identifyTurns(entries);
    const turnLimited = originalTurns.slice(-Math.max(1, this.options.maxTurns));
    const prepared = turnLimited.map((turn, index) => this.prepareHistoricalTurn(turn, index === turnLimited.length - 1));
    const messageBudget = Math.max(0, contextWindow - this.options.maxOutputTokens - systemTokens - promptTokens);
    const kept: Turn[] = [];
    let estimatedMessageTokens = 0;
    for (let index = prepared.length - 1; index >= 0; index -= 1) {
      const turn = prepared[index];
      const tokens = estimateTurnTokens(turn);
      if (kept.length && estimatedMessageTokens + tokens > messageBudget) continue;
      kept.unshift(turn);
      estimatedMessageTokens += tokens;
    }
    const keptSourceIds = new Set(kept.flatMap((turn) => turn.entries.map((entry) => entry.sourceId)));
    const keptEntries = kept.flatMap((turn) => turn.entries);
    const droppedEntries = originalTurns.flatMap((turn) => turn.entries).filter((entry) => !keptSourceIds.has(entry.sourceId));
    const selectedKind: ContextManifestItem["kind"] = source === "session" ? "session_message" : "transcript_message";
    const contextItems: ContextManifestItem[] = [
      ...keptEntries.map(({ message, sourceId }) => ({ kind: selectedKind, sourceId, role: message.role, selected: true, reason: "selected by recent-turn policy", estimatedTokens: estimateMessageTokens(message) })),
      ...droppedEntries.map(({ message, sourceId }) => ({ kind: selectedKind, sourceId, role: message.role, selected: false, reason: "dropped by turn limit or context-window policy", estimatedTokens: estimateMessageTokens(message) })),
    ];
    return {
      messages: keptEntries.map((entry) => entry.message),
      droppedMessages: droppedEntries.map((entry) => entry.message),
      contextItems,
      stats: {
        source,
        contextWindow,
        systemTokens,
        promptTokens,
        originalMessages: messages.length,
        originalTurns: originalTurns.length,
        keptMessages: keptEntries.length,
        keptTurns: kept.length,
        estimatedMessageTokens,
        compressedTurns: kept.filter((turn) => turn.compressed).length,
        droppedTurns: originalTurns.length - kept.length,
      },
    };
  }

  private prepareHistoricalTurn(turn: Turn, isLatest: boolean): Turn {
    if (isLatest) return turn;
    const limit = this.options.historicalToolResultChars ?? 8_000;
    return {
      compressed: turn.compressed,
      entries: turn.entries.map((entry) => ({ ...entry, message: truncateToolContent(entry.message, limit) })),
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

function identifyTurns(entries: ContextEntry[]): Turn[] {
  const turns: Turn[] = [];
  for (const entry of entries) {
    if (entry.message.role === "user" || turns.length === 0) turns.push({ entries: [entry], compressed: false });
    else turns.at(-1)!.entries.push(entry);
  }
  return turns;
}

function estimateTurnTokens(turn: Turn) {
  return turn.entries.reduce((sum, entry) => sum + estimateMessageTokens(entry.message), 0);
}

function truncateToolContent(message: AgentMessage, limit: number): AgentMessage {
  if (!("content" in message) || typeof message.content === "string") return message;
  let changed = false;
  const content = message.content.map((part) => {
    if (part.type === "toolCall") {
      const argumentsJson = JSON.stringify(part.arguments);
      if (argumentsJson.length <= limit) return part;
      changed = true;
      return { ...part, arguments: { truncated: `${argumentsJson.slice(0, limit)}\n[Historical tool arguments truncated: ${argumentsJson.length} chars]` } };
    }
    if (message.role === "toolResult" && part.type === "text" && part.text.length > limit) {
      changed = true;
      return { ...part, text: `${part.text.slice(0, limit)}\n[Historical tool result truncated: ${part.text.length} chars; full result remains in durable transcript]` };
    }
    return part;
  });
  return changed ? { ...message, content } as AgentMessage : message;
}

function legacyMessageIdentity(message: AgentMessage, index: number) {
  const timestamp = "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : 0;
  return `legacy:${message.role}:${timestamp}:${index}`;
}
