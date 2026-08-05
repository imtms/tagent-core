export interface SemanticCacheEntry {
  cacheKey: string;
  task: string;
  inputHash: string;
  model: string;
  result: unknown;
  createdAt: number;
  expiresAt: number;
}

export interface SemanticCacheRepository {
  getSemanticCacheEntry(cacheKey: string, timestamp?: number): SemanticCacheEntry | undefined;
  putSemanticCacheEntry(entry: SemanticCacheEntry): void;
  deleteExpiredSemanticCacheEntries(timestamp?: number, limit?: number): number;
}
