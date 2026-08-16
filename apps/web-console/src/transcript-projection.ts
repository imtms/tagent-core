import type { TranscriptItem } from "./api";

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
