// https://github.com/chase-sets/chase-sets/issues/10505
import { CheckoutDomainError } from "../../../support/runtime-support/common";
import type { SellListReviewSelections } from "./review-plan-contracts";

export function parseSellListReviewSelections(value: unknown): SellListReviewSelections {
  const invalid = () => new CheckoutDomainError("Sell List review selections are invalid.");
  const object = (input: unknown): Record<string, unknown> => {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid();
    return input as Record<string, unknown>;
  };
  const text = (input: unknown): string => {
    if (input === undefined) return "";
    if (typeof input !== "string") throw invalid();
    return input.trim();
  };
  const array = (input: unknown): unknown[] => {
    if (input === undefined) return [];
    if (!Array.isArray(input)) throw invalid();
    return input;
  };
  const source = object(value);
  return {
    bulkOfferIds: array(source.bulkOfferIds).map(text).filter(Boolean),
    lines: array(source.lines).map((input) => {
      const line = object(input);
      const fallback = line.fallbackListing == null ? null : object(line.fallbackListing);
      return {
        lineId: text(line.lineId),
        selectedOfferFeeQuoteFingerprint: text(line.selectedOfferFeeQuoteFingerprint),
        productOffers: array(line.productOffers).map((input) => {
          const target = object(input);
          return { offerId: text(target.offerId), feeQuoteFingerprint: text(target.feeQuoteFingerprint) };
        }),
        fallbackListing: fallback ? {
          inventoryItemId: text(fallback.inventoryItemId),
          priceAmount: text(fallback.priceAmount),
          priceCurrencyCode: text(fallback.priceCurrencyCode),
          quantityCap: text(fallback.quantityCap),
        } : null,
      };
    }),
  };
}
