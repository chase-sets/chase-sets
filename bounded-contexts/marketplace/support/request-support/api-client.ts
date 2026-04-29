import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/platform-runtime/http";
export {
  createMarketplaceApiClient,
  marketplaceApi,
  MarketplaceApiError,
} from "../../client";
export type {
  BuyerOfferMatchDetail,
  BuyerOfferMatchListItem,
  MarketplaceApiClientOptions,
  MarketplaceBuyerOffer,
  MarketplaceItemListing,
  MarketplaceListingDetail,
  MarketplaceListingInventoryItemOption,
  MarketplaceListingListItem,
  MarketplaceListingTermsPreview,
  MarketplaceMarketSummary,
  SubmittedBuyerOfferDetail,
  SubmittedBuyerOfferListItem,
} from "../../client";
import { createMarketplaceApiClient } from "../../client";

export function createMarketplaceRequestApiClient(request: Request) {
  return createMarketplaceApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
