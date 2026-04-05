import { createMarketplaceRequestApiClient } from "../request-support/api-client";

export function createMarketplaceOfferGateway(request: Request) {
  const api = createMarketplaceRequestApiClient(request);

  return {
    createBuyerOffer(input: Record<string, unknown>) {
      return api.createBuyerOffer(input);
    },
  };
}
