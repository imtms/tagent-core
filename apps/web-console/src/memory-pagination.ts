export const MEMORY_PAGE_SIZE = 100;
export const MEMORY_PAGE_REQUEST_LIMIT = MEMORY_PAGE_SIZE + 1;

export interface MemoryPageWindow<Item, Cursor> {
  items: Item[];
  after: Cursor | undefined;
  hasMore: boolean;
}

export function memoryPageWindow<Item, Cursor>(
  items: readonly Item[],
  cursorOf: (item: Item) => Cursor,
): MemoryPageWindow<Item, Cursor> {
  const visible = items.slice(0, MEMORY_PAGE_SIZE);
  return {
    items: visible,
    after: visible.length ? cursorOf(visible[visible.length - 1]) : undefined,
    hasMore: items.length > MEMORY_PAGE_SIZE,
  };
}

export function mergeMemoryPage<Item>(
  current: readonly Item[],
  incoming: readonly Item[],
  idOf: (item: Item) => string,
): Item[] {
  const merged = new Map(current.map((item) => [idOf(item), item]));
  for (const item of incoming) merged.set(idOf(item), item);
  return [...merged.values()];
}
