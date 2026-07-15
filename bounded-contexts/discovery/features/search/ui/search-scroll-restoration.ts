import type { DiscoverySearchResponse } from "../../../support/request-support/api-client";

const SEARCH_RESTORATION_STORAGE_KEY = "discovery.search.restoration.v2";
export const MAX_PERSISTED_SEARCH_EXTRA_PAGES = 8;
const MAX_PERSISTED_SEARCH_CHARACTERS = 750_000;
const STORAGE_VERSION = 2;

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

type StoredSearchRestoration = Readonly<{
  version: typeof STORAGE_VERSION;
  resultSetKey: string;
  pages: readonly DiscoverySearchResponse[];
  scrollY: number;
}>;

export type SearchRestoration = Readonly<{
  pages: DiscoverySearchResponse[];
  scrollY: number | null;
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

export function restoreSearchRestoration(storage: SearchPageStorage | null, resultSetKey: string): SearchRestoration {
  if (!storage) {
    return { pages: [], scrollY: null };
  }

  try {
    const value = storage.getItem(SEARCH_RESTORATION_STORAGE_KEY);
    if (!value) {
      return { pages: [], scrollY: null };
    }

    const stored: unknown = JSON.parse(value);
    if (!isStoredSearchRestoration(stored) || stored.resultSetKey !== resultSetKey) {
      storage.removeItem(SEARCH_RESTORATION_STORAGE_KEY);
      return { pages: [], scrollY: null };
    }

    return { pages: [...stored.pages], scrollY: stored.scrollY };
  } catch {
    safelyRemoveStoredPages(storage);
    return { pages: [], scrollY: null };
  }
}

export function persistSearchRestoration(
  storage: SearchPageStorage | null,
  resultSetKey: string,
  pages: readonly DiscoverySearchResponse[],
  scrollY: number,
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
      scrollY: normalizeScrollY(scrollY),
    } satisfies StoredSearchRestoration);
    if (candidate.length > MAX_PERSISTED_SEARCH_CHARACTERS) {
      break;
    }
    persistedPages.push(page);
    serialized = candidate;
  }

  try {
    if (!serialized) {
      storage.removeItem(SEARCH_RESTORATION_STORAGE_KEY);
      return;
    }
    storage.setItem(SEARCH_RESTORATION_STORAGE_KEY, serialized);
  } catch {
    safelyRemoveStoredPages(storage);
  }
}

function isStoredSearchRestoration(value: unknown): value is StoredSearchRestoration {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<StoredSearchRestoration>;
  return (
    candidate.version === STORAGE_VERSION &&
    typeof candidate.resultSetKey === "string" &&
    Array.isArray(candidate.pages) &&
    candidate.pages.length <= MAX_PERSISTED_SEARCH_EXTRA_PAGES &&
    candidate.pages.every(isDiscoverySearchResponse) &&
    typeof candidate.scrollY === "number" &&
    Number.isFinite(candidate.scrollY) &&
    candidate.scrollY >= 0
  );
}

function normalizeScrollY(scrollY: number) {
  return Number.isFinite(scrollY) && scrollY >= 0 ? scrollY : 0;
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
    storage.removeItem(SEARCH_RESTORATION_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in privacy modes; search remains usable without restoration.
  }
}
