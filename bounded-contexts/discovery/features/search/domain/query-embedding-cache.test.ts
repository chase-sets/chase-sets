import { describe, expect, it, vi } from "vitest";
import { createQueryEmbeddingCache, normalizeQueryForEmbedding, queryEmbeddingCacheKey } from "./query-embedding-cache";

describe("Discovery query embedding cache", () => {
  it("normalizes and hashes query keys without retaining raw query text as the key", () => {
    expect(normalizeQueryForEmbedding("  Blue-Eyes   DRAGON ")).toBe("blue eyes dragon");
    const key = queryEmbeddingCacheKey("voyage-4-lite", "blue eyes dragon");
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).not.toContain("blue");
  });

  it("deduplicates concurrent loads and refreshes LRU order", async () => {
    const cache = createQueryEmbeddingCache({ maxEntries: 2, ttlMs: 1_000 });
    const load = vi.fn(async () => [1, 0] as const);
    const [first, second] = await Promise.all([
      cache.getOrLoad({ model: "model", query: "Pikachu" }, load),
      cache.getOrLoad({ model: "model", query: "  pikachu " }, load),
    ]);

    expect(first).toEqual([1, 0]);
    expect(second).toEqual([1, 0]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("bounds entries, expires old values, and never caches failures", async () => {
    let currentTime = 0;
    const cache = createQueryEmbeddingCache({ maxEntries: 2, ttlMs: 10, now: () => currentTime });
    await cache.getOrLoad({ model: "model", query: "one" }, async () => [1]);
    await cache.getOrLoad({ model: "model", query: "two" }, async () => [2]);
    await cache.getOrLoad({ model: "model", query: "three" }, async () => [3]);
    expect(cache.size()).toBe(2);

    currentTime = 11;
    const expiredLoad = vi.fn(async () => [30]);
    await cache.getOrLoad({ model: "model", query: "three" }, expiredLoad);
    expect(expiredLoad).toHaveBeenCalledTimes(1);

    await expect(
      cache.getOrLoad({ model: "model", query: "failure" }, async () => Promise.reject(new Error("provider"))),
    ).rejects.toThrow("provider");
    const retry = vi.fn(async () => [4]);
    await cache.getOrLoad({ model: "model", query: "failure" }, retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });
});
