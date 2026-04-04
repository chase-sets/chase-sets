export {
  ApiError as InventoryApiError,
  createInventoryApiClient,
  inventoryApi,
} from "./web";
export type { InventoryApiClientOptions } from "./web";

import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
import { createInventoryApiClient } from "./web";

export function createInventoryRequestApiClient(request: Request) {
  return createInventoryApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/inventory"),
    fetch: createForwardedAuthFetch(request),
  });
}
