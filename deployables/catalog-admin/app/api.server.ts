import { createCatalogApiClient } from "@chase-sets/catalog-authoring/web";

export function getCatalogApiBaseUrl(request: Request) {
  const url = new URL(request.url);
  return `${url.origin}/api/catalog`;
}

export function createCatalogServerApiClient(request: Request) {
  return createCatalogApiClient({
    baseUrl: getCatalogApiBaseUrl(request),
    fetch: globalThis.fetch,
  });
}
