import type { AddressSnapshot } from "../primitives/address-snapshot";
import type { JsonObject, JsonValue } from "../primitives/json";
import type { AccountId, CheckoutSessionId, PaymentId, SessionId, UserId } from "../primitives/typed-ids";
import type {
  ProtectionCoverageRejectedV1Payload,
  ProtectionCoverageReservedV1Payload,
  ProtectionCoverageSettledV1Payload,
  SupportRequestPlatformCoverageRequestedV1Payload,
  SupportRequestRefundReleasedV1Payload,
  SupportRequestRemedyAuthorizedV1Payload,
  SupportRequestRemedyCompletedV1Payload,
} from "./platform-coverage-facts";
import type { MarketplaceReviewScoringDispositionProjectedV1Payload } from "./review-scoring-facts";

export type EmptyEventPayload = Readonly<Record<string, never>>;

export type AuthSessionStartedPayload = Readonly<{
  sessionId: SessionId;
  userId: UserId;
  accountId: AccountId;
  availableAccountIds: readonly string[];
  authenticationMethod: string;
  expiresAt: string;
}>;

export type AuthSessionAccountSwitchedPayload = Readonly<{
  accountId: AccountId;
}>;

export type AuthEventPayloads = Readonly<{
  "auth.session.started": AuthSessionStartedPayload;
  "auth.session.account-switched": AuthSessionAccountSwitchedPayload;
  "auth.session.revoked": EmptyEventPayload;
  "auth.session.expired": EmptyEventPayload;
}>;

export type IdentityFoundersWindowOpenedPayload = Readonly<{
  betaAccessStartedAt: string;
  foundersWindowEndsAt: string;
  /** Additive grant-time recipient for downstream access notifications. */
  recipientEmail?: string;
}>;

export type IdentityFounderNumberClaimedPayload = Readonly<{
  accountId: AccountId;
  founderNumber: number;
  qualifyingActType: "listing-created" | "offer-submitted";
  qualifyingActId: string;
  claimedAt: string;
}>;

export type IdentityAccountBadgeAssignedPayload = Readonly<{
  badgeKey: string;
  founderNumber?: number;
}>;

export type IdentityEventPayloads = Readonly<{
  "identity.account.founders-window-opened": IdentityFoundersWindowOpenedPayload;
  "identity.founders-cohort.founder-number-claimed": IdentityFounderNumberClaimedPayload;
  "identity.account.badge-assigned": IdentityAccountBadgeAssignedPayload;
}>;

export type InventoryReservationConfirmedPayload = Readonly<{
  orderId: string;
  reservationRequestId: string;
  holdId: string;
}>;

export type InventoryReservationRejectedPayload = Readonly<{
  orderId: string;
  reservationRequestId: string;
  reason: string;
}>;

export type InventoryReservationReleasedPayload = Readonly<{
  orderId: string;
  reservationRequestId: string;
  holdId: string;
  releasedAt: string;
}>;

export const inventoryHoldPurposes = ["order", "manual", "checkout", "pos", "channel", "transfer"] as const;

export type InventoryHoldPurpose = (typeof inventoryHoldPurposes)[number];

export const inventoryHoldReleaseReasons = [
  "order-cancelled",
  "checkout-cancelled",
  "checkout-expired",
  "payment-deadline",
  "hold-collision",
  "manual",
  "superseded",
] as const;

export type InventoryHoldReleaseReason = (typeof inventoryHoldReleaseReasons)[number];

export type InventoryHoldOrderSourceRef = Readonly<{
  orderId: string;
  reservationRequestId: string;
}>;

export type InventoryHoldCheckoutSourceRef = Readonly<{
  checkoutSessionId: CheckoutSessionId;
  lineKey: string;
}>;

export type InventoryHoldSourceRef = InventoryHoldOrderSourceRef | InventoryHoldCheckoutSourceRef | null;

export type InventoryHoldPlacedPayload = Readonly<{
  holdId: string;
  accountId: AccountId;
  itemId: string;
  quantity: number;
  reason: string;
  notes: string | null;
  purpose: InventoryHoldPurpose;
  sourceRef: InventoryHoldSourceRef;
  expiresAt: string | null;
}>;

export type InventoryHoldReleasedPayload = Readonly<{
  holdId: string;
  releasedAt: string;
  releaseReason: InventoryHoldReleaseReason;
}>;

export type InventoryHoldConvertedPayload = Readonly<{
  holdId: string;
  convertedAt: string;
  purpose: "order";
  sourceRef: InventoryHoldOrderSourceRef;
  expiresAt: null;
}>;

export type InventoryHoldExpiredPayload = Readonly<{
  holdId: string;
  expiredAt: string;
}>;

export type InventoryHoldExtendedPayload = Readonly<{
  holdId: string;
  extendedAt: string;
  expiresAt: string;
  extensionCount: number;
}>;

export type InventoryHoldConsumedPayload = Readonly<{
  holdId: string;
  consumedAt: string;
  consumptionReason: string;
  sourceRef: InventoryHoldSourceRef;
}>;

export type InventoryHoldCollisionRecordedPayload = Readonly<{
  collisionId: string;
  accountId: AccountId;
  itemId: string;
  storageLocationId: string;
  reason: string;
  mode: "protect-orders" | "honor-offline";
  requestedQuantity: number;
  appliedQuantity: number;
  refusedQuantity: number;
  heldQuantity: number;
  availableQuantity: number;
  releasedHoldQuantity: number;
  totalQuantityBefore: number;
  totalQuantityAfter: number;
  affectedOrders: readonly Readonly<{
    holdId: string;
    orderId: string;
    reservationRequestId: string;
    quantity: number;
    disposition: "protected" | "released";
  }>[];
  recordedAt: string;
}>;

export const inventoryRestockDecisionOutcomes = ["restocked", "written-off"] as const;

export type InventoryRestockDecisionOutcome = (typeof inventoryRestockDecisionOutcomes)[number];

export type InventoryAdjustmentSourceRef = InventoryHoldSourceRef;

export type InventoryItemAdjustedPayload = Readonly<{
  itemId: string;
  quantityDelta: number;
  reason: string;
  sourceRef?: InventoryAdjustmentSourceRef;
}>;

export type InventoryRestockDecisionPendingPayload = Readonly<{
  decisionId: string;
  accountId: AccountId;
  orderId: string;
  itemId: string;
  quantity: number;
  source: "order-cancelled-after-dispatch" | "shipment-returned";
  sourceRef: InventoryHoldSourceRef;
  shipmentId: string | null;
  returnReason: string | null;
  pendingAt: string;
}>;

export type InventoryRestockDecisionRecordedPayload = Readonly<{
  decisionId: string;
  accountId: AccountId;
  orderId: string;
  itemId: string;
  quantity: number;
  outcome: InventoryRestockDecisionOutcome;
  reason: "return-restocked" | "written-off";
  sourceRef: InventoryHoldSourceRef;
  damageNote: string | null;
  decidedAt: string;
}>;

export type InventoryRecoveredItemDispositionPayload = Readonly<{
  recoveredItemId: string;
  returnShipmentId: string;
  remedyId: string;
  disposition:
    | "return-to-original-seller"
    | "return-to-buyer"
    | "platform-resale"
    | "liquidation"
    | "donation"
    | "destruction"
    | "carrier-claim"
    | "lost-unresolved";
  policyVersion: string;
  authorityKind: string | null;
  evidenceReferences: readonly string[];
  targetAccountId: string | null;
  storageLocationId: string | null;
  occurredAt: string;
}>;

export type InventoryRecoveredItemAuthenticityReviewRequestedPayload = Readonly<{
  recoveredItemId: string;
  returnShipmentId: string;
  remedyId: string;
  catalogItemId: string;
  productId: string;
  selectedOptions: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  policyVersion: string;
  reasonCode: string;
  requestedByUserId: string;
  evidenceReferences: readonly string[];
  requestedAt: string;
}>;

export type InventoryRecoveredItemValueReportedPayload = Readonly<{
  factSchemaVersion: 1;
  recoveredItemId: string;
  returnShipmentId: string;
  remedyId: string;
  recoveryId: string;
  recoveryType: "resale-proceeds" | "liquidation-proceeds" | "carrier-claim" | "postage-refund" | "disposition-cost";
  grossAmount: string;
  costAmount: string;
  currencyCode: string;
  policyVersion: string;
  evidenceReferences: readonly string[];
  recordedAt: string;
}>;

export type InventoryEventPayloads = Readonly<{
  "inventory.item.adjusted": InventoryItemAdjustedPayload;
  "inventory.hold.placed": InventoryHoldPlacedPayload;
  "inventory.hold.released": InventoryHoldReleasedPayload;
  "inventory.hold.converted": InventoryHoldConvertedPayload;
  "inventory.hold.expired": InventoryHoldExpiredPayload;
  "inventory.hold.extended": InventoryHoldExtendedPayload;
  "inventory.hold.consumed": InventoryHoldConsumedPayload;
  "inventory.hold-collision-recorded": InventoryHoldCollisionRecordedPayload;
  "inventory.reservation.confirmed": InventoryReservationConfirmedPayload;
  "inventory.reservation.rejected": InventoryReservationRejectedPayload;
  "inventory.reservation.released": InventoryReservationReleasedPayload;
  "inventory.restock-decision.pending": InventoryRestockDecisionPendingPayload;
  "inventory.restock-decision.recorded": InventoryRestockDecisionRecordedPayload;
  "inventory.recovered-item.authenticity-review-required.v1": InventoryRecoveredItemAuthenticityReviewRequestedPayload;
  "inventory.recovered-item.sellable.v1": InventoryRecoveredItemDispositionPayload;
  "inventory.recovered-item.transferred.v1": InventoryRecoveredItemDispositionPayload;
  "inventory.recovered-item.disposed.v1": InventoryRecoveredItemDispositionPayload;
  "inventory.recovered-item.value-reported.v1": InventoryRecoveredItemValueReportedPayload;
}>;

export type OrderingReservationRequestPayload = Readonly<{
  reservationRequestId: string;
  inventoryItemId: string;
  sellerAccountId: string;
  quantity: number;
  holdId?: string | null;
  status?: string;
}>;

export type OrderingOrderCreatedPayload = Readonly<{
  orderId: string;
  reservationRequests: readonly OrderingReservationRequestPayload[];
  protectionAmount?: string;
  protectionAllowanceAmount?: string;
  protectionOverageAmount?: string;
  commercialTermsSnapshot?: Readonly<{
    marketplaceSalesFeeAmount: string;
    marketplaceSalesFeeLines?: readonly MarketplaceSalesFeeLineSnapshotPayload[];
  }>;
}>;

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

export type OrderingOrderCancelledPayload = Readonly<{
  orderId: string;
  cancelledAt: string;
  reason?: string | null;
  buyerEmail?: string | null;
  reservationRequests: readonly OrderingReservationRequestPayload[];
}>;

export type OrderingEventPayloads = Readonly<{
  "ordering.order.created": OrderingOrderCreatedPayload;
  "ordering.order.cancelled": OrderingOrderCancelledPayload;
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

export type PlatformOperationsReportedContentActionRecordedPayload = Readonly<{
  actionId: string;
  targetType: "listing" | "review";
  targetId: string;
  action: "dismiss" | "contact-seller" | "unlist" | "escalate-account-suspension";
  note: string | null;
  operatorUserId: string | null;
  recordedAt: string;
}>;

export type PlatformOperationsRiskAlertActionRecordedPayload = Readonly<{
  actionId: string;
  alertId: string;
  action: "request-manual-payout-review" | "acknowledge";
  note: string | null;
  operatorUserId: string | null;
  recordedAt: string;
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

export type CheckoutSessionPaymentStartedPayload = Readonly<{
  sessionId: CheckoutSessionId;
  paymentId: PaymentId;
  recordedAt: string;
}>;

export type CheckoutSessionCancelledPayload = Readonly<{
  sessionId: CheckoutSessionId;
  cancelledAt: string;
  releasedReservationIds: readonly string[];
}>;

export type CheckoutEventPayloads = Readonly<{
  "checkout.session.payment-started": CheckoutSessionPaymentStartedPayload;
  "checkout.session.cancelled": CheckoutSessionCancelledPayload;
}>;

export type PaymentSellerPayoutPayload = Readonly<{
  orderId: string;
  sellerAccountId: string;
  marketplaceSalesFeeAmount?: string;
  marketplaceSalesFeeLines?: readonly MarketplaceSalesFeeLineSnapshotPayload[];
  sellerItemNetAmount: string;
  shippingAllowanceAmount: string;
  sellerShippingPayoutAmount: string;
  protectionAmount?: string;
  protectionAllowanceAmount?: string;
  protectionOverageAmount?: string;
  sellerPayoutAmount: string;
}>;

export type PaymentCapturedPayload = Readonly<{
  paymentId: PaymentId;
  orderIds: readonly string[];
  buyerAccountId: AccountId;
  amount: string;
  balanceCreditAmount?: string;
  processorAmount?: string;
  authenticityFeeAmount?: string;
  marketplaceSalesFeeAmount?: string;
  marketplaceCheckoutFeeAmount?: string;
  marketplaceCheckoutFeePolicyVersion?: string | null;
  marketplaceCheckoutFeeQuoteFingerprint?: string | null;
  paymentMethodCategory?: string | null;
  sellerNetAmount?: string;
  sellerPayoutAmount?: string;
  sellerPayouts?: readonly PaymentSellerPayoutPayload[];
  currencyCode: string;
  processorName: string;
  processorPaymentReference: string;
  processorStatus: string;
  capturedAt: string;
}>;

export type PaymentCreatedPayload = Readonly<{
  paymentId: PaymentId;
  orderIds: readonly string[];
  buyerAccountId: AccountId;
  amount: string;
  balanceCreditAmount?: string;
  processorAmount?: string;
  marketplaceSalesFeeAmount?: string;
  marketplaceCheckoutFeeAmount?: string;
  marketplaceCheckoutFeePolicyVersion?: string | null;
  marketplaceCheckoutFeeQuoteFingerprint?: string | null;
  paymentMethodCategory?: string | null;
  sellerNetAmount?: string;
  sellerPayoutAmount?: string;
  sellerPayouts?: readonly PaymentSellerPayoutPayload[];
  currencyCode: string;
  processorName: string;
  processorPaymentKind?: "checkout-session" | "payment-intent" | "balance-credit";
  processorPaymentReference: string;
  processorClientSecret?: string | null;
  processorRedirectUrl?: string | null;
  processorStatus: string;
  sourceContext?: string | null;
  sourceReferenceId?: string | null;
  threeDSecureRequest?: string | null;
  threeDSecureReasonCodes?: readonly string[];
  createdAt: string;
}>;

export type PaymentFailedPayload = Readonly<{
  paymentId: PaymentId;
  orderIds: readonly string[];
  buyerAccountId: AccountId;
  amount: string;
  balanceCreditAmount?: string;
  processorAmount?: string;
  marketplaceSalesFeeAmount?: string;
  marketplaceCheckoutFeeAmount?: string;
  marketplaceCheckoutFeePolicyVersion?: string | null;
  marketplaceCheckoutFeeQuoteFingerprint?: string | null;
  paymentMethodCategory?: string | null;
  sellerNetAmount?: string;
  sellerPayoutAmount?: string;
  sellerPayouts?: readonly PaymentSellerPayoutPayload[];
  currencyCode: string;
  processorName: string;
  processorPaymentReference: string;
  processorStatus: string;
  failureCode: string | null;
  failureMessage: string | null;
  failedAt: string;
}>;

export type PaymentCancelledPayload = Readonly<{
  paymentId: PaymentId;
  cancelledAt: string;
}>;

export type PaymentsCheckoutAffordanceInstrumentPayload = Readonly<{
  instrumentId: string;
  paymentMethodCategory: "card" | "bank-account" | "platform-credit";
  instrumentRiskClusterKey: string | null;
  displayLabel: string;
  confirmationExperience: "trusted-payment-step" | "off-session-token";
  readiness: "ready" | "setup-required" | "removed";
  checkoutEligible: boolean;
  isDefault: boolean;
  removedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type PaymentsCheckoutAffordancesPublishedPayload = Readonly<{
  accountId: AccountId;
  savedCheckoutInstruments: readonly PaymentsCheckoutAffordanceInstrumentPayload[];
  publishedAt: string;
}>;

export type PaymentsEventPayloads = Readonly<{
  "payments.payment-created": PaymentCreatedPayload;
  "payments.payment-captured": PaymentCapturedPayload;
  "payments.payment-failed": PaymentFailedPayload;
  "payments.payment-cancelled": PaymentCancelledPayload;
  "payments.checkout-affordances-published": PaymentsCheckoutAffordancesPublishedPayload;
}>;

export type PayoutReadinessRecordedPayload = Readonly<{
  accountId: AccountId;
  previousStatus?: string;
  status: string;
  missingRequirements: readonly string[];
  advisoryRequirements?: readonly string[];
  disabledReason?: string | null;
  requirementsDeadline?: string | null;
  providerReference: string | null;
  contactEmail?: string | null;
  onboardingStatus?: string;
  transferCapabilityStatus?: string;
  payoutCapabilityStatus?: string;
  payoutDestinationStatus?: string;
  payoutDestinationFingerprint?: string | null;
  payoutDestinationChangedAt?: string | null;
  payoutAccountDashboard?: string;
  lossesCollector?: string;
  feesCollector?: string;
  requirementsCollector?: string;
  recordedAt: string;
}>;

export type SettlementNegativeBalanceEnteredPayload = Readonly<{
  accountId: AccountId;
  balanceAmount: string;
  enteredAt: string;
}>;

export type SettlementNegativeBalanceCollectionsOpenedPayload = Readonly<{
  accountId: AccountId;
  balanceAmount: string;
  negativeSince: string;
  thresholdAmount: string;
  gracePeriodDays: number;
  openedAt: string;
}>;

export type SettlementNegativeBalanceRecoveredPayload = Readonly<{
  accountId: AccountId;
  balanceAmount: string;
  recoveredAt: string;
}>;

export type SettlementProtectionCoverageRecoveryPostedPayload = Readonly<{
  factSchemaVersion: 1;
  recoveryId: string;
  coverageId: string;
  remedyId: string;
  recoveredItemId: string;
  returnShipmentId: string;
  recoveryType: InventoryRecoveredItemValueReportedPayload["recoveryType"];
  grossAmount: string;
  costAmount: string;
  netAmount: string;
  currencyCode: string;
  policyVersion: string;
  evidenceReferences: readonly string[];
  causationId: string | null;
  occurredAt: string;
}>;

/**
 * Support-safe settlement support-hold lifecycle facts (milestone Dispute & Return
 * Resolution Self-Service). Settlement freezes seller funds while a support case is
 * open and releases them when the case resolves without a refund. These facts let
 * notification routing subscribe to placed/released transitions instead of inferring
 * them from `settlement_support_holds` storage, and they carry only the identifiers
 * needed to route a buyer/seller notice and deep-link the case and order — never a
 * payout ledger internal, a raw provider id, or a customer-sensitive payload.
 */
export type SettlementSupportHoldFactEnvelope = Readonly<{
  factSchemaVersion: 1;
  /** Deterministic settlement hold id, stable across replay and equal to the read-model `hold_id`. */
  holdId: string;
  /** The support case that placed the hold — the notification deep-link anchor. */
  supportRequestId: string;
  /** The order under dispute — routing/order-context anchor. */
  orderId: string;
  /** Buyer routing target for the counterparty notice. */
  buyerAccountId: AccountId;
  /** Seller routing target — the party whose payout is frozen/released. */
  sellerAccountId: AccountId;
  /** Structured dispute flow (e.g. product-damaged); a routing label, not a free-form payload. */
  flowType: string;
  occurredAt: string;
}>;

export type SettlementSupportHoldPlacedPayload = SettlementSupportHoldFactEnvelope;

/** Why a support hold was released back to the seller. A closed vocabulary keeps notification copy exhaustive. */
export type SettlementSupportHoldReleaseReason = "support-resolved" | "support-closed" | "support-cancelled";

/** A support hold released back to the seller — the case ended without consuming the funds. */
export type SettlementSupportHoldReleasedPayload = SettlementSupportHoldFactEnvelope &
  Readonly<{
    releaseReason: SettlementSupportHoldReleaseReason;
  }>;

/**
 * A support hold consumed by a refund resolution — the frozen funds were applied to the
 * buyer's remedy, not returned to the seller. Distinct from `released` so seller-facing
 * copy never says "funds released back to you" when they were spent. The buyer's own
 * refund notice is owned elsewhere; this fact is the terminal lifecycle signal and keeps
 * a later case close from emitting a spurious release.
 */
export type SettlementSupportHoldConsumedPayload = SettlementSupportHoldFactEnvelope &
  Readonly<{
    /** The refund resolution that consumed the hold (e.g. full-refund, return-for-refund). */
    resolutionType: string;
  }>;

export type SettlementEventPayloads = Readonly<{
  "settlement.payout-readiness.recorded": PayoutReadinessRecordedPayload;
  "settlement.wallet.negative-balance-entered": SettlementNegativeBalanceEnteredPayload;
  "settlement.wallet.negative-balance-collections-opened": SettlementNegativeBalanceCollectionsOpenedPayload;
  "settlement.wallet.negative-balance-recovered": SettlementNegativeBalanceRecoveredPayload;
  // Platform-covered resolution — Settlement owns protection-coverage financial truth (ADR 0022).
  "settlement.protection-coverage.reserved.v1": ProtectionCoverageReservedV1Payload;
  "settlement.protection-coverage.rejected.v1": ProtectionCoverageRejectedV1Payload;
  "settlement.protection-coverage.settled.v1": ProtectionCoverageSettledV1Payload;
  "settlement.protection-coverage.recovery-posted.v1": SettlementProtectionCoverageRecoveryPostedPayload;
  // Support-hold lifecycle facts for dispute notification routing.
  "settlement.support-hold.placed.v1": SettlementSupportHoldPlacedPayload;
  "settlement.support-hold.released.v1": SettlementSupportHoldReleasedPayload;
  "settlement.support-hold.consumed.v1": SettlementSupportHoldConsumedPayload;
}>;

/**
 * Support-owned platform-covered resolution facts (ADR 0022). The `support.*` stream
 * prefix is the ubiquitous name for the support-request aggregate that Platform
 * Operations hosts; payload types and runtime validators live in
 * `./platform-coverage-facts`.
 */
export type SupportRequestPlatformCoverageEventPayloads = Readonly<{
  "support.support-request.remedy-authorized.v1": SupportRequestRemedyAuthorizedV1Payload;
  "support.support-request.platform-coverage-requested.v1": SupportRequestPlatformCoverageRequestedV1Payload;
  "support.support-request.refund-released.v1": SupportRequestRefundReleasedV1Payload;
  "support.support-request.remedy-completed.v1": SupportRequestRemedyCompletedV1Payload;
}>;

export type WaitlistSourcePayload = Readonly<{
  pagePath: string;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
}>;

/** Wave-1 cohort quality signals, captured only from sell/both-intent signups. */
export type WaitlistCohortQualityPayload = Readonly<{
  games: readonly string[];
  hasStoreLink: boolean;
  storeUrl: string | null;
  inventorySize: string | null;
}>;

export type WaitlistSignupRecordedPayload = Readonly<{
  signupId: string;
  email: string;
  role: string;
  interests: readonly string[];
  /** Implied early-access consent, granted automatically at signup time (never user-optional). */
  emailConsentAcceptedAt: string;
  /** Optional consent to additional product updates beyond early-access notifications. */
  marketingConsentAcceptedAt: string | null;
  source: WaitlistSourcePayload;
  /** Referring signup's id, set once at initial signup only. Additive/optional so legacy events without it replay as unattributed. */
  referredBySignupId?: string | null;
  /** Additive/optional so legacy events without it replay as an empty cohort-quality record. */
  cohortQuality?: WaitlistCohortQualityPayload;
  recordedAt?: string;
}>;

export type WaitlistSignupUpdatedPayload = WaitlistSignupRecordedPayload &
  Readonly<{
    updatedAt?: string;
  }>;

/**
 * Progressive cohort-quality save from the post-signup welcome page: carries
 * the full merged cohort-quality record (not a delta) so projections replace
 * the read-model columns without re-deriving merge semantics.
 */
export type WaitlistCohortQualityProvidedPayload = Readonly<{
  signupId: string;
  cohortQuality: WaitlistCohortQualityPayload;
  providedAt: string;
}>;

export type WaitlistSignupAdmittedPayload = Readonly<{
  signupId: string;
  email: string;
  waveNumber: 1 | 2 | 3;
  invitationId: string;
  admittedAt: string;
}>;

export type PublicPresenceEventPayloads = Readonly<{
  "public-presence.waitlist-signup.recorded": WaitlistSignupRecordedPayload;
  "public-presence.waitlist-signup.updated": WaitlistSignupUpdatedPayload;
  "public-presence.waitlist-signup.cohort-quality-provided": WaitlistCohortQualityProvidedPayload;
  "public-presence.waitlist-signup.admitted": WaitlistSignupAdmittedPayload;
}>;

export type PlatformFeedbackSubmittedPayload = Readonly<{
  feedbackId: string;
  userId: string;
  accountId: string;
  rating: number;
  topic: string;
  comment: string | null;
  followUpConsent: boolean;
  workflow: string;
  sourceRoutePath: string;
  relatedEntities: readonly JsonValue[];
  relatedEntityKey: string | null;
  submittedAt: string;
}>;

export type PlatformFeedbackPromptDismissedPayload = Readonly<{
  promptId: string;
  userId: string;
  accountId: string;
  workflow: string;
  sourceRoutePath: string;
  relatedEntities: readonly JsonValue[];
  relatedEntityKey: string | null;
  dismissedAt: string;
  snoozedUntil: string;
}>;

export type PlatformFeedbackReviewedPayload = Readonly<{
  feedbackId: string;
  reviewedByUserId: string;
  reviewedAt: string;
}>;

export type PlatformFeedbackArchivedPayload = Readonly<{
  feedbackId: string;
  archivedByUserId: string;
  archivedAt: string;
}>;

export type PlatformFeedbackOperatorNoteRecordedPayload = Readonly<{
  feedbackId: string;
  noteId: string;
  body: string;
  recordedByUserId: string;
  recordedAt: string;
}>;

export type PlatformOperationsEventPayloads = Readonly<{
  "experience.platform-feedback.submitted": PlatformFeedbackSubmittedPayload;
  "experience.platform-feedback.prompt-dismissed": PlatformFeedbackPromptDismissedPayload;
  "experience.platform-feedback.reviewed": PlatformFeedbackReviewedPayload;
  "experience.platform-feedback.archived": PlatformFeedbackArchivedPayload;
  "experience.platform-feedback.operator-note-recorded": PlatformFeedbackOperatorNoteRecordedPayload;
}>;

export type ChaseSetsEventPayloads = AuthEventPayloads &
  IdentityEventPayloads &
  CheckoutEventPayloads &
  InventoryEventPayloads &
  OrderingEventPayloads &
  MarketplaceEventPayloads &
  PaymentsEventPayloads &
  SettlementEventPayloads &
  SupportRequestPlatformCoverageEventPayloads &
  PublicPresenceEventPayloads &
  PlatformOperationsEventPayloads;
