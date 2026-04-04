import type { OrderingServices } from "./services";
import { createOrderingRequestApiClient } from "./server";
export type { OrderingOrderDetail } from "./client";

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

export function createOrderingBuyerGateway(request: Request) {
  const api = createOrderingRequestApiClient(request);

  return {
    addCartLine(input: Record<string, unknown>) {
      return api.addCartLine(input);
    },
    getBuyerOrder(orderId: string) {
      return api.getBuyerOrder(orderId);
    },
  };
}
