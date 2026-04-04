import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
import { createCatalogApiClient } from "./client";

export function createCatalogRequestApiClient(request: Request) {
  return createCatalogApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/catalog"),
    fetch: createForwardedAuthFetch(request),
  });
}
