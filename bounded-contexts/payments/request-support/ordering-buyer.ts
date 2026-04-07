import {
  createOrderingRequestApiClient,
  type OrderingOrderDetail,
} from "@chase-sets/ordering/server";

export type { OrderingOrderDetail };

export function createPaymentsOrderingBuyerGateway(request: Request) {
  const api = createOrderingRequestApiClient(request);

  return {
    getBuyerOrder(orderId: string) {
      return api.getBuyerOrder(orderId);
    },
  };
}
