import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
export {
  discoveryApi,
  DiscoveryApiError,
  createDiscoveryApiClient,
} from "../client";
export type {
  CategoryListResponse,
  DiscoveryApiClientOptions,
  DiscoveryCategoryItem,
  DiscoveryItemDetail,
  DiscoverySearchResponse,
} from "../client";
import { createDiscoveryApiClient } from "../client";

export function createDiscoveryRequestApiClient(request: Request) {
  return createDiscoveryApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
