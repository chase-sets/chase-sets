import { createMarketplaceRequestApiClient } from "@chase-sets/marketplace/server";

export function createDiscoveryMarketplaceOfferGateway(request: Request) {
  const api = createMarketplaceRequestApiClient(request);

  return {
    createBuyerOffer(input: Record<string, unknown>) {
      return api.createBuyerOffer(input);
    },
  };
}
