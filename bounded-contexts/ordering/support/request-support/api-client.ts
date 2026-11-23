export { createOrderingApiClient, orderingApi, OrderingApiError } from "../../client";
export type {
  CheckoutFulfillmentPreview,
  OrderingApiClientOptions,
  OrderListSummary,
  PurchaseDetail,
  PurchaseListItem,
  SaleDetail,
  SaleListItem,
} from "../../client";
import { createOrderingApiClient } from "../../client";
import { orderingRequestOptions } from "./request-options";

export function createOrderingRequestApiClient(request: Request) {
  return createOrderingApiClient(orderingRequestOptions(request));
}
