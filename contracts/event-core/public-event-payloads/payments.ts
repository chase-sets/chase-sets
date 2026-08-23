// Payments-owned public event payloads.
import type { LiabilityAllocationFactV1 } from "../platform-coverage-facts";
import type { RefundTrigger } from "../../primitives/platform-coverage";
import type { AccountId, OrderId, PaymentId, TypedUlid } from "../../primitives/typed-ids";
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

export type PaymentRefundOrderAmountPayload = Readonly<{
  orderId: OrderId;
  amount: string;
}>;

export type PaymentRefundCausationPayload = Readonly<{
  remedyId: string;
  coverageId: string | null;
  allocation: LiabilityAllocationFactV1;
  reasonCode: string;
  refundTrigger: RefundTrigger;
  refundTriggerEvidenceRef: string | null;
  policyVersion: string | null;
}>;

export type PaymentRefundedPayload = Readonly<{
  paymentId: PaymentId;
  refundId: TypedUlid<"rfd"> | null;
  orderIds: readonly OrderId[];
  buyerAccountId: AccountId;
  amount: string;
  refundedAmount: string;
  orderRefundAmounts: readonly PaymentRefundOrderAmountPayload[];
  refundedOrderAmounts: readonly PaymentRefundOrderAmountPayload[];
  orderRefundCaps: readonly PaymentRefundOrderAmountPayload[];
  currencyCode: "usd";
  processorName: "stripe";
  processorPaymentReference: string;
  sellerPayouts: readonly PaymentSellerPayoutPayload[];
  processorRefundReference: string | null;
  processorStatus: string;
  refundedAt: string;
}>;

export type PaymentRefundRequestedPayload = Readonly<{
  refundId: TypedUlid<"rfd">;
  paymentId: PaymentId;
  orderIds: readonly OrderId[];
  amount: string;
  currencyCode: "usd";
  reason: string;
  processorName: "stripe";
  causation?: PaymentRefundCausationPayload;
  requestedAt: string;
}>;

export type PaymentRefundIssuedPayload = Readonly<{
  refundId: TypedUlid<"rfd">;
  paymentId: PaymentId;
  orderIds: readonly OrderId[];
  amount: string;
  currencyCode: "usd";
  reason: string;
  processorName: "stripe";
  processorRefundReference: string;
  processorStatus: string;
  causation?: PaymentRefundCausationPayload;
  issuedAt: string;
}>;

export type PaymentRefundFailedPayload = Readonly<{
  refundId: TypedUlid<"rfd">;
  paymentId: PaymentId;
  orderIds: readonly OrderId[];
  amount: string;
  currencyCode: "usd";
  reason: string;
  processorName: "stripe";
  processorStatus: string;
  failureCode: string | null;
  failureMessage: string | null;
  causation?: PaymentRefundCausationPayload;
  failedAt: string;
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
  "payments.payment-refunded": PaymentRefundedPayload;
  "payments.refund-requested": PaymentRefundRequestedPayload;
  "payments.refund-issued": PaymentRefundIssuedPayload;
  "payments.refund-failed": PaymentRefundFailedPayload;
  "payments.checkout-affordances-published": PaymentsCheckoutAffordancesPublishedPayload;
}>;
