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
  /** Absent only when decoding historical amount-only Offer events. */
  priceCurrencyCode?: string | null;
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
  /** Absent only when decoding historical amount-only Offer events. */
  priceCurrencyCode?: string | null;
  quantityRequested: number;
}>;

export type MarketplaceOfferPriceUpdatedPayload = Readonly<{
  offerId: string;
  buyerAccountId: AccountId;
  priceAmount: string;
  priceCurrencyCode: string;
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

export type MarketplaceListingPriceTarget =
  | Readonly<{ kind: "native-marketplace" }>
  | Readonly<{ kind: "channel-connection"; connectionId: string }>;

export type MarketplaceListingPriceDecision =
  | Readonly<{ kind: "seller-reference" }>
  | Readonly<{ kind: "legacy-native-anchor" }>
  | Readonly<{
      kind: "pricing-evaluation";
      evaluationId: string;
      evaluationRevision: string;
      policyId: string;
      policyRevision: string;
      goal: Readonly<{ goalId: string; version: string }> | null;
      inputEvidenceRefs: readonly string[];
      curveEvidenceRefs: readonly string[];
      economicsSourceRevision: string | null;
      economicsOverrideRevision: string | null;
      basePriceRevision: number;
      standingAuthorizationId: string;
      standingAuthorizationRevision: string;
    }>;

export type AcceptedListingTargetPriceV1 = Readonly<{
  schemaVersion: 1;
  accountId: string;
  listingId: string;
  target: MarketplaceListingPriceTarget;
  priceAmount: string;
  priceCurrencyCode: string;
  targetPriceRevision: number;
  listingRevision: number;
  acceptedByUserId: string;
  acceptedAt: string;
  sourceEventId: string;
  decision: MarketplaceListingPriceDecision;
  connectionAuthority: Readonly<{
    connectionId: string;
    providerKey: string;
    environment: "sandbox" | "production";
    identityRevision: number;
  }> | null;
}>;

export type NativeListingEligibilityV1 = Readonly<{
  schemaVersion: 1;
  accountId: string;
  listingId: string;
  priceAmount: string | null;
  priceCurrencyCode: string | null;
  targetPriceRevision: number;
  listingRevision: number;
  visibilityRevision: number;
  nativePublicationRevision: number | null;
  eligible: boolean;
  blockingReason:
    | "native-disabled"
    | "native-unpublished"
    | "listing-not-active"
    | "price-incomplete"
    | "native-not-ready"
    | "source-stale"
    | null;
  sourceEventId: string;
  sourceGlobalPosition: string;
  projectionGeneration: string | null;
  generatedAt: string;
}>;

type MarketplaceListingCreatedFields = Readonly<{
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
  /** Absent only when decoding historical amount-only listing events. */
  priceCurrencyCode?: string | null;
  marketplaceSalesFeeUnitAmount: string | null;
  sellerNetUnitAmount: string | null;
  shippingAllowancePercentageBps?: number;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string | null;
  feeLocks: readonly MarketplaceListingFeeLockPayload[];
  quantityCap: number;
  purchaseLimits?: MarketplacePurchaseLimitsPayload;
}>;

export type MarketplaceListingCreatedPayload = MarketplaceListingCreatedFields &
  (
    | Readonly<{
        schemaVersion?: never;
        publicationScope?: never;
        nativeVisibility?: never;
        nativeFeeState?: never;
        marketplaceSalesFeeUnitAmount: string;
        sellerNetUnitAmount: string;
        termsResolvedAt: string;
      }>
    | Readonly<{
        schemaVersion: 2;
        publicationScope: "native";
        nativeVisibility: "enabled";
        nativeFeeState: "enrolled";
        priceCurrencyCode: string;
        marketplaceSalesFeeUnitAmount: string;
        sellerNetUnitAmount: string;
        termsResolvedAt: string;
      }>
    | Readonly<{
        schemaVersion: 2;
        publicationScope: "channel-only";
        nativeVisibility: "disabled";
        nativeFeeState: "not-enrolled";
        priceCurrencyCode: string;
        marketplaceSalesFeeUnitAmount: null;
        sellerNetUnitAmount: null;
        termsScheduleId: null;
        termsAgreementId: null;
        termsResolvedAt: null;
        feeLocks: readonly [];
      }>
  );

type MarketplaceListingPriceUpdatedFields = Readonly<{
  priceAmount: string;
  /** Absent only when decoding historical amount-only listing events. */
  priceCurrencyCode?: string | null;
  marketplaceSalesFeeUnitAmount: string | null;
  sellerNetUnitAmount: string | null;
  shippingAllowancePercentageBps?: number;
  termsScheduleId: string | null;
  termsAgreementId: string | null;
  termsResolvedAt: string | null;
  feeLocks: readonly MarketplaceListingFeeLockPayload[];
}>;

export type MarketplaceListingPriceUpdatedPayload = MarketplaceListingPriceUpdatedFields &
  (
    | Readonly<{
        schemaVersion?: never;
        acceptedTargetPrice?: never;
        marketplaceSalesFeeUnitAmount: string;
        sellerNetUnitAmount: string;
        termsResolvedAt: string;
      }>
    | Readonly<{ schemaVersion: 2; priceCurrencyCode: string; acceptedTargetPrice: AcceptedListingTargetPriceV1 }>
  );

export type MarketplaceListingQuantityCapUpdatedPayload = Omit<
  MarketplaceListingPriceUpdatedFields,
  "priceAmount" | "priceCurrencyCode"
> &
  Readonly<{
    quantityCap: number;
    purchaseLimits?: MarketplacePurchaseLimitsPayload;
  }> &
  (
    | Readonly<{
        schemaVersion?: never;
        marketplaceSalesFeeUnitAmount: string;
        sellerNetUnitAmount: string;
        termsResolvedAt: string;
      }>
    | Readonly<{ schemaVersion: 2 }>
  );

export type MarketplaceListingPurchaseLimitsUpdatedPayload = Readonly<{
  purchaseLimits: MarketplacePurchaseLimitsPayload;
}>;

export type MarketplaceListingTargetPriceAcceptedPayload = Readonly<{
  schemaVersion: 1;
  acceptedTargetPrice: AcceptedListingTargetPriceV1;
}>;

export type MarketplaceListingChannelActivatedPayload = Readonly<{
  connectionId: string;
  targetPriceRevision: number;
  allocationRevision: number;
}>;

export type MarketplaceListingNativeVisibilityChangedPayload = Readonly<{
  nativeVisibility: "enabled" | "disabled";
  nativeFeeState: "enrolled" | "not-enrolled";
  feeLocks: readonly MarketplaceListingFeeLockPayload[];
  evidenceRequirements: JsonValue;
  productMeasureSnapshot?: JsonValue;
  productMeasureRevision?: number;
}>;

export type MarketplaceListingResumedPayload = Readonly<{
  pauseReason: "seller" | "policy-input-missing" | "channel-inbound-dark";
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
  "marketplace.listing.target-price-accepted": MarketplaceListingTargetPriceAcceptedPayload;
  "marketplace.listing.channel-activated": MarketplaceListingChannelActivatedPayload;
  "marketplace.listing.native-visibility-changed": MarketplaceListingNativeVisibilityChangedPayload;
  "marketplace.listing.resumed": MarketplaceListingResumedPayload;
  "marketplace.listing.inbound-clamp-engaged": Readonly<{ connectionId: string; runId: string; generation: number }>;
  "marketplace.listing.inbound-clamp-released": Readonly<{ connectionId: string; runId: string; generation: number }>;
  "marketplace.listing.inbound-clamp-ownership-adopted": Readonly<{
    owners: readonly Readonly<{ connectionId: string; runId: string; generation: number }>[];
  }>;
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
  "marketplace.offer.price-updated": MarketplaceOfferPriceUpdatedPayload;
  "marketplace.listing.offer-commitment-recorded": MarketplaceListingOfferCommitmentRecordedPayload;
  "marketplace.seller-listing-availability.commitment-checked": MarketplaceSellerListingAvailabilityCommitmentCheckedPayload;
  "marketplace.review-scoring.disposition-projected.v1": MarketplaceReviewScoringDispositionProjectedV1Payload;
}>;
