// Scope Detail (`/catalog/scopes/:id`) composes the daily import-to-promotion
// journey for its own Scope Record. The record's hierarchy is the Scope's fixed
// identity, so the daily surface read derives it here from the record it reads;
// the provider, unit, profile, language, import scope and product coordinates are
// selections inside that Scope and pass through from the page's own address.
// Every client sends that address rather than rewriting it into a daily
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

// The hierarchy keys a Scope Record decides; the address's own values for them
// are dropped so the record, not the query string, names the scope. The import
// context renders these as fixed on Scope Detail.
export const CATALOG_SCOPE_RECORD_QUERY_KEYS = [
  "productLineId",
  "productLineName",
  "seriesId",
  "seriesName",
  "expansionId",
  "expansionName",
] as const;

type CatalogScopeRecordQueryKey = (typeof CATALOG_SCOPE_RECORD_QUERY_KEYS)[number];

// The set aliases the scope parser reads in place of an expansion key. Review
// filters on any of these names would otherwise take precedence over the
// record's hierarchy when the observations are read or a command is scoped.
const SCOPE_RECORD_HIERARCHY_KEYS = new Map<string, CatalogScopeRecordQueryKey>([
  ...CATALOG_SCOPE_RECORD_QUERY_KEYS.map((key) => [key, key] as const),
  ["setId", "expansionId"],
  ["setName", "expansionName"],
]);
const REVIEW_FILTER_PREFIX = "filter.";
// The keys that name the Scope Record itself on a command.
const SCOPE_RECORD_ID_KEYS = ["scopeRecordId", "referenceId"] as const;

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
 * language, and every other query value the address carries (provider, unit,
 * profile and import-scope selections, jobs, previews, row selections,
 * pagination) as it was.
 */
export function catalogScopeDetailDailyLocation(location: URL, scope: CatalogScopeDetailWorkbenchScope): URL {
  const url = new URL(location);
  url.pathname = DAILY_WORKBENCH_PATH;
  for (const key of [...url.searchParams.keys()]) {
    if (scopeRecordHierarchyKey(key)) {
      url.searchParams.delete(key);
    }
  }

  setScopeHierarchy(url.searchParams, scope);
  url.searchParams.set("scopeRecordId", scope.scopeRecordId);
  if (!url.searchParams.get("languageCode")) {
    setNullable(url.searchParams, "languageCode", scope.languageEditions[0] ?? null);
  }

  return url;
}

/**
 * A Scope Detail command bound to the Scope Record its path names, or null when
 * the address or form restates a hierarchy value or Scope Record id the record
 * does not have. The bound address is the same one the Scope's read composes,
 * on the Scope's own path; the form keeps every selection and loses only the
 * hierarchy fields, which the address now names.
 */
export function catalogScopeDetailCommandSubmission(
  location: URL,
  formData: FormData,
  scope: CatalogScopeDetailWorkbenchScope,
): Readonly<{ location: URL; formData: FormData }> | null {
  const hierarchy = new URLSearchParams();
  setScopeHierarchy(hierarchy, scope);
  const conflicts = ([key, value]: readonly [string, unknown]) => {
    const submitted = typeof value === "string" ? value.trim() : "";
    if ((SCOPE_RECORD_ID_KEYS as readonly string[]).includes(key)) {
      return Boolean(submitted) && submitted !== scope.scopeRecordId;
    }
    const recordKey = scopeRecordHierarchyKey(key);
    const recordValue = recordKey ? hierarchy.get(recordKey) : null;
    return Boolean(recordValue && submitted && submitted !== recordValue);
  };
  if ([...location.searchParams, ...formData].some(conflicts)) {
    return null;
  }

  const boundLocation = catalogScopeDetailDailyLocation(location, scope);
  boundLocation.pathname = location.pathname;
  const boundFormData = new FormData();
  for (const [key, value] of formData) {
    if (!scopeRecordHierarchyKey(key) && !(SCOPE_RECORD_ID_KEYS as readonly string[]).includes(key)) {
      boundFormData.append(key, value);
    }
  }
  for (const key of SCOPE_RECORD_ID_KEYS) {
    if (formData.has(key)) {
      boundFormData.set(key, scope.scopeRecordId);
    }
  }

  return { location: boundLocation, formData: boundFormData };
}

// The record-owned hierarchy key a query or form key restates: the key itself, a
// set alias, or a review filter on either.
function scopeRecordHierarchyKey(key: string): CatalogScopeRecordQueryKey | null {
  const name = key.startsWith(REVIEW_FILTER_PREFIX) ? key.slice(REVIEW_FILTER_PREFIX.length) : key;
  return SCOPE_RECORD_HIERARCHY_KEYS.get(name) ?? null;
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
