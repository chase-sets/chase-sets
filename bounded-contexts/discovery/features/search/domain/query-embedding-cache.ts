import { createHash } from "node:crypto";
import { normalizeSimpleSearchText } from "./normalization";

export const DEFAULT_QUERY_EMBEDDING_CACHE_MAX_ENTRIES = 1_000;
export const DEFAULT_QUERY_EMBEDDING_CACHE_TTL_MS = 15 * 60 * 1_000;
export const DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS = 800;

export type QueryEmbeddingOutcome = "cache-hit" | "joined" | "loaded" | "timeout" | "error" | "not-attempted";
export type QueryEmbeddingWaitObservation = Readonly<{
  outcome: QueryEmbeddingOutcome;
  waiterDurationMs: number;
}>;
export type QueryEmbeddingLoadObservation = Readonly<{
  outcome: "loaded" | "timeout" | "error";
  durationMs: number;
}>;

type CacheEntry = {
  expiresAt: number;
  embedding: Promise<readonly number[]>;
  value?: readonly number[];
};

export type QueryEmbeddingCache = Readonly<{
  getOrLoad: (
    input: Readonly<{
      model: string;
      query: string;
      signal?: AbortSignal;
      onWait?: (observation: QueryEmbeddingWaitObservation) => void;
      onLoad?: (observation: QueryEmbeddingLoadObservation) => void;
    }>,
    load: (
      normalizedQuery: string,
      options: Readonly<{ signal: AbortSignal; timeoutMs: number }>,
    ) => Promise<readonly number[]>,
  ) => Promise<readonly number[]>;
  size: () => number;
}>;

export function createQueryEmbeddingCache(
  options: Readonly<{
    maxEntries?: number;
    ttlMs?: number;
    timeoutMs?: number;
    now?: () => number;
  }> = {},
): QueryEmbeddingCache {
  const maxEntries = positiveInteger(options.maxEntries ?? DEFAULT_QUERY_EMBEDDING_CACHE_MAX_ENTRIES, "maxEntries");
  const ttlMs = positiveInteger(options.ttlMs ?? DEFAULT_QUERY_EMBEDDING_CACHE_TTL_MS, "ttlMs");
  const timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_QUERY_EMBEDDING_TIMEOUT_MS, "timeoutMs");
  if (timeoutMs > 2_147_483_647) throw new Error("timeoutMs exceeds the supported timer range.");
  const now = options.now ?? (() => performance.now());
  const entries = new Map<string, CacheEntry>();

  return {
    async getOrLoad(input, load) {
      if (input.signal?.aborted) {
        observe(input.onWait, { outcome: "not-attempted", waiterDurationMs: 0 });
        throw input.signal.reason;
      }
      const startedAt = now();
      const normalizedQuery = normalizeQueryForEmbedding(input.query);
      const key = queryEmbeddingCacheKey(input.model, normalizedQuery);
      const currentTime = now();
      const cached = entries.get(key);
      let entry: CacheEntry;
      let outcome: QueryEmbeddingOutcome;
      if (cached && cached.expiresAt > currentTime) {
        entries.delete(key);
        entries.set(key, cached);
        if (cached.value) {
          observe(input.onWait, { outcome: "cache-hit", waiterDurationMs: 0 });
          return cached.value;
        }
        entry = cached;
        outcome = "joined";
      } else {
        if (cached) entries.delete(key);
        const loadStartedAt = now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(deadlineError()), timeoutMs);
        const embedding = waitForEmbedding(
          Promise.resolve().then(() => load(normalizedQuery, { signal: controller.signal, timeoutMs })),
          controller.signal,
        );
        entry = { expiresAt: currentTime + ttlMs, embedding };
        entry.embedding = embedding
          .then(
            (value) => {
              entry.value = value;
              observe(input.onLoad, { outcome: "loaded", durationMs: now() - loadStartedAt });
              return value;
            },
            (error: unknown) => {
              if (entries.get(key) === entry) entries.delete(key);
              observe(input.onLoad, {
                outcome: controller.signal.aborted ? "timeout" : "error",
                durationMs: now() - loadStartedAt,
              });
              throw error;
            },
          )
          .finally(() => clearTimeout(timer));
        entries.set(key, entry);
        while (entries.size > maxEntries) {
          const oldestKey = entries.keys().next().value;
          if (oldestKey === undefined) break;
          entries.delete(oldestKey);
        }
        outcome = "loaded";
      }

      const waiter = new AbortController();
      const onAbort = () => waiter.abort(input.signal?.reason);
      input.signal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(() => waiter.abort(deadlineError()), Math.max(0, timeoutMs - (now() - startedAt)));
      try {
        return await waitForEmbedding(entry.embedding, waiter.signal);
      } catch (error) {
        outcome =
          waiter.signal.aborted || (error instanceof DOMException && error.name === "TimeoutError")
            ? "timeout"
            : "error";
        throw error;
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        observe(input.onWait, { outcome, waiterDurationMs: now() - startedAt });
      }
    },
    size: () => entries.size,
  };
}

function deadlineError(): DOMException {
  return new DOMException("Discovery query embedding deadline exceeded.", "TimeoutError");
}

function waitForEmbedding(embedding: Promise<readonly number[]>, signal: AbortSignal): Promise<readonly number[]> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    embedding.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function observe<T>(callback: ((observation: T) => void) | undefined, observation: T): void {
  try {
    callback?.(observation);
  } catch {
    // Exporters cannot affect cache or search availability.
  }
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
