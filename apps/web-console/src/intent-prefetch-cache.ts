export class IntentPrefetchCache<Key, Value> {
  private readonly entries = new Map<Key, { startedAt: number; promise: Promise<Value>; value?: Value }>();

  constructor(
    private readonly ttlMs = 30_000,
    private readonly maxEntries = 6,
    private readonly now: () => number = Date.now,
  ) {}

  peek(key: Key): Value | undefined {
    const entry = this.freshEntry(key);
    return entry?.value;
  }

  load(key: Key, loader: () => Promise<Value>): Promise<Value> {
    const existing = this.freshEntry(key);
    if (existing) return existing.promise;

    const entry: { startedAt: number; promise: Promise<Value>; value?: Value } = {
      startedAt: this.now(),
      promise: Promise.resolve(undefined as Value),
    };
    entry.promise = loader().then((value) => {
      if (this.entries.get(key) === entry) entry.value = value;
      return value;
    }).catch((cause) => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw cause;
    });
    this.entries.set(key, entry);
    this.prune();
    return entry.promise;
  }

  invalidate(key: Key): void {
    this.entries.delete(key);
  }

  private freshEntry(key: Key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.startedAt <= this.ttlMs) return entry;
    this.entries.delete(key);
    return undefined;
  }

  private prune(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as Key | undefined;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
    }
  }
}
