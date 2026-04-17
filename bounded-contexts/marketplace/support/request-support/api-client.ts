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
  MarketplaceApiClientOptions,
  MarketplaceBuyerOfferDetail,
  MarketplaceItemListing,
  MarketplaceListingDetail,
  MarketplaceListingInventoryRecordOption,
  MarketplaceListingListItem,
  MarketplaceListingTermsPreview,
  MarketplaceMarketSummary,
  MarketplaceOfferListItem,
  MarketplaceSellerOfferDetail,
  MarketplaceSellerOfferListItem,
} from "../../client";
import { createMarketplaceApiClient } from "../../client";

export function createMarketplaceRequestApiClient(request: Request) {
  return createMarketplaceApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request),
  });
}
