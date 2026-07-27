// Marketplace-owned public event payloads.
//
// `MarketplaceEventPayloads` also registers the two Platform Operations action-recorded
// facts under their `platform-operations.*` stream keys. That cross-registration is the
// published contract: the types are Platform-Operations-owned, their membership here is not.
import type { AddressSnapshot } from "../../primitives/address-snapshot";
import type { JsonValue } from "../../primitives/json";
import type { AccountId } from "../../primitives/typed-ids";
import type { MarketplaceReviewScoringDispositionProjectedV1Payload } from "../review-scoring-facts";
import type { EmptyEventPayload } from "./event-core";
import type {
  PlatformOperationsReportedContentActionRecordedPayload,
  PlatformOperationsRiskAlertActionRecordedPayload,
} from "./platform-operations";

export type MarketplaceSalesFeeLineSnapshotPayload = Readonly<{
  lineId: string;
  unitPriceAmount: string;
  quantity: number;
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  marketplaceSalesFeeCapAmount: string | null;
  marketplaceSalesFeeUnitAmount: string;
  marketplaceSalesFeeTotalAmount: string;
}>;

export type MarketplaceOfferAcceptedPayload = Readonly<{
  offerId: string;
  buyerAccountId: AccountId;
  sellerAccountId: AccountId;
  listingId: string;
  inventoryItemId: string;
  listingVersion: number;
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  productSummary: string | null;
  priceAmount: string;
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  marketplaceSalesFeeCapAmount: string | null;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  shippingAllowancePercentageBps: number;
  shippingDestinationSnapshot: AddressSnapshot;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string;
  feeQuoteFingerprint: string;
  listingEvidencePolicyId: string | null;
  listingEvidencePolicyVersion: number | null;
  listingEvidencePolicyHash: string;
  listingEvidenceSnapshot: Readonly<{
    schemaVersion: 1;
    policyHash: string | null;
    snapshotHash: string;
    createdAt: string;
    evidence: readonly Readonly<{
      photoId: string;
      slotId: string | null;
      viewKind: string | null;
      sortOrder: number;
      sourceHash: string;
      assetRevision: string;
      capturedAt: string | null;
      uploadedAt: string;
      assets: readonly Readonly<{
        role: string;
        storageKey: string;
        publicUrl: string;
        width: number;
        height: number;
        density: 1 | 2 | null;
        mediaType: "image/webp";
        byteSize: number;
      }>[];
    }>[];
  }>;
  quantityRequested: number;
  acceptanceBatchId: string | null;
  acceptanceBatchSize: number | null;
  acceptedAt: string;
}>;

export type MarketplaceOfferSubmittedPayload = Readonly<{
  offerId: string;
  buyerAccountId: AccountId;
  catalogItemId: string;
  productId: string;
  itemTitle: string;
  itemSubtitle: string | null;
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  productSummary: string | null;
  shippingDestinationSnapshot: AddressSnapshot;
  priceAmount: string;
  quantityRequested: number;
}>;

export type MarketplaceListingOfferCommitmentRecordedPayload = Readonly<{
  offerId: string;
  quantity: number;
  evidenceSnapshotHash: string;
  committedAt: string;
}>;

export type MarketplaceSellerListingAvailabilityCommitmentCheckedPayload = Readonly<{
  offerId: string;
  listingId: string;
  checkedAt: string;
}>;

export type MarketplacePurchaseLimitsPayload = Readonly<{
  maxUnitsPerOrder: number | null;
  maxUnitsPerDay: number | null;
  maxUnitsPerCustomerAccount: number | null;
}>;

export type MarketplaceListingFeeTermsSnapshotPayload = Readonly<{
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  marketplaceSalesFeeCapAmount: string | null;
  shippingAllowancePercentageBps: number;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string;
}>;

export type MarketplaceListingFeeLockPayload = Readonly<{
  unitCount: number;
  terms: MarketplaceListingFeeTermsSnapshotPayload;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  feeQuoteFingerprint: string;
}>;

export type MarketplaceListingCreatedPayload = Readonly<{
  listingId: string;
  accountId: AccountId;
  inventoryItemId: string;
  catalogItemId: string;
  productId: string;
  itemTitle: string | null;
  itemSubtitle: string | null;
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  productSummary: string | null;
  productMeasureSnapshot?: JsonValue;
  gradedCard?: JsonValue;
  storageLocationName: string | null;
  shipFromCode: string | null;
  shipFromAddress: JsonValue;
  priceAmount: string;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  shippingAllowancePercentageBps?: number;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string;
  feeLocks: readonly MarketplaceListingFeeLockPayload[];
  quantityCap: number;
  purchaseLimits?: MarketplacePurchaseLimitsPayload;
}>;

export type MarketplaceListingPriceUpdatedPayload = Readonly<{
  priceAmount: string;
  marketplaceSalesFeeUnitAmount: string;
  sellerNetUnitAmount: string;
  shippingAllowancePercentageBps?: number;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string;
  feeLocks: readonly MarketplaceListingFeeLockPayload[];
}>;

export type MarketplaceListingQuantityCapUpdatedPayload = MarketplaceListingPriceUpdatedPayload &
  Readonly<{
    quantityCap: number;
    purchaseLimits?: MarketplacePurchaseLimitsPayload;
  }>;

export type MarketplaceListingPurchaseLimitsUpdatedPayload = Readonly<{
  purchaseLimits: MarketplacePurchaseLimitsPayload;
}>;

export type MarketplaceSellerListingAvailabilityPayload = Readonly<{
  accountId: AccountId;
}>;

export type MarketplaceListingAutoUnlistedPayload = Readonly<{
  reportId: string;
  reportCount: number;
  threshold: number;
  autoUnlistedAt: string;
}>;

export type MarketplaceReportSubmittedPayload = Readonly<{
  reportId: string;
  targetType: "listing" | "review";
  targetId: string;
  targetOwnerAccountId: string | null;
  reporterKind: "account" | "visitor";
  reporterKey: string;
  reporterAccountId: string | null;
  reporterUserId: string | null;
  reason: string;
  details: string | null;
  sourceRoutePath: string;
  submittedAt: string;
}>;

export type MarketplaceEventPayloads = Readonly<{
  "marketplace.listing.created": MarketplaceListingCreatedPayload;
  "marketplace.listing.price-updated": MarketplaceListingPriceUpdatedPayload;
  "marketplace.listing.quantity-cap-updated": MarketplaceListingQuantityCapUpdatedPayload;
  "marketplace.listing.purchase-limits-updated": MarketplaceListingPurchaseLimitsUpdatedPayload;
  "marketplace.listing.published": EmptyEventPayload;
  "marketplace.listing.paused": EmptyEventPayload;
  "marketplace.listing.auto-unlisted": MarketplaceListingAutoUnlistedPayload;
  "marketplace.listing.withdrawn": EmptyEventPayload;
  "marketplace.seller-listing-availability.disabled": MarketplaceSellerListingAvailabilityPayload;
  "marketplace.seller-listing-availability.enabled": MarketplaceSellerListingAvailabilityPayload;
  "marketplace.report.submitted": MarketplaceReportSubmittedPayload;
  "platform-operations.reported-content.action-recorded": PlatformOperationsReportedContentActionRecordedPayload;
  "platform-operations.risk-alert.action-recorded": PlatformOperationsRiskAlertActionRecordedPayload;
  "marketplace.offer.accepted": MarketplaceOfferAcceptedPayload;
  "marketplace.offer.submitted": MarketplaceOfferSubmittedPayload;
  "marketplace.listing.offer-commitment-recorded": MarketplaceListingOfferCommitmentRecordedPayload;
  "marketplace.seller-listing-availability.commitment-checked": MarketplaceSellerListingAvailabilityCommitmentCheckedPayload;
  "marketplace.review-scoring.disposition-projected.v1": MarketplaceReviewScoringDispositionProjectedV1Payload;
}>;
