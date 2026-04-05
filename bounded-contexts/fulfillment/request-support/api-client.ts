import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
export {
  createFulfillmentApiClient,
  fulfillmentApi,
  FulfillmentApiError,
} from "../client";
export type {
  FulfillmentApiClientOptions,
  FulfillmentShipmentDetail,
  FulfillmentShipmentListItem,
} from "../client";
import { createFulfillmentApiClient } from "../client";

export function createFulfillmentRequestApiClient(request: Request) {
  return createFulfillmentApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
