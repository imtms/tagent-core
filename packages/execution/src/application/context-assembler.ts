import type { RuntimeMessage as AgentMessage, RuntimeMessagePart } from "../ports/attempt-runtime.js";
import type { ContextManifestItem } from "../domain/task-run.js";

export type ContextSource = "session" | "transcript";

export interface ContextAssemblerOptions {
  contextWindow: number;
  maxOutputTokens: number;
  maxTurns: number;
  historicalToolResultChars?: number;
  historicalTaskRunReceiptChars?: number;
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

  assemble(source: ContextSource, messages: AgentMessage[], systemPrompt: string, prompt: string, sourceIds: string[] = [], tailContext = ""): ContextAssembly {
    const contextWindow = this.options.contextWindow;
    // The dynamic tail is not part of the system prompt, but it consumes the
    // same provider context budget and must participate in history pruning.
    const systemTokens = estimateTextTokens(systemPrompt) + estimateTextTokens(tailContext);
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
      const remaining = Math.max(0, messageBudget - estimatedMessageTokens);
      const tokens = estimateTurnTokens(turn);
      if (tokens > remaining) {
        if (kept.length) continue;
        const projected = projectTurnToBudget(turn, remaining);
        if (!projected) continue;
        kept.unshift(projected);
        estimatedMessageTokens += estimateTurnTokens(projected);
        continue;
      }
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
    const limit = this.options.historicalToolResultChars ?? 4_000;
    const taskRunReceiptLimit = this.options.historicalTaskRunReceiptChars ?? 600;
    let compressed = turn.compressed;
    const entries = turn.entries.map((entry) => {
      const projected = projectHistoricalToolContent(entry.message, limit, taskRunReceiptLimit);
      compressed ||= projected !== entry.message;
      return { ...entry, message: projected };
    });
    return { compressed, entries };
  }
}

function projectTurnToBudget(turn: Turn, tokenBudget: number): Turn | undefined {
  if (tokenBudget <= 0) return undefined;
  const project = (characterLimit: number): Turn => ({
    compressed: true,
    entries: turn.entries.map((entry) => ({
      ...entry,
      message: projectMessageContent(entry.message, characterLimit),
    })),
  });
  let low = 0;
  let high = Math.max(1, ...turn.entries.map((entry) => JSON.stringify(entry.message).length));
  let selected: Turn | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = project(middle);
    if (estimateTurnTokens(candidate) <= tokenBudget) {
      selected = candidate;
      low = middle + 1;
    } else high = middle - 1;
  }
  return selected;
}

function projectMessageContent(message: AgentMessage, limit: number): AgentMessage {
  const bounded = (value: string) => value.length <= limit ? value : `${value.slice(0, Math.max(0, limit - 26))}[context content truncated]`;
  if (message.role === "user") {
    if (typeof message.content === "string") return { ...message, content: bounded(message.content) };
    return { ...message, content: message.content.map((part) => part.type === "text" ? { ...part, text: bounded(part.text) } : part) };
  }
  if (message.role === "assistant") {
    const content: RuntimeMessagePart[] = [];
    for (const part of message.content) {
      if (part.type === "thinking") continue;
      if (part.type === "text") content.push({ ...part, text: bounded(part.text) });
      else content.push({ ...part, arguments: limit ? { contextProjection: true, originalChars: JSON.stringify(part.arguments).length } : {} });
    }
    return { ...message, content } as AgentMessage;
  }
  if (message.role === "toolResult") return { ...message, content: message.content.map((part) => part.type === "text" ? { ...part, text: bounded(part.text) } : part) };
  if (message.role === "custom" && typeof message.content !== "string") return { ...message, content: message.content.map((part) => part.type === "text" ? { ...part, text: bounded(part.text) } : part) };
  if ("content" in message && typeof message.content === "string") return { ...message, content: bounded(message.content) } as AgentMessage;
  if (message.role === "branchSummary") return { ...message, summary: bounded(message.summary) };
  if (message.role === "compactionSummary") return { ...message, summary: bounded(message.summary) };
  if (message.role === "bashExecution") return { ...message, command: bounded(message.command), output: bounded(message.output) };
  return message;
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

function projectHistoricalToolContent(message: AgentMessage, limit: number, taskRunReceiptLimit: number): AgentMessage {
  if (!("content" in message) || typeof message.content === "string") return message;
  let changed = false;
  const content = message.content.flatMap((part) => {
    if (part.type === "thinking") {
      changed = true;
      return [];
    }
    if (part.type === "toolCall") {
      const argumentsJson = JSON.stringify(part.arguments);
      const argumentLimit = part.name === "task_run" ? Math.min(limit, taskRunReceiptLimit) : limit;
      if (argumentsJson.length <= argumentLimit) return part;
      changed = true;
      return { ...part, arguments: { historicalSummary: `${part.name} arguments omitted after ${argumentLimit} of ${argumentsJson.length} chars`, durableTranscript: true } };
    }
    if (message.role === "toolResult" && part.type === "text") {
      if (message.toolName === "task_run") {
        const projected = summarizeTaskRunReceipt(part.text, taskRunReceiptLimit);
        if (projected !== part.text) changed = true;
        return projected === part.text ? part : { ...part, text: projected };
      }
      if (part.text.length > limit) {
        changed = true;
        const marker = `\n[Historical tool result projected: ${part.text.length} chars; full result remains in durable transcript]\n`;
        const head = Math.max(0, Math.floor((limit - marker.length) * .6));
        const tail = Math.max(0, limit - marker.length - head);
        return { ...part, text: `${part.text.slice(0, head)}${marker}${tail ? part.text.slice(-tail) : ""}` };
      }
    }
    return part;
  });
  return changed ? { ...message, content } as AgentMessage : message;
}

function summarizeTaskRunReceipt(text: string, limit: number) {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || parsed.ok !== true || typeof parsed.action !== "string") {
      return text.length <= limit ? text : `${text.slice(0, limit)}\n[Historical task_run output truncated: ${text.length} chars]`;
    }
    const counts = parsed.counts && typeof parsed.counts === "object" ? parsed.counts : undefined;
    const gate = parsed.completionGate && typeof parsed.completionGate === "object"
      ? parsed.completionGate as { passed?: unknown; failures?: unknown[] }
      : undefined;
    const summary = {
      ok: true,
      action: parsed.action,
      status: parsed.status,
      phase: parsed.phase,
      counts,
      completionGate: gate ? { passed: Boolean(gate.passed), failureCount: Array.isArray(gate.failures) ? gate.failures.length : 0 } : undefined,
      historicalReceipt: true,
    };
    const serialized = JSON.stringify(summary);
    return serialized.length <= limit ? serialized : `${serialized.slice(0, limit)}\n[Historical task_run receipt projected]`;
  } catch {
    return text.length <= limit ? text : `${text.slice(0, limit)}\n[Historical task_run output truncated: ${text.length} chars]`;
  }
}

function legacyMessageIdentity(message: AgentMessage, index: number) {
  const timestamp = "timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : 0;
  return `legacy:${message.role}:${timestamp}:${index}`;
}
