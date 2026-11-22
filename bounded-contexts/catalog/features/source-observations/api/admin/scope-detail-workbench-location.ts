import { scopeContextFromImportScope } from "../../ui/primary-workbench-scope-context";

// Scope Detail (`/catalog/scopes/:id`) composes the daily import-to-promotion
// journey for its own Scope Record. The record's hierarchy is the Scope's fixed
// identity, so the daily surface read derives it here from the record it reads;
// the provider, unit, profile, language, import scope and product coordinates are
// selections inside that Scope and pass through from the page's own address.
// Parsing an import scope fills the hierarchy levels the record does not name,
// so one that would fill such a level passes only while it lies inside the
// record. Every client sends that address rather than rewriting it into a daily
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
// The import-scope hierarchy levels, top down, and the level each Scope Record
// kind names itself at.
const IMPORT_SCOPE_LEVELS = ["productLineId", "seriesId", "expansionId"] as const;
const SCOPE_RECORD_OWN_LEVEL = new Map<string, (typeof IMPORT_SCOPE_LEVELS)[number]>([
  ["product-line", "productLineId"],
  ["series", "seriesId"],
  ["expansion", "expansionId"],
  ["set", "expansionId"],
]);

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
 * pagination) as it was. An import scope from outside the record that would
 * fill a level the record does not name is dropped, so the record's own
 * hierarchy decides it.
 */
export function catalogScopeDetailDailyLocation(location: URL, scope: CatalogScopeDetailWorkbenchScope): URL {
  return scopeDetailDailyLocation(location, scope, location.searchParams.get("providerKey"));
}

// The daily location with the address's import scope read as `providerKey`
// reads it.
function scopeDetailDailyLocation(
  location: URL,
  scope: CatalogScopeDetailWorkbenchScope,
  providerKey: string | null,
): URL {
  const url = new URL(location);
  url.pathname = DAILY_WORKBENCH_PATH;
  for (const key of [...url.searchParams.keys()]) {
    if (scopeRecordHierarchyKey(key)) {
      url.searchParams.delete(key);
    }
  }
  const importScope = url.searchParams.get("importScope");
  if (importScope && !importScopeInsideScopeRecord(importScope, providerKey, scope)) {
    url.searchParams.delete("importScope");
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
 * does not have. The bound address is the one the Scope's read composes with
 * the command's provider, on the Scope's own path; the form keeps every
 * selection and loses only the hierarchy fields, which the address now names,
 * and an import scope the read would drop, which yields to the address's. The
 * form names the record and its kind, so a sync that submits no reference runs
 * on this record rather than on a level inferred from the selection.
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

  // The command reads every import scope, the address's too, with the provider
  // its form submits, else the address's. Both are checked with that provider,
  // and the bound address names it, so parsing that address reads them alike.
  const submittedProviderKey = formData.get("providerKey");
  const providerKey =
    (typeof submittedProviderKey === "string" && submittedProviderKey.trim()) ||
    location.searchParams.get("providerKey");
  const boundLocation = scopeDetailDailyLocation(location, scope, providerKey);
  boundLocation.pathname = location.pathname;
  if (providerKey) {
    boundLocation.searchParams.set("providerKey", providerKey);
  }
  const boundFormData = new FormData();
  for (const [key, value] of formData) {
    const recordOwned =
      Boolean(scopeRecordHierarchyKey(key)) || (SCOPE_RECORD_ID_KEYS as readonly string[]).includes(key);
    const outsideRecord =
      key === "importScope" &&
      typeof value === "string" &&
      Boolean(value.trim()) &&
      !importScopeInsideScopeRecord(value, providerKey, scope);
    if (!recordOwned && !outsideRecord) {
      boundFormData.append(key, value);
    }
  }
  boundFormData.set("scopeRecordId", scope.scopeRecordId);
  if (formData.has("referenceId")) {
    boundFormData.set("referenceId", scope.scopeRecordId);
  }
  boundFormData.set("referenceKind", scope.scopeKind);

  return { location: boundLocation, formData: boundFormData };
}

// Whether an import scope may travel with the Scope Record. Read as its provider
// reads it, a coordinate that fills only levels the record names is overridden
// by the record there. One that would fill a level the record does not name,
// such as a series' expansion, passes only inside the record: it names the
// record at the record's own level and agrees with the record above that.
function importScopeInsideScopeRecord(
  importScope: string,
  providerKey: string | null,
  scope: CatalogScopeDetailWorkbenchScope,
): boolean {
  const ownLevel = SCOPE_RECORD_OWN_LEVEL.get(scope.scopeKind);
  if (!ownLevel) return false;
  const coordinate = scopeContextFromImportScope(importScope, providerKey);
  const record = new URLSearchParams();
  setScopeHierarchy(record, scope);
  if (IMPORT_SCOPE_LEVELS.every((level) => !coordinate[level] || record.get(level))) {
    return true;
  }
  return IMPORT_SCOPE_LEVELS.slice(0, IMPORT_SCOPE_LEVELS.indexOf(ownLevel) + 1).every((level) => {
    const value = coordinate[level];
    return value ? value === record.get(level) : level !== ownLevel;
  });
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
