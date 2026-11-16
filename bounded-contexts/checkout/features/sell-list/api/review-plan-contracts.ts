import type { SellListReadinessSnapshot, SellListReadinessDecisionInput } from "../domain/readiness";

export type SellListReviewPlan = Readonly<{
  version: 1;
  lines: readonly SellListReviewPlanLine[];
}>;

export type SellListReviewPlanLine = Readonly<{
  lineId: string;
  lineType: "selected-offer" | "product";
  itemTitle: string;
  productId: string | null;
  quantity: number;
  selectedOffer: Readonly<{ offerId: string; listingId: string; feeQuoteFingerprint: string }> | null;
  productOfferTargets: readonly Readonly<{
    offerId: string;
    listingId: string;
    feeQuoteFingerprint: string;
    quantity: number;
  }>[];
  fallbackListing: Readonly<{
    inventoryItemId: string;
    priceAmount: string;
    priceCurrencyCode: string;
    quantityCap: number;
  }> | null;
  skippedReasons: readonly string[];
}>;

export type SellListReviewSelections = Readonly<{
  bulkOfferIds?: readonly string[];
  lines: readonly Readonly<{
    lineId: string;
    selectedOfferFeeQuoteFingerprint?: string;
    productOffers?: readonly Readonly<{ offerId: string; feeQuoteFingerprint: string }>[];
    fallbackListing?: Readonly<{
      inventoryItemId: string;
      priceAmount: string;
      priceCurrencyCode: string;
      quantityCap?: string;
    }> | null;
  }>[];
}>;

export type SellListReviewReadiness = Readonly<{
  readiness: SellListReadinessSnapshot;
  reviewPlan: SellListReviewPlan;
  decisions: SellListReadinessDecisionInput;
}>;
