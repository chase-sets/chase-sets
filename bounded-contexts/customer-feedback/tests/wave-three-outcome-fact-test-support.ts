import { decideMarketplaceListing, initialMarketplaceListingState } from "../../marketplace/features/listings/domain/domain";
import { decideMarketplaceOffer, initialMarketplaceOfferState } from "../../marketplace/features/offers/domain/domain";
import { decideReview, initialReviewState } from "../../marketplace/features/reviews/domain/domain";
import { decideInventoryItem, evolveInventoryItem, initialInventoryItemState } from "../../inventory/features/inventory-items/domain/domain";

export const waveThreeOccurredAt = "2026-05-09T14:00:00.000Z";

export function listingFact() {
  const evidenceRequirements = {
    policyId: null, policyVersion: null, policyHash: "sha256:policy", evaluatedAt: waveThreeOccurredAt,
    requirementHash: "sha256:requirements", matchedRuleIds: [], explanationCodes: [],
    requirements: { minimumPhotoCount: 0, requiredSlots: [], sellerTrustRequirements: [], buyerAcknowledgment: "none" },
  } as const;
  return decideMarketplaceListing({
    ...initialMarketplaceListingState, listingId: "lst_native" as never, accountId: "acc_seller" as never,
    priceAmount: "10.00", priceCurrencyCode: "USD", productMeasureSnapshot: {} as never, evidenceRequirements,
  }, {
    type: "PublishListing", publishedAt: waveThreeOccurredAt,
    readiness: { ready: true, requirementHash: evidenceRequirements.requirementHash, unmetCodes: [],
      coverage: { complete: true, unmetCodes: [], slots: [], activePhotoCount: 0, minimumPhotoCount: 0 } },
  }).find((event) => event.type === "marketplace.listing.published")!;
}

export function offerFact() {
  return decideMarketplaceOffer({
    ...initialMarketplaceOfferState, offerId: "off_native" as never, buyerAccountId: "acc_buyer" as never,
    catalogItemId: "cat_native", productId: "cat_native::" as never, itemTitle: "Card", status: "submitted",
    priceAmount: "10.00", priceCurrencyCode: "USD", quantityRequested: 1,
    shippingDestinationSnapshot: { name: "Buyer", company: null, line1: "1 Main", line2: null, city: "Austin",
      state: "TX", postalCode: "78701", country: "US", phone: null, email: null },
  }, {
    type: "AcceptOffer", sellerAccountId: "acc_seller" as never, listingId: "lst_native", inventoryItemId: "inv_native",
    listingVersion: 1, acceptedAt: waveThreeOccurredAt, marketplaceSalesFeePercentageBps: 500,
    marketplaceSalesFeeFixedAmount: "0.00", marketplaceSalesFeeCapAmount: null, marketplaceSalesFeeUnitAmount: "0.50",
    sellerNetUnitAmount: "9.50", shippingAllowancePercentageBps: 500, termsScheduleId: null, termsAgreementId: null,
    termsResolvedAt: waveThreeOccurredAt, feeQuoteFingerprint: "fee_native", listingEvidencePolicyId: null,
    listingEvidencePolicyVersion: null, listingEvidencePolicyHash: "sha256:policy",
    listingEvidenceSnapshot: { schemaVersion: 1, policyHash: "sha256:policy", snapshotHash: "sha256:evidence",
      createdAt: waveThreeOccurredAt, evidence: [] },
  }).find((event) => event.type === "marketplace.offer.accepted")!;
}

export function reviewFact(authorRole: "buyer" | "seller" = "buyer") {
  return decideReview(initialReviewState, {
    type: "SubmitReview", reviewId: `rev_${authorRole}` as never, orderId: "ord_native" as never,
    authorAccountId: `acc_${authorRole}` as never, subjectAccountId: `acc_${authorRole === "buyer" ? "seller" : "buyer"}` as never,
    authorRole, rating: 5, feedback: "Careful packaging.", submittedAt: waveThreeOccurredAt,
    reviewWindowExpiresAt: "2026-06-01T00:00:00.000Z",
  }).find((event) => event.type === "marketplace.review.submitted")!;
}

export function inventoryCreatedFact() {
  return decideInventoryItem(initialInventoryItemState, {
    type: "CreateInventoryItem", itemId: "inv_native" as never, accountId: "acc_payload_seller" as never,
    catalogItemId: "cat_native" as never, productId: "cat_native::" as never, storageLocationId: "loc_native",
    totalQuantity: 10, acquisitionOccurrence: { kind: "unknown" }, commandOccurredAt: waveThreeOccurredAt,
  }).find((event) => event.type === "inventory.item.created")!;
}

export function inventoryAdjustedFact() {
  return decideInventoryItem(evolveInventoryItem(initialInventoryItemState, inventoryCreatedFact()), {
    type: "AdjustInventoryItemQuantity", quantityDelta: 1, heldQuantity: 0, reason: "Intake", reasonCode: "intake",
    acquisitionOccurrence: { kind: "unknown" }, commandOccurredAt: waveThreeOccurredAt, requestIdempotencyKey: "request-native",
  }).find((event) => event.type === "inventory.item.adjusted")!;
}

export function offlineSaleFacts() {
  return decideInventoryItem(evolveInventoryItem(initialInventoryItemState, inventoryCreatedFact()), {
    type: "RecordOfflineSale", quantity: 1, heldQuantity: 0, channel: "card-show", recordedAt: waveThreeOccurredAt,
    salePriceAmount: "10.00", requestIdempotencyKey: "offline-request-native",
  });
}
