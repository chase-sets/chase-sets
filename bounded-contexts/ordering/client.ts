export {
  ApiError as OrderingApiError,
  createOrderingApiClient,
  orderingApi,
} from "./web";
export type { OrderingApiClientOptions } from "./web";

import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
import { createOrderingApiClient } from "./web";

export function createOrderingRequestApiClient(request: Request) {
  return createOrderingApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
