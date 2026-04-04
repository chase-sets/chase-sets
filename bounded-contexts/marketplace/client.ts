export {
  ApiError as MarketplaceApiError,
  createMarketplaceApiClient,
  marketplaceApi,
} from "./web";
export type { MarketplaceApiClientOptions } from "./web";

import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
import { createMarketplaceApiClient } from "./web";

export function createMarketplaceRequestApiClient(request: Request) {
  return createMarketplaceApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
