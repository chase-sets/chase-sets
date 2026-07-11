import { createMarketplaceRequestApiClient } from "@chase-sets/marketplace/server";
import type { PricingMarketplaceListingGateway } from "../../features/recommendations/api/runtime";

function createdListingResponse(value: unknown) {
  if (!value || typeof value !== "object") {
    return {};
  }

  const record = value as { id?: unknown; listing_id?: unknown };
  return {
    id: typeof record.id === "string" ? record.id : undefined,
    listing_id: typeof record.listing_id === "string" ? record.listing_id : undefined,
  };
}

export function createPricingMarketplaceListingGateway(request: Request): PricingMarketplaceListingGateway {
  const marketplaceApi = createMarketplaceRequestApiClient(request);

  return {
    // m113 repricing-at-scale throughput lane: one bulk call per
    // `applyRecommendations` run instead of a previewListingTerms +
    // updateListingPrice round trip per listing -- Marketplace resolves the
    // account's terms session server-side and applies every listing's price
    // at the freshly-resolved terms.
    applyBulkListingPriceUpdates: (body, options) => marketplaceApi.applyBulkListingPriceUpdates(body, options),
    createListing: async (body, options) => createdListingResponse(await marketplaceApi.createListing(body, options)),
  };
}
