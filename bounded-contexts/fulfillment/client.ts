export {
  ApiError as FulfillmentApiError,
  createFulfillmentApiClient,
  fulfillmentApi,
} from "./web";
export type { FulfillmentApiClientOptions } from "./web";

import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
import { createFulfillmentApiClient } from "./web";

export function createFulfillmentRequestApiClient(request: Request) {
  return createFulfillmentApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
