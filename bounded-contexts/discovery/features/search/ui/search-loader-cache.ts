const SEARCH_LOADER_CACHE_STORAGE_KEY = "discovery.search.loader-cache.v1";
const CACHE_VERSION = 1;
const MAX_CACHED_ENTRIES = 8;
const MAX_CACHE_CHARACTERS = 1_000_000;
export const SEARCH_LOADER_CACHE_TTL_MS = 5 * 60 * 1000;

type SearchLoaderCacheStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type CacheEntry = Readonly<{ key: string; data: unknown; savedAt: number }>;

type StoredLoaderCache = Readonly<{ version: typeof CACHE_VERSION; entries: readonly CacheEntry[] }>;

/**
 * Reduce a loader URL to a stable, origin-independent cache key so a server-rendered
 * first visit and a client-side back navigation to the same Result Set collide.
 */
export function searchLoaderCacheKey(url: string): string {
  try {
    const parsed = new URL(url, "http://discovery.search.local");
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/**
 * Return the cached loader payload for a Result Set URL when it is still within the
 * freshness window, so back/forward navigation restores instantly instead of blocking
 * on a fresh server round-trip. Expired or foreign entries yield null so the caller
 * falls back to the authoritative server loader.
 */
export function readCachedSearchLoaderData<T>(
  storage: SearchLoaderCacheStorage | null,
  key: string,
  now: number = Date.now(),
  ttlMs: number = SEARCH_LOADER_CACHE_TTL_MS,
): T | null {
  if (!storage) {
    return null;
  }

  try {
    const value = storage.getItem(SEARCH_LOADER_CACHE_STORAGE_KEY);
    if (!value) {
      return null;
    }

    const stored: unknown = JSON.parse(value);
    if (!isStoredLoaderCache(stored)) {
      storage.removeItem(SEARCH_LOADER_CACHE_STORAGE_KEY);
      return null;
    }

    const entry = stored.entries.find((candidate) => candidate.key === key);
    if (!entry || now - entry.savedAt > ttlMs) {
      return null;
    }

    return entry.data as T;
  } catch {
    safelyClear(storage);
    return null;
  }
}

/**
 * Persist a Result Set loader payload keyed by its canonical URL. Newest entries win,
 * expired entries are pruned, and the cache is bounded by both entry count and byte
 * budget so a long browsing session cannot exhaust session storage.
 */
export function cacheSearchLoaderData(
  storage: SearchLoaderCacheStorage | null,
  key: string,
  data: unknown,
  now: number = Date.now(),
  ttlMs: number = SEARCH_LOADER_CACHE_TTL_MS,
) {
  if (!storage) {
    return;
  }

  const existing = readStoredEntries(storage).filter((entry) => entry.key !== key && now - entry.savedAt <= ttlMs);
  const entries: CacheEntry[] = [{ key, data, savedAt: now }, ...existing].slice(0, MAX_CACHED_ENTRIES);

  try {
    let serialized = serialize(entries);
    while (entries.length > 1 && serialized.length > MAX_CACHE_CHARACTERS) {
      entries.pop();
      serialized = serialize(entries);
    }
    if (serialized.length > MAX_CACHE_CHARACTERS) {
      // A single entry that will not fit is not worth evicting the store for; skip caching.
      return;
    }
    storage.setItem(SEARCH_LOADER_CACHE_STORAGE_KEY, serialized);
  } catch {
    safelyClear(storage);
  }
}

function readStoredEntries(storage: SearchLoaderCacheStorage): CacheEntry[] {
  try {
    const value = storage.getItem(SEARCH_LOADER_CACHE_STORAGE_KEY);
    if (!value) {
      return [];
    }
    const stored: unknown = JSON.parse(value);
    return isStoredLoaderCache(stored) ? [...stored.entries] : [];
  } catch {
    return [];
  }
}

function serialize(entries: readonly CacheEntry[]): string {
  return JSON.stringify({ version: CACHE_VERSION, entries } satisfies StoredLoaderCache);
}

function isStoredLoaderCache(value: unknown): value is StoredLoaderCache {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<StoredLoaderCache>;
  return (
    candidate.version === CACHE_VERSION &&
    Array.isArray(candidate.entries) &&
    candidate.entries.every(
      (entry) =>
        entry != null &&
        typeof entry === "object" &&
        typeof (entry as CacheEntry).key === "string" &&
        typeof (entry as CacheEntry).savedAt === "number" &&
        Number.isFinite((entry as CacheEntry).savedAt) &&
        "data" in entry,
    )
  );
}

function safelyClear(storage: SearchLoaderCacheStorage) {
  try {
    storage.removeItem(SEARCH_LOADER_CACHE_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in privacy modes; restoration degrades to a fresh load.
  }
}
