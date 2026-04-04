export {
  DiscoveryApiError,
  createDiscoveryApiClient,
  discoveryApi,
} from "./web";
export type { DiscoveryApiClientOptions } from "./web";

import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
import { createDiscoveryApiClient } from "./web";

export function createDiscoveryRequestApiClient(request: Request) {
  return createDiscoveryApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
