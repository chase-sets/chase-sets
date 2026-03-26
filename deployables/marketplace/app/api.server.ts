import { createDiscoveryApiClient } from "../../../bounded-contexts/discovery/items/client-support/api-client";

export function getMarketplaceApiBaseUrl(request: Request) {
  const url = new URL(request.url);
  return `${url.origin}/api/marketplace`;
}

export function createMarketplaceServerApiClient(request: Request) {
  return createDiscoveryApiClient({
    baseUrl: getMarketplaceApiBaseUrl(request),
    fetch: globalThis.fetch,
  });
}
