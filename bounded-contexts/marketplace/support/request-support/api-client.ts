import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
export { createMarketplaceApiClient, marketplaceApi, MarketplaceApiError } from "../../client";
export type {
  OfferMatchDetail,
  OfferMatchListItem,
  MarketplaceApiClientOptions,
  MarketplaceOffer,
  MarketplaceItemListing,
  MarketplaceListingDetail,
  MarketplaceListingFeeLockReportEntry,
  MarketplaceListingFeeHistoryEntry,
  MarketplaceListingInventoryItemOption,
  MarketplaceAnonymousListingDraftIntent,
  MarketplaceListingListItem,
  MarketplaceSellerListingAvailability,
  MarketplaceListingTermsPreview,
  MarketplacePublicStandardTermsPreview,
  MarketplaceMarketSummary,
  SubmittedOfferDetail,
  SubmittedOfferListItem,
} from "../../client";
import { createMarketplaceApiClient } from "../../client";

export function createMarketplaceRequestApiClient(request: Request) {
  return createMarketplaceApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/marketplace"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "marketplace" }),
  });
}
