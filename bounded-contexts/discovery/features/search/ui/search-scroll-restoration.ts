import type { DiscoverySearchResponse } from "../../../support/request-support/api-client";

const SEARCH_EXTRA_PAGES_STORAGE_KEY = "discovery.search.extra-pages.v1";
export const MAX_PERSISTED_SEARCH_EXTRA_PAGES = 8;
const MAX_PERSISTED_SEARCH_CHARACTERS = 750_000;
const STORAGE_VERSION = 1;

type SearchResultSetIdentity = Readonly<{
  search: string;
  category: string;
  tag: string;
  language: string;
  marketActivity: string;
  priceMin: string;
  priceMax: string;
  inStock: boolean;
  sort: string;
  dynamicFilters: readonly Readonly<{ kind: string; id: string; value: string }>[];
}>;

type SearchPageStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

type StoredSearchExtraPages = Readonly<{
  version: typeof STORAGE_VERSION;
  resultSetKey: string;
  pages: readonly DiscoverySearchResponse[];
}>;

export function buildSearchResultSetKey(identity: SearchResultSetIdentity): string {
  return JSON.stringify([
    identity.search,
    identity.category,
    identity.tag,
    identity.language,
    identity.marketActivity,
    identity.priceMin,
    identity.priceMax,
    identity.inStock,
    identity.sort,
    identity.dynamicFilters,
  ]);
}

export function restoreSearchExtraPages(storage: SearchPageStorage | null, resultSetKey: string) {
  if (!storage) {
    return [];
  }

  try {
    const value = storage.getItem(SEARCH_EXTRA_PAGES_STORAGE_KEY);
    if (!value) {
      return [];
    }

    const stored: unknown = JSON.parse(value);
    if (!isStoredSearchExtraPages(stored) || stored.resultSetKey !== resultSetKey) {
      storage.removeItem(SEARCH_EXTRA_PAGES_STORAGE_KEY);
      return [];
    }

    return [...stored.pages];
  } catch {
    safelyRemoveStoredPages(storage);
    return [];
  }
}

export function persistSearchExtraPages(
  storage: SearchPageStorage | null,
  resultSetKey: string,
  pages: readonly DiscoverySearchResponse[],
) {
  if (!storage) {
    return;
  }

  let serialized: string | null = null;
  const persistedPages: DiscoverySearchResponse[] = [];

  for (const page of pages.slice(0, MAX_PERSISTED_SEARCH_EXTRA_PAGES)) {
    const candidatePages = [...persistedPages, page];
    const candidate = JSON.stringify({
      version: STORAGE_VERSION,
      resultSetKey,
      pages: candidatePages,
    } satisfies StoredSearchExtraPages);
    if (candidate.length > MAX_PERSISTED_SEARCH_CHARACTERS) {
      break;
    }
    persistedPages.push(page);
    serialized = candidate;
  }

  try {
    if (!serialized) {
      storage.removeItem(SEARCH_EXTRA_PAGES_STORAGE_KEY);
      return;
    }
    storage.setItem(SEARCH_EXTRA_PAGES_STORAGE_KEY, serialized);
  } catch {
    safelyRemoveStoredPages(storage);
  }
}

function isStoredSearchExtraPages(value: unknown): value is StoredSearchExtraPages {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<StoredSearchExtraPages>;
  return (
    candidate.version === STORAGE_VERSION &&
    typeof candidate.resultSetKey === "string" &&
    Array.isArray(candidate.pages) &&
    candidate.pages.length <= MAX_PERSISTED_SEARCH_EXTRA_PAGES &&
    candidate.pages.every(isDiscoverySearchResponse)
  );
}

function isDiscoverySearchResponse(value: unknown): value is DiscoverySearchResponse {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<DiscoverySearchResponse>;
  return (
    Array.isArray(candidate.items) &&
    Array.isArray(candidate.facets) &&
    typeof candidate.count === "number" &&
    (candidate.nextCursor === null || typeof candidate.nextCursor === "string")
  );
}

function safelyRemoveStoredPages(storage: SearchPageStorage) {
  try {
    storage.removeItem(SEARCH_EXTRA_PAGES_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in privacy modes; search remains usable without restoration.
  }
}
