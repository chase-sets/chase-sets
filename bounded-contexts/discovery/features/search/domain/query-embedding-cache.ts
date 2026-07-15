import { createHash } from "node:crypto";
import { normalizeSimpleSearchText } from "./normalization";

export const DEFAULT_QUERY_EMBEDDING_CACHE_MAX_ENTRIES = 1_000;
export const DEFAULT_QUERY_EMBEDDING_CACHE_TTL_MS = 15 * 60 * 1_000;

type CacheEntry = Readonly<{
  expiresAt: number;
  embedding: Promise<readonly number[]>;
}>;

export type QueryEmbeddingCache = Readonly<{
  getOrLoad: (
    input: Readonly<{ model: string; query: string }>,
    load: (normalizedQuery: string) => Promise<readonly number[]>,
  ) => Promise<readonly number[]>;
  size: () => number;
}>;

export function createQueryEmbeddingCache(
  options: Readonly<{
    maxEntries?: number;
    ttlMs?: number;
    now?: () => number;
  }> = {},
): QueryEmbeddingCache {
  const maxEntries = positiveInteger(options.maxEntries ?? DEFAULT_QUERY_EMBEDDING_CACHE_MAX_ENTRIES, "maxEntries");
  const ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_QUERY_EMBEDDING_CACHE_TTL_MS, "ttlMs");
  const now = options.now ?? Date.now;
  const entries = new Map<string, CacheEntry>();

  return {
    async getOrLoad(input, load) {
      const normalizedQuery = normalizeQueryForEmbedding(input.query);
      const key = queryEmbeddingCacheKey(input.model, normalizedQuery);
      const currentTime = now();
      const cached = entries.get(key);
      if (cached && cached.expiresAt > currentTime) {
        entries.delete(key);
        entries.set(key, cached);
        return cached.embedding;
      }
      if (cached) entries.delete(key);

      const embedding = load(normalizedQuery);
      const entry = { expiresAt: currentTime + ttlMs, embedding };
      entries.set(key, entry);
      while (entries.size > maxEntries) {
        const oldestKey = entries.keys().next().value as string | undefined;
        if (oldestKey === undefined) break;
        entries.delete(oldestKey);
      }

      try {
        return await embedding;
      } catch (error) {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      }
    },
    size: () => entries.size,
  };
}

export function normalizeQueryForEmbedding(query: string): string {
  return normalizeSimpleSearchText(query).toLowerCase();
}

export function queryEmbeddingCacheKey(model: string, normalizedQuery: string): string {
  return createHash("sha256").update(`${model.trim()}\0${normalizedQuery}`, "utf8").digest("hex");
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}
