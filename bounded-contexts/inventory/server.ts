import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
import { createInventoryApiClient } from "./client";

export function createInventoryRequestApiClient(request: Request) {
  return createInventoryApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/inventory"),
    fetch: createForwardedAuthFetch(request),
  });
}
