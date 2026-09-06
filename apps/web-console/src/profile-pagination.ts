interface CursorPage<T> {
  items: T[];
  pageInfo: { hasMore: boolean; nextCursor: string | null };
}

export async function collectCursorItems<T>(load: (cursor?: string) => Promise<CursorPage<T>>): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  while (true) {
    const page = await load(cursor);
    items.push(...page.items);
    if (!page.pageInfo.hasMore) return items;
    const next = page.pageInfo.nextCursor;
    if (!next || seen.has(next)) throw new Error("Profile pagination did not advance");
    seen.add(next);
    cursor = next;
  }
}
