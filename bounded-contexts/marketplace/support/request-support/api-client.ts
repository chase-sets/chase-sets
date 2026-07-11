import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
export { createMarketplaceApiClient, marketplaceApi, MarketplaceApiError } from "../../client";
export type {
  OfferMatchDetail,
  OfferMatchListItem,
  OfferBuyerMute,
  MarketplaceApiClientOptions,
  MarketplaceOffer,
  PublicOfferDetail,
  MarketplaceItemListing,
  MarketplaceListingDetail,
  MarketplaceListingFeeLockReportEntry,
  MarketplaceListingFeeHistoryEntry,
  MarketplaceListingInventoryItemOption,
  MarketplaceAnonymousListingDraftIntent,
  MarketplaceListingListItem,
  MarketplaceSellerListingAvailability,
  MarketplaceSellerListingStatusCounts,
  MarketplaceListingTermsPreview,
  MarketplacePublicStandardTermsPreview,
  MarketplaceMarketSummary,
  MarketplaceReportSubmissionSnapshot,
  ReportListingRequest,
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
