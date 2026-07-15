import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
export { createFulfillmentApiClient, fulfillmentApi, FulfillmentApiError } from "../../client";
export type {
  FulfillmentApiClientOptions,
  FulfillmentPackingSlip,
  FulfillmentPackingSlipBatch,
  FulfillmentPackingSlipFormat,
  FulfillmentShipmentDetail,
  FulfillmentShipmentListItem,
  FulfillmentReturnIntakeQueue,
  FulfillmentReturnIntakeResolution,
} from "../../client";
import { createFulfillmentApiClient } from "../../client";

export function createFulfillmentRequestApiClient(request: Request) {
  return createFulfillmentApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "fulfillment" }),
  });
}
