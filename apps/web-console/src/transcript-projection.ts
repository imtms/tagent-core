import type { TranscriptItem } from "./api";

/** Merge a cursor delta while letting a later tool result replace its pending call. */
export function mergeTranscriptItems(current: TranscriptItem[], incoming: TranscriptItem[]): TranscriptItem[] {
  const key = (item: TranscriptItem) => item.kind === "tool"
    ? `tool:${item.toolCallId}`
    : `${item.seq}:${item.index ?? 0}:${item.kind}`;
  const items = new Map(current.map((item) => [key(item), item]));
  for (const item of incoming) items.set(key(item), item);
  return [...items.values()].sort(
    (left, right) => left.seq - right.seq || (left.index ?? 0) - (right.index ?? 0),
  );
}
