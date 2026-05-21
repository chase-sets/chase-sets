import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
export { discoveryApi, DiscoveryApiError, createDiscoveryApiClient } from "../../client";
export type {
  CategoryListResponse,
  DiscoveryApiClientOptions,
  DiscoveryCategoryItem,
  DiscoveryItemDetail,
  DiscoveryPublicListing,
  DiscoveryPublicAccount,
  DiscoverySitemapUrl,
  DiscoverySearchResponse,
  DiscoveryBulkCartPreview,
  ProductAlertListResponse,
  ProductAlertPageRow,
} from "../../client";
import { createDiscoveryApiClient } from "../../client";

export function createDiscoveryRequestApiClient(request: Request) {
  return createDiscoveryApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
