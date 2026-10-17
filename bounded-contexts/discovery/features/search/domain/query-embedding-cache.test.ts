import { afterEach, describe, expect, it, vi } from "vitest";
import { createQueryEmbeddingCache, normalizeQueryForEmbedding, queryEmbeddingCacheKey } from "./query-embedding-cache";

describe("Discovery query embedding cache", () => {
  afterEach(() => vi.useRealTimers());

  describe("independent waiters and bounded shared load", () => {
    it("records staggered owner/joiner waits and one load, then a warm hit", async () => {
      vi.useFakeTimers();
      const cache = createQueryEmbeddingCache();
      const onLoad = vi.fn();
      const ownerWait = vi.fn();
      const joinWait = vi.fn();
      const load = vi.fn(() => new Promise<readonly number[]>((resolve) => setTimeout(() => resolve([1]), 500)));
      const owner = cache.getOrLoad({ model: "m", query: "one", onLoad, onWait: ownerWait }, load);
      await vi.advanceTimersByTimeAsync(200);
      const joined = cache.getOrLoad({ model: "m", query: "ONE", onLoad, onWait: joinWait }, load);
      await vi.advanceTimersByTimeAsync(300);
      await expect(owner).resolves.toEqual([1]);
      await expect(joined).resolves.toEqual([1]);
      expect(ownerWait).toHaveBeenCalledWith({ outcome: "loaded", waiterDurationMs: 500 });
      expect(joinWait).toHaveBeenCalledWith({ outcome: "joined", waiterDurationMs: 300 });
      expect(onLoad).toHaveBeenCalledExactlyOnceWith({ outcome: "loaded", durationMs: 500 });
      await cache.getOrLoad({ model: "m", query: "one", onWait: ownerWait, onLoad }, load);
      expect(ownerWait).toHaveBeenLastCalledWith({ outcome: "cache-hit", waiterDurationMs: 0 });
      expect(load).toHaveBeenCalledTimes(1);
      expect(onLoad).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it("pre-aborted callers never load or poison existing work", async () => {
      const cache = createQueryEmbeddingCache();
      const signal = AbortSignal.abort(new Error("disconnected"));
      const onWait = vi.fn();
      const onLoad = vi.fn();
      const load = vi.fn(async () => [1]);
      await expect(cache.getOrLoad({ model: "m", query: "one", signal, onWait, onLoad }, load)).rejects.toThrow(
        "disconnected",
      );
      expect(load).not.toHaveBeenCalled();
      const pending = cache.getOrLoad({ model: "m", query: "one", onLoad }, load);
      await expect(cache.getOrLoad({ model: "m", query: "one", signal, onWait, onLoad }, load)).rejects.toThrow(
        "disconnected",
      );
      await expect(pending).resolves.toEqual([1]);
      expect(onWait.mock.calls).toEqual([
        [{ outcome: "not-attempted", waiterDurationMs: 0 }],
        [{ outcome: "not-attempted", waiterDurationMs: 0 }],
      ]);
      expect(load).toHaveBeenCalledTimes(1);
      expect(onLoad).toHaveBeenCalledTimes(1);
    });

    it("owner cancellation does not cancel its peer or lose the owner load observation", async () => {
      vi.useFakeTimers();
      const cache = createQueryEmbeddingCache();
      const controller = new AbortController();
      const onLoad = vi.fn();
      const onWait = vi.fn();
      const load = vi.fn(
        (_query, { signal }) =>
          new Promise<readonly number[]>((resolve) => {
            setTimeout(() => {
              expect(signal.aborted).toBe(false);
              resolve([1]);
            }, 500);
          }),
      );
      const owner = cache
        .getOrLoad({ model: "m", query: "one", signal: controller.signal, onLoad, onWait }, load)
        .catch(() => undefined);
      await vi.advanceTimersByTimeAsync(100);
      const peer = cache.getOrLoad({ model: "m", query: "one", onLoad, onWait }, load);
      controller.abort();
      await owner;
      expect(onLoad).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(400);
      await expect(peer).resolves.toEqual([1]);
      expect(onWait.mock.calls).toEqual([
        [{ outcome: "timeout", waiterDurationMs: 100 }],
        [{ outcome: "joined", waiterDurationMs: 400 }],
      ]);
      expect(onLoad).toHaveBeenCalledExactlyOnceWith({ outcome: "loaded", durationMs: 500 });
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(["success", "error", "timeout"] as const)(
      "all waiters gone: shared %s still settles and cleans timers",
      async (outcome) => {
        vi.useFakeTimers();
        const cache = createQueryEmbeddingCache();
        const controller = new AbortController();
        const onLoad = vi.fn();
        let loadSignal: AbortSignal | undefined;
        const pending = cache
          .getOrLoad({ model: "m", query: "one", signal: controller.signal, onLoad }, (_query, { signal }) => {
            loadSignal = signal;
            return new Promise((resolve, reject) => {
              if (outcome !== "timeout")
                setTimeout(() => (outcome === "success" ? resolve([1]) : reject(new Error("provider"))), 500);
            });
          })
          .catch(() => undefined);
        await vi.advanceTimersByTimeAsync(100);
        controller.abort();
        await pending;
        expect(loadSignal?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(700);
        expect(onLoad).toHaveBeenCalledExactlyOnceWith({
          outcome: outcome === "success" ? "loaded" : outcome,
          durationMs: outcome === "timeout" ? 800 : 500,
        });
        expect(cache.size()).toBe(outcome === "success" ? 1 : 0);
        const reload = vi.fn(async () => [2]);
        await expect(cache.getOrLoad({ model: "m", query: "one" }, reload)).resolves.toEqual(
          outcome === "success" ? [1] : [2],
        );
        expect(reload).toHaveBeenCalledTimes(outcome === "success" ? 0 : 1);
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it("late joiners stop at the shared bound and late completion cannot replace a newer load", async () => {
      vi.useFakeTimers();
      const cache = createQueryEmbeddingCache();
      let finish!: (value: readonly number[]) => void;
      const load = vi.fn(
        () =>
          new Promise<readonly number[]>((resolve) => {
            finish = resolve;
          }),
      );
      const ownerWait = vi.fn();
      const peerWait = vi.fn();
      const owner = cache.getOrLoad({ model: "m", query: "one", onWait: ownerWait }, load).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(600);
      const peer = cache.getOrLoad({ model: "m", query: "one", onWait: peerWait }, load).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(200);
      await Promise.all([owner, peer]);
      expect(ownerWait).toHaveBeenCalledWith({ outcome: "timeout", waiterDurationMs: 800 });
      expect(peerWait).toHaveBeenCalledWith({ outcome: "timeout", waiterDurationMs: 200 });
      await cache.getOrLoad({ model: "m", query: "one" }, async () => [2]);
      finish([1]);
      await expect(cache.getOrLoad({ model: "m", query: "one" }, load)).resolves.toEqual([2]);
      expect(load).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each(["resolve", "reject"] as const)(
      "evicted in-flight %s never changes its replacement",
      async (settlement) => {
        const cache = createQueryEmbeddingCache({ maxEntries: 1 });
        let finish!: (value: readonly number[]) => void;
        let fail!: (error: Error) => void;
        const old = cache
          .getOrLoad(
            { model: "m", query: "one" },
            () =>
              new Promise<readonly number[]>((resolve, reject) => {
                finish = resolve;
                fail = reject;
              }),
          )
          .catch(() => undefined);
        await cache.getOrLoad({ model: "m", query: "two" }, async () => [2]);
        await cache.getOrLoad({ model: "m", query: "one" }, async () => [3]);
        if (settlement === "resolve") finish([1]);
        else fail(new Error("old load"));
        await old;
        await expect(cache.getOrLoad({ model: "m", query: "one" }, async () => [4])).resolves.toEqual([3]);
      },
    );
  });
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
