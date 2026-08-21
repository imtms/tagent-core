import type { TranscriptItem } from "./api";

export interface ExecutionGroup {
  key: string;
  reasoning: Extract<TranscriptItem, { kind: "thinking" }> | null;
  tools: Extract<TranscriptItem, { kind: "tool" }>[];
  output: Extract<TranscriptItem, { kind: "assistant" }> | null;
}

function executionItemKey(item: TranscriptItem): string {
  return `${item.seq}:${item.index ?? 0}:${item.kind}`;
}

/** Project a flat transcript into reasoning-led stages for compact inspection. */
export function groupExecutionItems(items: TranscriptItem[]): ExecutionGroup[] {
  const groups: ExecutionGroup[] = [];
  let current: ExecutionGroup | null = null;
  const start = (item: TranscriptItem): ExecutionGroup => {
    const group = { key: executionItemKey(item), reasoning: null, tools: [], output: null } satisfies ExecutionGroup;
    groups.push(group);
    current = group;
    return group;
  };

  for (const item of items) {
    if (item.kind === "user") continue;
    if (item.kind === "thinking") {
      current = start(item);
      current.reasoning = item;
      continue;
    }
    if (item.kind === "tool") {
      if (!current || current.output) current = start(item);
      current.tools.push(item);
      continue;
    }
    if (!current || current.output) current = start(item);
    current.output = item;
    current = null;
  }

  return groups;
}

/** Merge a cursor delta while letting a later tool result replace its pending call. */
export function mergeTranscriptItems(current: TranscriptItem[], incoming: TranscriptItem[]): TranscriptItem[] {
  const key = (item: TranscriptItem) => item.kind === "tool"
    ? `tool:${item.toolCallId}`
    : `${item.seq}:${item.index ?? 0}:${item.kind}`;
  const compare = (left: TranscriptItem, right: TranscriptItem) =>
    left.seq - right.seq || (left.index ?? 0) - (right.index ?? 0);
  const updates = new Map(incoming.map((item) => [key(item), item]));
  const seen = new Set<string>();
  const retained: TranscriptItem[] = [];
  for (let index = current.length - 1; index >= 0; index -= 1) {
    const item = current[index]!;
    const itemKey = key(item);
    if (updates.has(itemKey) || seen.has(itemKey)) continue;
    seen.add(itemKey);
    retained.push(item);
  }
  retained.reverse();
  const changed = [...updates.values()].sort(compare);
  const merged: TranscriptItem[] = [];
  let retainedIndex = 0;
  let changedIndex = 0;
  while (retainedIndex < retained.length && changedIndex < changed.length) {
    if (compare(retained[retainedIndex]!, changed[changedIndex]!) <= 0) {
      merged.push(retained[retainedIndex++]!);
    } else {
      merged.push(changed[changedIndex++]!);
    }
  }
  merged.push(...retained.slice(retainedIndex), ...changed.slice(changedIndex));
  return merged;
}
