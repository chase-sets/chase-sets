import { createIdentityApiClient } from "@chase-sets/identity/web";

export function getIdentityApiBaseUrl(request: Request) {
  const url = new URL(request.url);
  return `${url.origin}/api/identity`;
}

export function createIdentityServerApiClient(request: Request) {
  return createIdentityApiClient({
    baseUrl: getIdentityApiBaseUrl(request),
    fetch: globalThis.fetch,
  });
}
