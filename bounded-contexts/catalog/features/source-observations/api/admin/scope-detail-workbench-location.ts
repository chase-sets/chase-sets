// Scope Detail (`/catalog/scopes/:id`) composes the daily import-to-promotion
// journey for its own Scope Record. The working set is the record's hierarchy,
// so the daily surface read derives it here from the record it reads, and every
// client sends the page's own address rather than rewriting it into a daily
// workbench location.

/** The Scope Record fields a Scope Detail working set is built from. */
export type CatalogScopeDetailWorkbenchScope = Readonly<{
  scopeRecordId: string;
  scopeKind: string;
  name: string;
  productDomain: string;
  productLineScopeRecordId: string | null;
  seriesScopeRecordId: string | null;
  languageEditions: readonly string[];
}>;

const DAILY_WORKBENCH_PATH = "/catalog/integrations";

// The working-set keys a Scope Record decides; the address's own values for them
// are dropped so the record, not the query string, names the scope.
const SCOPE_QUERY_KEYS = [
  "providerKey",
  "unitKey",
  "importScope",
  "profileVersion",
  "productLineId",
  "productLineName",
  "seriesId",
  "seriesName",
  "expansionId",
  "expansionName",
] as const;

/** The Scope Record id a Scope Detail path names, or null for any other path. */
export function catalogScopeRecordIdFromPath(pathname: string | null | undefined): string | null {
  const segment = pathname?.match(/^\/catalog\/scopes\/([^/]+)\/?$/)?.[1];
  if (!segment) return null;
  try {
    const value = decodeURIComponent(segment);
    return value.trim() ? value : null;
  } catch {
    return null;
  }
}

/**
 * The daily workbench location for a Scope Detail address: the record's
 * hierarchy and id, its first language edition unless the address names a
 * language, and every other query value the address carries (jobs, previews,
 * selections, pagination) as it was.
 */
export function catalogScopeDetailDailyLocation(location: URL, scope: CatalogScopeDetailWorkbenchScope): URL {
  const url = new URL(location);
  url.pathname = DAILY_WORKBENCH_PATH;
  for (const key of SCOPE_QUERY_KEYS) {
    url.searchParams.delete(key);
  }

  setScopeHierarchy(url.searchParams, scope);
  url.searchParams.set("scopeRecordId", scope.scopeRecordId);
  if (!url.searchParams.get("languageCode")) {
    setNullable(url.searchParams, "languageCode", scope.languageEditions[0] ?? null);
  }

  return url;
}

function setScopeHierarchy(searchParams: URLSearchParams, scope: CatalogScopeDetailWorkbenchScope): void {
  setNullable(searchParams, "productLineName", scope.productDomain);

  switch (scope.scopeKind) {
    case "product-line":
      setNullable(searchParams, "productLineId", scope.scopeRecordId);
      setNullable(searchParams, "productLineName", scope.name);
      return;
    case "series":
      setNullable(searchParams, "productLineId", scope.productLineScopeRecordId);
      setNullable(searchParams, "seriesId", scope.scopeRecordId);
      setNullable(searchParams, "seriesName", scope.name);
      return;
    case "expansion":
    case "set":
      setNullable(searchParams, "productLineId", scope.productLineScopeRecordId);
      setNullable(searchParams, "seriesId", scope.seriesScopeRecordId);
      setNullable(searchParams, "expansionId", scope.scopeRecordId);
      setNullable(searchParams, "expansionName", scope.name);
      return;
  }
}

function setNullable(searchParams: URLSearchParams, key: string, value: string | null | undefined): void {
  const normalized = value?.trim();
  if (normalized) {
    searchParams.set(key, normalized);
  }
}
