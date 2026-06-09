import type { CatalogPrimaryWorkbenchRouteContext } from "../api/primary-workbench-admin-contracts";
import type { CatalogIntegrationUnitKey } from "../api/integration-unit";

const canonicalKeys = new Set([
  "providerKey",
  "unitKey",
  "importScope",
  "profileVersion",
  "selectedObservationIds",
  "jobId",
  "promotionPreviewId",
  "returnPath",
]);

const filterPrefix = "filter.";

export function parseCatalogPrimaryWorkbenchRouteContext(url: string | URL): CatalogPrimaryWorkbenchRouteContext {
  const parsedUrl = typeof url === "string" ? new URL(url) : url;
  const searchParams = parsedUrl.searchParams;

  return {
    providerKey: nullableParam(searchParams, "providerKey"),
    unitKey: nullableParam(searchParams, "unitKey") as CatalogIntegrationUnitKey | null,
    importScope: nullableParam(searchParams, "importScope"),
    profileVersion: nullableParam(searchParams, "profileVersion"),
    sourceObservationFilters: parseSourceObservationFilters(searchParams),
    selectedObservationIds: parseCsvParam(searchParams, "selectedObservationIds"),
    jobId: nullableParam(searchParams, "jobId"),
    promotionPreviewId: nullableParam(searchParams, "promotionPreviewId"),
    returnPath: nullableParam(searchParams, "returnPath"),
  };
}

export function serializeCatalogPrimaryWorkbenchRouteContext(
  context: CatalogPrimaryWorkbenchRouteContext,
): URLSearchParams {
  const searchParams = new URLSearchParams();
  setNullable(searchParams, "providerKey", context.providerKey);
  setNullable(searchParams, "unitKey", context.unitKey);
  setNullable(searchParams, "importScope", context.importScope);
  setNullable(searchParams, "profileVersion", context.profileVersion);
  if (context.selectedObservationIds.length > 0) {
    searchParams.set("selectedObservationIds", context.selectedObservationIds.join(","));
  }
  setNullable(searchParams, "jobId", context.jobId);
  setNullable(searchParams, "promotionPreviewId", context.promotionPreviewId);
  setNullable(searchParams, "returnPath", context.returnPath);

  for (const [key, value] of Object.entries(context.sourceObservationFilters).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (value) {
      searchParams.set(`${filterPrefix}${key}`, value);
    }
  }

  return searchParams;
}

export function catalogPrimaryWorkbenchHref(context: CatalogPrimaryWorkbenchRouteContext, section?: string): string {
  const searchParams = serializeCatalogPrimaryWorkbenchRouteContext(context);
  if (section) {
    searchParams.set("section", section);
  }
  const query = searchParams.toString();

  return query ? `/catalog/integrations?${query}` : "/catalog/integrations";
}

export function catalogPrimaryWorkbenchContextKeysFromUrl(url: string | URL): readonly string[] {
  const parsedUrl = typeof url === "string" ? new URL(url) : url;
  const keys = new Set<string>();
  for (const key of parsedUrl.searchParams.keys()) {
    if (canonicalKeys.has(key)) {
      keys.add(key);
    }
    if (key.startsWith(filterPrefix) && key.length > filterPrefix.length) {
      keys.add("sourceObservationFilters");
    }
  }

  return [...keys].sort();
}

function nullableParam(searchParams: URLSearchParams, key: string): string | null {
  const value = searchParams.get(key);
  return value && value.trim() ? value : null;
}

function parseCsvParam(searchParams: URLSearchParams, key: string): readonly string[] {
  return (searchParams.get(key) ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function parseSourceObservationFilters(searchParams: URLSearchParams): Readonly<Record<string, string>> {
  const filters: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    if (key.startsWith(filterPrefix) && key.length > filterPrefix.length && value.trim()) {
      filters[key.slice(filterPrefix.length)] = value;
    }
  }

  return filters;
}

function setNullable(searchParams: URLSearchParams, key: string, value: string | null): void {
  if (value) {
    searchParams.set(key, value);
  }
}
