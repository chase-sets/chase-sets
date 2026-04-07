import { createOrderingRequestApiClient } from "@chase-sets/ordering/server";

export function createDiscoveryOrderingBuyerGateway(request: Request) {
  const api = createOrderingRequestApiClient(request);

  return {
    addCartLine(input: Record<string, unknown>) {
      return api.addCartLine(input);
    },
  };
}
