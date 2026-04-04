import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
import { createOrderingApiClient } from "./client";
import type { OrderingServices } from "./services";

export type {
  OrderingOrderDetail,
  OrderingOrderListItem,
} from "./orders/ui/contracts";

export function createOrderSnapshotReader(services: OrderingServices) {
  return async (orderId: string, buyerAccountId: string) => {
    const order = await services.orders.getBuyerOrder(orderId as never, buyerAccountId as never);

    return order
      ? {
          orderId: order.order_id as never,
          buyerAccountId: order.buyer_account_id as never,
          totalAmount: order.total_amount,
          status: order.status,
        }
      : null;
  };
}

export function createOrderingRequestIntegrationClient(request: Request) {
  return createOrderingApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
