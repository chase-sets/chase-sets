export {
  IdentityApiError,
  createIdentityApiClient,
  identityApi,
} from "./web";
export type { IdentityApiClientOptions } from "./web";

import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
import { createIdentityApiClient } from "./web";

export function createIdentityRequestApiClient(request: Request) {
  return createIdentityApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/identity"),
    fetch: createForwardedAuthFetch(request),
  });
}
