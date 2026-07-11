import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
export { createOrderingApiClient, orderingApi, OrderingApiError } from "../../client";
export type {
  CheckoutFulfillmentPreview,
  OrderingApiClientOptions,
  OrderListSummary,
  PostagePolicyAdminRecord,
  PostagePolicyCommandRequest,
  PostagePolicyPreviewRequest,
  PurchaseDetail,
  PurchaseListItem,
  SaleDetail,
  SaleListItem,
} from "../../client";
import { createOrderingApiClient } from "../../client";

export function createOrderingRequestApiClient(request: Request) {
  return createOrderingApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "ordering" }),
  });
}
