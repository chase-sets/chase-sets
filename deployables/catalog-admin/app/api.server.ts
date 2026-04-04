import { createCatalogApiClient } from "@chase-sets/catalog/web";
import { createIdentityApiClient } from "@chase-sets/identity/web";
import { createForwardedAuthFetch } from "@chase-sets/identity/server";

export function getCatalogApiBaseUrl(request: Request) {
  const url = new URL(request.url);
  return `${url.origin}/api/catalog`;
}

export function createCatalogServerApiClient(request: Request) {
  return createCatalogApiClient({
    baseUrl: getCatalogApiBaseUrl(request),
    fetch: createForwardedAuthFetch(request),
  });
}

export function getIdentityApiBaseUrl(request: Request) {
  const url = new URL(request.url);
  return `${url.origin}/api/identity`;
}

export function createIdentityServerApiClient(request: Request) {
  return createIdentityApiClient({
    baseUrl: getIdentityApiBaseUrl(request),
    fetch: createForwardedAuthFetch(request),
  });
}

