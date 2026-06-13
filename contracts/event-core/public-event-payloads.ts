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

export type InventoryEventPayloads = Readonly<{
  "inventory.reservation.confirmed": InventoryReservationConfirmedPayload;
  "inventory.reservation.rejected": InventoryReservationRejectedPayload;
  "inventory.reservation.released": InventoryReservationReleasedPayload;
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

export type MarketplacePurchaseLimitsPayload = Readonly<{
  maxUnitsPerOrder: number | null;
  maxUnitsPerDay: number | null;
  maxUnitsPerCustomerAccount: number | null;
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

export type MarketplaceEventPayloads = Readonly<{
  "marketplace.listing.created": MarketplaceListingCreatedPayload;
  "marketplace.listing.price-updated": MarketplaceListingPriceUpdatedPayload;
  "marketplace.listing.quantity-cap-updated": MarketplaceListingQuantityCapUpdatedPayload;
  "marketplace.listing.purchase-limits-updated": MarketplaceListingPurchaseLimitsUpdatedPayload;
  "marketplace.listing.published": MarketplaceListingPriceUpdatedPayload;
  "marketplace.listing.paused": EmptyEventPayload;
  "marketplace.listing.withdrawn": EmptyEventPayload;
  "marketplace.seller-listing-availability.disabled": MarketplaceSellerListingAvailabilityPayload;
  "marketplace.seller-listing-availability.enabled": MarketplaceSellerListingAvailabilityPayload;
  "marketplace.offer.accepted": MarketplaceOfferAcceptedPayload;
}>;

export type CheckoutSessionPaymentStartedPayload = Readonly<{
  sessionId: CheckoutSessionId;
  paymentId: PaymentId;
  recordedAt: string;
}>;

export type CheckoutEventPayloads = Readonly<{
  "checkout.session.payment-started": CheckoutSessionPaymentStartedPayload;
}>;

export type PaymentCapturedPayload = Readonly<{
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
  sellerPayouts?: readonly JsonObject[];
  currencyCode: string;
  processorName: string;
  processorPaymentReference: string;
  processorStatus: string;
  capturedAt: string;
}>;

export type PaymentsEventPayloads = Readonly<{
  "payments.payment-captured": PaymentCapturedPayload;
}>;

export type PayoutReadinessRecordedPayload = Readonly<{
  accountId: AccountId;
  status: string;
  missingRequirements: readonly string[];
  providerReference: string | null;
  onboardingStatus?: string;
  transferCapabilityStatus?: string;
  payoutCapabilityStatus?: string;
  payoutDestinationStatus?: string;
  payoutAccountDashboard?: string;
  lossesCollector?: string;
  feesCollector?: string;
  requirementsCollector?: string;
  recordedAt: string;
}>;

export type SettlementEventPayloads = Readonly<{
  "settlement.payout-readiness.recorded": PayoutReadinessRecordedPayload;
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

export type WaitlistSignupRecordedPayload = Readonly<{
  signupId: string;
  email: string;
  role: string;
  interests: readonly string[];
  emailConsentAcceptedAt: string;
  source: WaitlistSourcePayload;
  recordedAt?: string;
}>;

export type WaitlistSignupUpdatedPayload = WaitlistSignupRecordedPayload &
  Readonly<{
    updatedAt?: string;
  }>;

export type PublicPresenceEventPayloads = Readonly<{
  "public-presence.waitlist-signup.recorded": WaitlistSignupRecordedPayload;
  "public-presence.waitlist-signup.updated": WaitlistSignupUpdatedPayload;
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

export type PlatformOperationsEventPayloads = Readonly<{
  "experience.platform-feedback.submitted": PlatformFeedbackSubmittedPayload;
  "experience.platform-feedback.prompt-dismissed": PlatformFeedbackPromptDismissedPayload;
  "experience.platform-feedback.reviewed": PlatformFeedbackReviewedPayload;
  "experience.platform-feedback.archived": PlatformFeedbackArchivedPayload;
}>;

export type ChaseSetsEventPayloads = AuthEventPayloads &
  CheckoutEventPayloads &
  InventoryEventPayloads &
  MarketplaceEventPayloads &
  PaymentsEventPayloads &
  SettlementEventPayloads &
  PublicPresenceEventPayloads &
  PlatformOperationsEventPayloads;
