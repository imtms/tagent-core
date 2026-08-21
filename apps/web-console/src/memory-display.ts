import type { MemoryStatusResult, WarmMemory } from "./api";

export const formatMemoryDate = (value: number) => new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
}).format(value);

export const memoryTitle = (record: WarmMemory) => record.kind === "preference" ? record.dimension : record.title;
export const memoryContent = (record: WarmMemory) => record.kind === "preference" ? record.value : record.content;
export const memorySignal = (record: WarmMemory) => record.kind === "preference" ? record.strength : record.importance;
export const memoryTextRepeats = (titleValue: string, contentValue: string) => {
  const title = titleValue.trim().toLocaleLowerCase();
  const content = contentValue.trim().toLocaleLowerCase();
  return Boolean(content && (title === content || title.endsWith(content)));
};
export const memoryTitleRepeatsContent = (record: WarmMemory) => {
  return memoryTextRepeats(memoryTitle(record), memoryContent(record));
};

export const memoryStatusSummary = (status: MemoryStatusResult) => {
  const counts = [
    status.records.active > 0 ? `${status.records.active} active` : "",
    status.records.candidate > 0 ? `${status.records.candidate} candidate${status.records.candidate === 1 ? "" : "s"}` : "",
    status.records.disputed > 0 ? `${status.records.disputed} disputed` : "",
    status.coldTopics > 0 ? `${status.coldTopics} cold topic${status.coldTopics === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  return counts.join(" · ") || "No durable memory";
};
