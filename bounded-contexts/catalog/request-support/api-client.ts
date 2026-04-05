import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
export {
  CatalogApiError,
  catalogApi,
  createCatalogApiClient,
} from "../client";
export type {
  Blueprint,
  BlueprintDetail,
  CatalogApiClientOptions,
  CatalogItemDetail,
  CatalogItemListItem,
  CategoryDetail,
  CategoryListItem,
  Component,
  ComponentDetail,
  Dimension,
  DimensionDetail,
  Field,
} from "../client";
import { createCatalogApiClient } from "../client";

export function createCatalogRequestApiClient(request: Request) {
  return createCatalogApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/catalog"),
    fetch: createForwardedAuthFetch(request),
  });
}
