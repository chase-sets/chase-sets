import {
  createMarketplaceRequestApiClient,
  MarketplaceApiError,
  type MarketplaceListingTermsPreview,
} from "@chase-sets/marketplace/server";
import type { PricingMarketplaceListingGateway } from "../../features/recommendations/api/runtime";

function readCurrentQuoteFingerprint(body: unknown) {
  if (!body || typeof body !== "object" || !("error" in body)) {
    return null;
  }
  const error = (body as { error?: unknown }).error;
  if (!error || typeof error !== "object" || !("currentQuote" in error)) {
    return null;
  }
  const currentQuote = (error as { currentQuote?: unknown }).currentQuote;
  if (!currentQuote || typeof currentQuote !== "object" || !("fee_quote_fingerprint" in currentQuote)) {
    return null;
  }
  const fingerprint = (currentQuote as MarketplaceListingTermsPreview).fee_quote_fingerprint;
  return typeof fingerprint === "string" ? fingerprint : null;
}

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
    previewListingTerms: (body, options) => marketplaceApi.previewListingTerms(body, options),
    updateListingPrice: (listingId, body, options) => marketplaceApi.updateListingPrice(listingId, body, options),
    createListing: async (body, options) => createdListingResponse(await marketplaceApi.createListing(body, options)),
    staleFeeQuoteFingerprint: (error) =>
      error instanceof MarketplaceApiError ? readCurrentQuoteFingerprint(error.body) : null,
  };
}
