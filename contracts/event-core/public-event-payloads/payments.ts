// Payments-owned public event payloads.
import type { AccountId, PaymentId } from "../../primitives/typed-ids";
import type { MarketplaceSalesFeeLineSnapshotPayload } from "./marketplace";

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
