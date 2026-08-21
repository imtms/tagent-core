import type { WarmMemory } from "./api";

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
