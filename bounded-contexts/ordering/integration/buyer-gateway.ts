import { createOrderingRequestApiClient } from "../request-support/api-client";
export type { OrderingOrderDetail } from "../orders/client/contracts";

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
