import type { CatalogPrimaryWorkbenchRouteContext } from "../../../features/source-observations/api/primary-workbench-admin-contracts";
import { serializeCatalogPrimaryWorkbenchRouteContext } from "../../../features/source-observations/ui/primary-workbench-route-context";
import type { CatalogScopeRecordDetail } from "../../request-support/api-client";

const DAILY_WORKBENCH_PATH = "/catalog/integrations";
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

// Reuse the shipped daily workbench loader with canonical Scope Record context.
// The path is internal to loader composition only; rendered forms receive the
// real Scope Detail action path and never send the operator to this URL.
export function scopeDetailWorkbenchRequest(request: Request, scope: CatalogScopeRecordDetail): Request {
  const url = new URL(request.url);
  url.pathname = DAILY_WORKBENCH_PATH;
  for (const key of SCOPE_QUERY_KEYS) {
    url.searchParams.delete(key);
  }

  setScopeHierarchy(url.searchParams, scope);
  url.searchParams.set("scopeRecordId", scope.scopeRecordId);
  if (!url.searchParams.get("languageCode")) {
    setNullable(url.searchParams, "languageCode", scope.languageEditions[0] ?? null);
  }

  return new Request(url, request);
}

export function scopeDetailCommandHref(scopeRecordId: string, context: CatalogPrimaryWorkbenchRouteContext): string {
  const query = serializeCatalogPrimaryWorkbenchRouteContext(context).toString();
  const path = `/catalog/scopes/${encodeURIComponent(scopeRecordId)}`;
  return query ? `${path}?${query}` : path;
}

function setScopeHierarchy(searchParams: URLSearchParams, scope: CatalogScopeRecordDetail): void {
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
