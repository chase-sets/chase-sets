import { createDiscoveryApiClient } from "@chase-sets/discovery/web";
import { createIdentityApiClient } from "@chase-sets/identity/web";
import { createForwardedAuthFetch } from "@chase-sets/identity/server";

export function getMarketplaceApiBaseUrl(request: Request) {
  const url = new URL(request.url);
  return `${url.origin}/api/marketplace`;
}

export function createMarketplaceServerApiClient(request: Request) {
  return createDiscoveryApiClient({
    baseUrl: getMarketplaceApiBaseUrl(request),
    fetch: createForwardedAuthFetch(request),
  });
}

export function getIdentityApiBaseUrl(request: Request) {
  const url = new URL(request.url);
  return `${url.origin}/api/identity`;
}

export function createMarketplaceIdentityApiClient(request: Request) {
  return createIdentityApiClient({
    baseUrl: getIdentityApiBaseUrl(request),
    fetch: createForwardedAuthFetch(request),
  });
}
