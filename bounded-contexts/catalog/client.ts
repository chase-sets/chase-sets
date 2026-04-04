export {
  ApiError as CatalogApiError,
  api as catalogApi,
  createCatalogApiClient,
} from "./authoring/shell-support/api/client";
export type { CatalogApiClientOptions } from "./authoring/shell-support/api/client";

import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
import { createCatalogApiClient } from "./authoring/shell-support/api/client";

export function createCatalogRequestApiClient(request: Request) {
  return createCatalogApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/catalog"),
    fetch: createForwardedAuthFetch(request),
  });
}
