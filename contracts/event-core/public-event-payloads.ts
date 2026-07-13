import type { AddressSnapshot } from "../primitives/address-snapshot";
import type { JsonObject, JsonValue } from "../primitives/json";
import type { AccountId, CheckoutSessionId, PaymentId, SessionId, UserId } from "../primitives/typed-ids";

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

export type InventoryEventPayloads = Readonly<{
  "inventory.item.adjusted": InventoryItemAdjustedPayload;
  "inventory.hold.placed": InventoryHoldPlacedPayload;
  "inventory.hold.released": InventoryHoldReleasedPayload;
  "inventory.hold.converted": InventoryHoldConvertedPayload;
  "inventory.hold.expired": InventoryHoldExpiredPayload;
  "inventory.hold.extended": InventoryHoldExtendedPayload;
  "inventory.hold.consumed": InventoryHoldConsumedPayload;
  "inventory.reservation.confirmed": InventoryReservationConfirmedPayload;
  "inventory.reservation.rejected": InventoryReservationRejectedPayload;
  "inventory.reservation.released": InventoryReservationReleasedPayload;
  "inventory.restock-decision.pending": InventoryRestockDecisionPendingPayload;
  "inventory.restock-decision.recorded": InventoryRestockDecisionRecordedPayload;
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

export type SettlementEventPayloads = Readonly<{
  "settlement.payout-readiness.recorded": PayoutReadinessRecordedPayload;
  "settlement.wallet.negative-balance-entered": SettlementNegativeBalanceEnteredPayload;
  "settlement.wallet.negative-balance-collections-opened": SettlementNegativeBalanceCollectionsOpenedPayload;
  "settlement.wallet.negative-balance-recovered": SettlementNegativeBalanceRecoveredPayload;
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

export type PublicPresenceEventPayloads = Readonly<{
  "public-presence.waitlist-signup.recorded": WaitlistSignupRecordedPayload;
  "public-presence.waitlist-signup.updated": WaitlistSignupUpdatedPayload;
  "public-presence.waitlist-signup.cohort-quality-provided": WaitlistCohortQualityProvidedPayload;
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
  PublicPresenceEventPayloads &
  PlatformOperationsEventPayloads;
