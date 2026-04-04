export { createMarketplaceSupplyResolver } from "./supply-resolver";
import { createMarketplaceRequestApiClient } from "./server";

export function createMarketplaceOfferGateway(request: Request) {
  const api = createMarketplaceRequestApiClient(request);

  return {
    createBuyerOffer(input: Record<string, unknown>) {
      return api.createBuyerOffer(input);
    },
  };
}
