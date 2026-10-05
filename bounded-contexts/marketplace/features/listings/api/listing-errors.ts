import { t } from "@chase-sets/localization";
import { TypedIdBoundaryDomainError } from "@chase-sets/http/typed-id";
import { MarketplaceListingDomainError } from "../domain/listing-error";
import { MarketplaceListingBulkPriceUpdatePolicyError } from "../domain/bulk-price-update-policy";
import { MarketplaceEvidenceGovernanceError } from "../domain/evidence-governance";
import { MarketplaceListingGatePolicyError } from "../domain/listing-gate-policy";
import { listingErrorContract, type ListingErrorCode } from "../ui/listing-error-contract";
import { MarketplaceListingRequestError } from "./listing-request-error";
import { MarketplaceListingEvidenceIncompleteError, MarketplaceSalesFeeQuoteStaleError } from "./runtime";

function classifyListingError(error: unknown): ListingErrorCode | null {
  if (error instanceof MarketplaceListingRequestError) {
    switch (error.code) {
      case "unknown-field":
      case "price-currency-invalid":
      case "availability-reason-invalid":
      case "away-window-reason-required":
      case "away-window-instant-required":
      case "order-capacity-invalid":
      case "photo-multipart-required":
      case "photo-replacement-required":
      case "id-invalid":
      case "inventory-snapshot-invalid":
        return error.code;
      default:
        return null;
    }
  }
  if (error instanceof MarketplaceListingDomainError) {
    switch (error.code) {
      case "listing-not-found":
      case "inventory-item-not-found":
      case "command-rejected":
        return error.code;
      default:
        return null;
    }
  }
  if (error instanceof TypedIdBoundaryDomainError) return "id-invalid";
  if (error instanceof MarketplaceListingBulkPriceUpdatePolicyError) return "bulk-price-update-invalid";
  if (error instanceof MarketplaceEvidenceGovernanceError) {
    switch (error.code) {
      case "too-many-evidence":
      case "total-bytes-exceeded":
      case "pixel-budget-exceeded":
      case "invalid-dimensions":
        return "evidence-invalid";
      default:
        return null;
    }
  }
  if (error instanceof MarketplaceListingGatePolicyError) return "listing-gate-policy-invalid";
  if (error instanceof MarketplaceListingEvidenceIncompleteError) return "evidence-incomplete";
  if (error instanceof MarketplaceSalesFeeQuoteStaleError) return "fee-quote-stale";
  return null;
}

export function listingErrorResponse(error: unknown, allowed: readonly ListingErrorCode[]): Response {
  const code = classifyListingError(error);
  if (code === null || !allowed.includes(code)) {
    // Do not retain the original exception in the central handler's logs.
    throw new Error("Unknown Marketplace Listing failure.");
  }
  const entry = listingErrorContract[code];
  const details =
    error instanceof MarketplaceListingEvidenceIncompleteError
      ? { currentEvidenceReadiness: error.currentReadiness }
      : error instanceof MarketplaceSalesFeeQuoteStaleError
        ? { currentQuote: error.currentQuote }
        : {};
  return new Response(JSON.stringify({ error: { code: entry.code, message: t(entry.copy), ...details } }), {
    status: entry.status,
    headers: { "Content-Type": "application/json" },
  });
}
