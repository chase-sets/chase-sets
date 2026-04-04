import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
import { createMarketplaceApiClient } from "./client";

export { createMarketplaceSupplyResolver } from "./supply-resolver";

export function createMarketplaceRequestIntegrationClient(request: Request) {
  return createMarketplaceApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
