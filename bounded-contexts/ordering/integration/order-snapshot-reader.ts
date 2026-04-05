import type { OrderingServices } from "../services";

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
