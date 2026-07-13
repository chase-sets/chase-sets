import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
  PaymentCancelledPayload,
  PaymentCapturedPayload,
  PaymentCreatedPayload,
  PaymentFailedPayload,
} from "@chase-sets/event-core";
import type { AccountId, OrderId, PaymentId } from "@chase-sets/primitives/typed-ids";
import type { MarketplaceSalesFeeLineSnapshotPayload } from "@chase-sets/event-core";
import {
  assert,
  assertNever,
  compareMoney,
  ensureIsoTimestamp,
  normalizeCurrencyCode,
  normalizeMoneyAmount,
  normalizeOptionalText,
  normalizeOrderIds,
  normalizeProcessorName,
  normalizeRequiredText,
  subtractMoney,
  type CurrencyCode,
  type PaymentProcessorName,
  type PaymentStatus,
  type RefundId,
} from "../../../support/runtime-support/common";

export type OrderMoneyAmount = Readonly<{
  orderId: OrderId;
  amount: string;
}>;

export type PaymentRefundRequest = Readonly<{
  refundId: RefundId;
  orderIds: readonly OrderId[];
  amount: string;
}>;

export type IssuedPaymentRefund = Readonly<{
  refundId: RefundId | null;
  processorRefundReference: string | null;
  orderIds: readonly OrderId[];
  amount: string;
}>;

export type PaymentFraudReview = Readonly<{
  providerReviewId: string;
  providerChargeReference: string | null;
  reason: string | null;
  status: "opened" | "closed";
  outcome: string | null;
  openedAt: string | null;
  closedAt: string | null;
}>;

export type ThreeDSecureRequest = "automatic" | "any";
export type PaymentLiabilityShiftStatus =
  | "not-requested"
  | "requested"
  | "shifted"
  | "not-shifted"
  | "attempted"
  | "authentication-failed"
  | "unknown";

export type PaymentLiabilityShiftOutcome = Readonly<{
  providerEventId: string;
  threeDSecureRequested: ThreeDSecureRequest | null;
  status: PaymentLiabilityShiftStatus;
  authenticationResult: string | null;
  radarRiskLevel: string | null;
  recordedAt: string;
}>;
export type PaymentDisputeLifecycleState = "created" | "updated" | "won" | "lost";
export type PaymentDisputeEvidenceStatus = "submitted" | "unavailable";

export type PaymentDisputeEvidenceRecord = Readonly<{
  providerDisputeId: string;
  status: PaymentDisputeEvidenceStatus;
  reason: string | null;
  submittedAt: string | null;
  recordedAt: string;
}>;

export type PaymentDisputeEvidenceSummary = Readonly<{
  trackingNumbers: readonly string[];
  carriers: readonly string[];
  deliveredAt: string | null;
  orderIds: readonly OrderId[];
  hasDeliveryProof: boolean;
}>;

export type PaymentState = Readonly<{
  paymentId: PaymentId | null;
  buyerAccountId: AccountId | null;
  orderIds: readonly OrderId[];
  orderRefundCaps: readonly OrderMoneyAmount[];
  amount: string | null;
  balanceCreditAmount: string;
  processorAmount: string | null;
  marketplaceSalesFeeAmount: string | null;
  authenticityFeeAmount: string | null;
  marketplaceCheckoutFeeAmount: string | null;
  marketplaceCheckoutFeePolicyVersion: string | null;
  marketplaceCheckoutFeeQuoteFingerprint: string | null;
  paymentMethodCategory: string | null;
  savedCheckoutInstrumentId: string | null;
  sellerNetAmount: string | null;
  sellerPayoutAmount: string | null;
  sellerPayouts: readonly SellerPayoutComponent[];
  currencyCode: CurrencyCode | null;
  processorName: PaymentProcessorName | null;
  processorPaymentKind: "checkout-session" | "payment-intent" | "balance-credit" | null;
  processorPaymentReference: string | null;
  processorClientSecret: string | null;
  processorRedirectUrl: string | null;
  processorStatus: string | null;
  sourceContext: string | null;
  sourceReferenceId: string | null;
  status: PaymentStatus | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string | null;
  authorizedAt: string | null;
  capturedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  refundedAt: string | null;
  refundedAmount: string;
  refundedOrderAmounts: readonly OrderMoneyAmount[];
  refundRequests: readonly PaymentRefundRequest[];
  issuedRefunds: readonly IssuedPaymentRefund[];
  disputedAt: string | null;
  disputeProviderEventIds: readonly string[];
  disputeEvidenceRecords: readonly PaymentDisputeEvidenceRecord[];
  earlyFraudWarningIds: readonly string[];
  fraudReviews: readonly PaymentFraudReview[];
  threeDSecureRequest: ThreeDSecureRequest | null;
  threeDSecureReasonCodes: readonly string[];
  liabilityShiftOutcomes: readonly PaymentLiabilityShiftOutcome[];
}>;

export type SellerPayoutComponent = Readonly<{
  orderId: OrderId;
  sellerAccountId: AccountId;
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

export const initialPaymentState: PaymentState = {
  paymentId: null,
  buyerAccountId: null,
  orderIds: [],
  orderRefundCaps: [],
  amount: null,
  balanceCreditAmount: "0.00",
  processorAmount: null,
  marketplaceSalesFeeAmount: null,
  authenticityFeeAmount: null,
  marketplaceCheckoutFeeAmount: null,
  marketplaceCheckoutFeePolicyVersion: null,
  marketplaceCheckoutFeeQuoteFingerprint: null,
  paymentMethodCategory: null,
  savedCheckoutInstrumentId: null,
  sellerNetAmount: null,
  sellerPayoutAmount: null,
  sellerPayouts: [],
  currencyCode: null,
  processorName: null,
  processorPaymentKind: null,
  processorPaymentReference: null,
  processorClientSecret: null,
  processorRedirectUrl: null,
  processorStatus: null,
  sourceContext: null,
  sourceReferenceId: null,
  status: null,
  failureCode: null,
  failureMessage: null,
  createdAt: null,
  authorizedAt: null,
  capturedAt: null,
  failedAt: null,
  cancelledAt: null,
  refundedAt: null,
  refundedAmount: "0.00",
  refundedOrderAmounts: [],
  refundRequests: [],
  issuedRefunds: [],
  disputedAt: null,
  disputeProviderEventIds: [],
  disputeEvidenceRecords: [],
  earlyFraudWarningIds: [],
  fraudReviews: [],
  threeDSecureRequest: null,
  threeDSecureReasonCodes: [],
  liabilityShiftOutcomes: [],
};

export type CreatePaymentCommand = Readonly<{
  type: "CreatePayment";
  paymentId: PaymentId;
  buyerAccountId: AccountId;
  orderIds: readonly OrderId[];
  amount: string;
  balanceCreditAmount?: string;
  processorAmount?: string;
  marketplaceSalesFeeAmount: string;
  authenticityFeeAmount?: string;
  marketplaceCheckoutFeeAmount: string;
  marketplaceCheckoutFeePolicyVersion?: string | null;
  marketplaceCheckoutFeeQuoteFingerprint?: string | null;
  paymentMethodCategory?: string | null;
  savedCheckoutInstrumentId?: string | null;
  sellerNetAmount: string;
  sellerPayoutAmount?: string;
  sellerPayouts?: readonly SellerPayoutComponent[];
  orderRefundCaps?: readonly OrderMoneyAmount[];
  currencyCode: CurrencyCode;
  processorName: PaymentProcessorName;
  processorPaymentKind: "checkout-session" | "payment-intent" | "balance-credit";
  processorPaymentReference: string;
  processorClientSecret: string | null;
  processorRedirectUrl?: string | null;
  processorStatus: string;
  sourceContext?: string | null;
  sourceReferenceId?: string | null;
  threeDSecureRequest?: ThreeDSecureRequest | null;
  threeDSecureReasonCodes?: readonly string[];
  createdAt: string;
}>;

export type RecordPaymentAuthorizationCommand = Readonly<{
  type: "RecordPaymentAuthorization";
  processorStatus: string;
  authorizedAt: string;
}>;

export type RecordPaymentCaptureCommand = Readonly<{
  type: "RecordPaymentCapture";
  processorStatus: string;
  capturedAt: string;
}>;

export type RecordPaymentFailureCommand = Readonly<{
  type: "RecordPaymentFailure";
  processorStatus: string;
  failureCode: string | null;
  failureMessage: string | null;
  failedAt: string;
}>;

export type CancelPaymentCommand = Readonly<{
  type: "CancelPayment";
  cancelledAt: string;
}>;

export type RecordPaymentRefundCommand = Readonly<{
  type: "RecordPaymentRefund";
  refundId?: RefundId | null;
  orderIds?: readonly OrderId[] | null;
  processorStatus: string;
  processorRefundReference: string | null;
  amount: string | null;
  refundedAmount?: string | null;
  refundedAt: string;
}>;

export type RequestPaymentRefundCommand = Readonly<{
  type: "RequestPaymentRefund";
  refundId: RefundId;
  orderIds: readonly OrderId[];
  amount: string;
  requestedAt: string;
}>;

export type RecordPaymentDisputeCommand = Readonly<{
  type: "RecordPaymentDispute";
  providerEventId?: string | null;
  providerDisputeId?: string | null;
  providerChargeReference?: string | null;
  processorStatus: string;
  disputeStatus: string | null;
  disputeMessage: string | null;
  disputeLifecycleState?: PaymentDisputeLifecycleState | null;
  disputeReason?: string | null;
  disputeEvidenceDueAt?: string | null;
  amount: string | null;
  disputedAt: string;
}>;

export type RecordPaymentDisputeEvidenceSubmittedCommand = Readonly<{
  type: "RecordPaymentDisputeEvidenceSubmitted";
  providerDisputeId: string;
  processorStatus: string;
  evidenceSummary: PaymentDisputeEvidenceSummary;
  submittedAt: string;
}>;

export type RecordPaymentDisputeEvidenceUnavailableCommand = Readonly<{
  type: "RecordPaymentDisputeEvidenceUnavailable";
  providerDisputeId: string;
  reason: string;
  evidenceSummary: PaymentDisputeEvidenceSummary;
  recordedAt: string;
}>;

export type RecordPaymentEarlyFraudWarningCommand = Readonly<{
  type: "RecordPaymentEarlyFraudWarning";
  providerEventId: string;
  earlyFraudWarningId: string;
  providerChargeReference?: string | null;
  processorStatus: string;
  fraudType?: string | null;
  chargeDisputed: boolean;
  receivedAt: string;
}>;

export type RecordPaymentFraudReviewOpenedCommand = Readonly<{
  type: "RecordPaymentFraudReviewOpened";
  providerEventId: string;
  providerReviewId: string;
  providerChargeReference?: string | null;
  processorStatus: string;
  reason?: string | null;
  openedAt: string;
}>;

export type RecordPaymentFraudReviewClosedCommand = Readonly<{
  type: "RecordPaymentFraudReviewClosed";
  providerEventId: string;
  providerReviewId: string;
  providerChargeReference?: string | null;
  processorStatus: string;
  reason?: string | null;
  outcome?: string | null;
  closedAt: string;
}>;

export type RecordPaymentLiabilityShiftOutcomeCommand = Readonly<{
  type: "RecordPaymentLiabilityShiftOutcome";
  providerEventId: string;
  threeDSecureRequested?: ThreeDSecureRequest | null;
  status: PaymentLiabilityShiftStatus;
  authenticationResult?: string | null;
  radarRiskLevel?: string | null;
  recordedAt: string;
}>;

export type PaymentCommand =
  | CreatePaymentCommand
  | RecordPaymentAuthorizationCommand
  | RecordPaymentCaptureCommand
  | RecordPaymentFailureCommand
  | CancelPaymentCommand
  | RequestPaymentRefundCommand
  | RecordPaymentRefundCommand
  | RecordPaymentDisputeCommand
  | RecordPaymentDisputeEvidenceSubmittedCommand
  | RecordPaymentDisputeEvidenceUnavailableCommand
  | RecordPaymentEarlyFraudWarningCommand
  | RecordPaymentFraudReviewOpenedCommand
  | RecordPaymentFraudReviewClosedCommand
  | RecordPaymentLiabilityShiftOutcomeCommand;

export type PaymentCreatedEvent = DomainEvent<
  "payments.payment-created",
  PaymentCreatedPayload &
    Readonly<{
      paymentId: PaymentId;
      buyerAccountId: AccountId;
      orderIds: OrderId[];
      balanceCreditAmount: string;
      processorAmount: string;
      marketplaceSalesFeeAmount: string;
      authenticityFeeAmount: string;
      marketplaceCheckoutFeeAmount: string;
      marketplaceCheckoutFeePolicyVersion: string | null;
      marketplaceCheckoutFeeQuoteFingerprint: string | null;
      paymentMethodCategory: string | null;
      savedCheckoutInstrumentId: string | null;
      sellerNetAmount: string;
      sellerPayoutAmount: string;
      sellerPayouts: SellerPayoutComponent[];
      orderRefundCaps: OrderMoneyAmount[];
      currencyCode: CurrencyCode;
      processorName: PaymentProcessorName;
      processorPaymentKind: "checkout-session" | "payment-intent" | "balance-credit";
      processorPaymentReference: string;
      processorClientSecret: string | null;
      processorRedirectUrl: string | null;
      processorStatus: string;
      sourceContext: string | null;
      sourceReferenceId: string | null;
      threeDSecureRequest: ThreeDSecureRequest | null;
      threeDSecureReasonCodes: string[];
    }>
>;

export type PaymentAuthorizedEvent = DomainEvent<
  "payments.payment-authorized",
  Readonly<{
    paymentId: PaymentId;
    processorStatus: string;
    authorizedAt: string;
  }>
>;

export type PaymentCapturedEvent = DomainEvent<
  "payments.payment-captured",
  PaymentCapturedPayload &
    Readonly<{
      paymentId: PaymentId;
      buyerAccountId: AccountId;
      orderIds: OrderId[];
      balanceCreditAmount: string;
      processorAmount: string;
      marketplaceSalesFeeAmount: string;
      authenticityFeeAmount: string;
      marketplaceCheckoutFeeAmount: string;
      marketplaceCheckoutFeePolicyVersion: string | null;
      marketplaceCheckoutFeeQuoteFingerprint: string | null;
      paymentMethodCategory: string | null;
      sellerNetAmount: string;
      sellerPayoutAmount: string;
      sellerPayouts: SellerPayoutComponent[];
      currencyCode: CurrencyCode;
      processorName: PaymentProcessorName;
      processorPaymentReference: string;
      processorStatus: string;
    }>
>;

export type PaymentFailedEvent = DomainEvent<
  "payments.payment-failed",
  PaymentFailedPayload &
    Readonly<{
      paymentId: PaymentId;
      buyerAccountId: AccountId;
      orderIds: OrderId[];
      balanceCreditAmount: string;
      processorAmount: string;
      marketplaceSalesFeeAmount: string;
      marketplaceCheckoutFeeAmount: string;
      marketplaceCheckoutFeePolicyVersion: string | null;
      marketplaceCheckoutFeeQuoteFingerprint: string | null;
      paymentMethodCategory: string | null;
      sellerNetAmount: string;
      sellerPayoutAmount: string;
      sellerPayouts: SellerPayoutComponent[];
      currencyCode: CurrencyCode;
      processorName: PaymentProcessorName;
      processorPaymentReference: string;
      processorStatus: string;
      failureCode: string | null;
      failureMessage: string | null;
    }>
>;

export type PaymentCancelledEvent = DomainEvent<"payments.payment-cancelled", PaymentCancelledPayload>;

export type PaymentRefundRequestedEvent = DomainEvent<
  "payments.payment-refund-requested",
  Readonly<{
    paymentId: PaymentId;
    refundId: RefundId;
    orderIds: OrderId[];
    amount: string;
    requestedAt: string;
  }>
>;

export type PaymentRefundedEvent = DomainEvent<
  "payments.payment-refunded",
  Readonly<{
    paymentId: PaymentId;
    refundId: RefundId | null;
    orderIds: OrderId[];
    buyerAccountId: AccountId;
    amount: string;
    refundedAmount: string;
    orderRefundAmounts: OrderMoneyAmount[];
    refundedOrderAmounts: OrderMoneyAmount[];
    orderRefundCaps: OrderMoneyAmount[];
    currencyCode: CurrencyCode;
    processorName: PaymentProcessorName;
    processorPaymentReference: string;
    sellerPayouts: SellerPayoutComponent[];
    processorRefundReference: string | null;
    processorStatus: string;
    refundedAt: string;
  }>
>;

export type PaymentDisputedEvent = DomainEvent<
  "payments.payment-disputed",
  Readonly<{
    paymentId: PaymentId;
    orderIds: OrderId[];
    buyerAccountId: AccountId;
    amount: string;
    currencyCode: CurrencyCode;
    processorName: PaymentProcessorName;
    processorPaymentReference: string;
    providerEventId: string | null;
    providerDisputeId: string;
    providerChargeReference: string | null;
    processorStatus: string;
    disputeStatus: string | null;
    disputeMessage: string | null;
    disputeLifecycleState: PaymentDisputeLifecycleState;
    disputeReason: string | null;
    disputeEvidenceDueAt: string | null;
    sellerPayouts: SellerPayoutComponent[];
    disputedAt: string;
  }>
>;

export type PaymentDisputeEvidenceSubmittedEvent = DomainEvent<
  "payments.payment-dispute-evidence-submitted",
  Readonly<{
    paymentId: PaymentId;
    orderIds: OrderId[];
    providerDisputeId: string;
    processorName: PaymentProcessorName;
    processorPaymentReference: string;
    processorStatus: string;
    evidenceSummary: PaymentDisputeEvidenceSummary;
    submittedAt: string;
  }>
>;

export type PaymentDisputeEvidenceUnavailableEvent = DomainEvent<
  "payments.payment-dispute-evidence-unavailable",
  Readonly<{
    paymentId: PaymentId;
    orderIds: OrderId[];
    providerDisputeId: string;
    reason: string;
    evidenceSummary: PaymentDisputeEvidenceSummary;
    recordedAt: string;
  }>
>;

export type PaymentEarlyFraudWarningReceivedEvent = DomainEvent<
  "payments.payment-fraud-warning-received",
  Readonly<{
    paymentId: PaymentId;
    orderIds: OrderId[];
    buyerAccountId: AccountId;
    sellerPayouts: SellerPayoutComponent[];
    processorName: PaymentProcessorName;
    processorPaymentReference: string;
    providerEventId: string;
    earlyFraudWarningId: string;
    providerChargeReference: string | null;
    processorStatus: string;
    fraudType: string | null;
    chargeDisputed: boolean;
    receivedAt: string;
  }>
>;

export type PaymentFraudReviewOpenedEvent = DomainEvent<
  "payments.payment-fraud-review-opened",
  Readonly<{
    paymentId: PaymentId;
    orderIds: OrderId[];
    buyerAccountId: AccountId;
    sellerPayouts: SellerPayoutComponent[];
    processorName: PaymentProcessorName;
    processorPaymentReference: string;
    providerEventId: string;
    providerReviewId: string;
    providerChargeReference: string | null;
    processorStatus: string;
    reason: string | null;
    openedAt: string;
  }>
>;

export type PaymentFraudReviewClosedEvent = DomainEvent<
  "payments.payment-fraud-review-closed",
  Readonly<{
    paymentId: PaymentId;
    orderIds: OrderId[];
    buyerAccountId: AccountId;
    sellerPayouts: SellerPayoutComponent[];
    processorName: PaymentProcessorName;
    processorPaymentReference: string;
    providerEventId: string;
    providerReviewId: string;
    providerChargeReference: string | null;
    processorStatus: string;
    reason: string | null;
    outcome: string | null;
    closedAt: string;
  }>
>;

export type PaymentLiabilityShiftRecordedEvent = DomainEvent<
  "payments.payment-liability-shift-recorded",
  Readonly<{
    paymentId: PaymentId;
    orderIds: OrderId[];
    buyerAccountId: AccountId;
    processorName: PaymentProcessorName;
    processorPaymentReference: string;
    providerEventId: string;
    threeDSecureRequested: ThreeDSecureRequest | null;
    status: PaymentLiabilityShiftStatus;
    authenticationResult: string | null;
    radarRiskLevel: string | null;
    recordedAt: string;
  }>
>;

export type PaymentEvent =
  | PaymentCreatedEvent
  | PaymentAuthorizedEvent
  | PaymentCapturedEvent
  | PaymentFailedEvent
  | PaymentCancelledEvent
  | PaymentRefundRequestedEvent
  | PaymentRefundedEvent
  | PaymentDisputedEvent
  | PaymentDisputeEvidenceSubmittedEvent
  | PaymentDisputeEvidenceUnavailableEvent
  | PaymentEarlyFraudWarningReceivedEvent
  | PaymentFraudReviewOpenedEvent
  | PaymentFraudReviewClosedEvent
  | PaymentLiabilityShiftRecordedEvent;

function normalizeSellerPayoutComponents(components: readonly SellerPayoutComponent[]): SellerPayoutComponent[] {
  return components.map((component) => ({
    orderId: normalizeRequiredText(component.orderId, "Seller payout component must include an order.") as OrderId,
    sellerAccountId: normalizeRequiredText(
      component.sellerAccountId,
      "Seller payout component must include a seller account.",
    ) as AccountId,
    marketplaceSalesFeeAmount: normalizeMoneyAmount(component.marketplaceSalesFeeAmount ?? "0.00", {
      fieldName: "Marketplace sales fee amount",
      allowZero: true,
    }),
    marketplaceSalesFeeLines: [...(component.marketplaceSalesFeeLines ?? [])],
    sellerItemNetAmount: normalizeMoneyAmount(component.sellerItemNetAmount, {
      fieldName: "Seller item net amount",
      allowZero: true,
    }),
    shippingAllowanceAmount: normalizeMoneyAmount(component.shippingAllowanceAmount, {
      fieldName: "Shipping allowance amount",
      allowZero: true,
    }),
    sellerShippingPayoutAmount: normalizeMoneyAmount(
      component.sellerShippingPayoutAmount ?? component.shippingAllowanceAmount,
      {
        fieldName: "Seller shipping payout amount",
        allowZero: true,
      },
    ),
    protectionAmount: normalizeMoneyAmount(component.protectionAmount ?? "0.00", {
      fieldName: "Order protection amount",
      allowZero: true,
    }),
    protectionAllowanceAmount: normalizeMoneyAmount(component.protectionAllowanceAmount ?? "0.00", {
      fieldName: "Allowance-funded Order Protection amount",
      allowZero: true,
    }),
    protectionOverageAmount: normalizeMoneyAmount(component.protectionOverageAmount ?? "0.00", {
      fieldName: "Overage-funded Order Protection amount",
      allowZero: true,
    }),
    sellerPayoutAmount: normalizeMoneyAmount(component.sellerPayoutAmount, {
      fieldName: "Seller payout amount",
      allowZero: true,
    }),
  }));
}

function normalizePaymentDisputeEvidenceSummary(summary: PaymentDisputeEvidenceSummary): PaymentDisputeEvidenceSummary {
  const orderIds = normalizeOrderIds(summary.orderIds);
  return {
    trackingNumbers: [
      ...new Set(
        summary.trackingNumbers
          .map((value) => normalizeOptionalText(value))
          .filter((value): value is string => Boolean(value)),
      ),
    ],
    carriers: [
      ...new Set(
        summary.carriers
          .map((value) => normalizeOptionalText(value))
          .filter((value): value is string => Boolean(value)),
      ),
    ],
    deliveredAt: summary.deliveredAt
      ? ensureIsoTimestamp(summary.deliveredAt, "Dispute evidence delivery proof must be an ISO timestamp.")
      : null,
    orderIds,
    hasDeliveryProof: Boolean(summary.hasDeliveryProof),
  };
}

function arraysEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function moneyToCents(value: string) {
  return Math.round(Number.parseFloat(value) * 100);
}

function centsToMoney(cents: number) {
  return (cents / 100).toFixed(2);
}

function addMoney(left: string, right: string) {
  return centsToMoney(moneyToCents(left) + moneyToCents(right));
}

function sumMoney(entries: readonly string[]) {
  return centsToMoney(entries.reduce((sum, value) => sum + moneyToCents(value), 0));
}

function normalizeOrderMoneyAmounts(entries: readonly OrderMoneyAmount[], fieldName: string): OrderMoneyAmount[] {
  const amounts = new Map<string, number>();
  for (const entry of entries) {
    const orderId = normalizeRequiredText(entry.orderId, `${fieldName} must include an order.`) as OrderId;
    const amount = normalizeMoneyAmount(entry.amount, {
      fieldName,
      allowZero: true,
    });
    amounts.set(orderId, (amounts.get(orderId) ?? 0) + moneyToCents(amount));
  }
  return [...amounts.entries()].map(([orderId, amount]) => ({
    orderId: orderId as OrderId,
    amount: centsToMoney(amount),
  }));
}

function moneyForOrder(entries: readonly OrderMoneyAmount[], orderId: OrderId) {
  return entries.find((entry) => entry.orderId === orderId)?.amount ?? "0.00";
}

function refundableCapsForState(state: PaymentState): OrderMoneyAmount[] {
  if (state.orderRefundCaps.length > 0) {
    return [...state.orderRefundCaps];
  }
  if (!state.amount) {
    return [];
  }
  return state.orderIds.map((orderId) => ({
    orderId,
    amount: state.orderIds.length === 1 ? state.amount! : state.amount!,
  }));
}

function requestedAmountForOrder(state: PaymentState, orderId: OrderId, excludingRefundId?: RefundId | null) {
  return sumMoney(
    state.refundRequests
      .filter((request) => request.refundId !== excludingRefundId && request.orderIds.includes(orderId))
      .map((request) => request.amount),
  );
}

function remainingRefundableAmountForOrder(state: PaymentState, orderId: OrderId, excludingRefundId?: RefundId | null) {
  const cap = moneyForOrder(refundableCapsForState(state), orderId);
  const refunded = moneyForOrder(state.refundedOrderAmounts, orderId);
  const requested = requestedAmountForOrder(state, orderId, excludingRefundId);
  return centsToMoney(Math.max(0, moneyToCents(cap) - moneyToCents(refunded) - moneyToCents(requested)));
}

function assertRefundOrdersBelongToPayment(state: PaymentState, orderIds: readonly OrderId[]) {
  for (const orderId of orderIds) {
    assert(state.orderIds.includes(orderId), "Refund order must belong to the payment.");
  }
}

function allocateRefundAmountToOrders(
  state: PaymentState,
  orderIds: readonly OrderId[],
  amount: string,
): OrderMoneyAmount[] {
  let remainingCents = moneyToCents(amount);
  const allocations: OrderMoneyAmount[] = [];
  for (const orderId of orderIds) {
    if (remainingCents <= 0) {
      break;
    }
    const cap = moneyForOrder(refundableCapsForState(state), orderId);
    const refunded = moneyForOrder(state.refundedOrderAmounts, orderId);
    const availableCents = Math.max(0, moneyToCents(cap) - moneyToCents(refunded));
    const allocationCents = Math.min(remainingCents, availableCents);
    if (allocationCents > 0) {
      allocations.push({ orderId, amount: centsToMoney(allocationCents) });
      remainingCents -= allocationCents;
    }
  }
  assert(remainingCents === 0, "Refund amount cannot exceed the remaining refundable order amount.");
  return allocations;
}

function mergeRefundedOrderAmounts(
  current: readonly OrderMoneyAmount[],
  additions: readonly OrderMoneyAmount[],
): OrderMoneyAmount[] {
  const totals = new Map(current.map((entry) => [entry.orderId, moneyToCents(entry.amount)]));
  for (const addition of additions) {
    totals.set(addition.orderId, (totals.get(addition.orderId) ?? 0) + moneyToCents(addition.amount));
  }
  return [...totals.entries()].map(([orderId, amount]) => ({ orderId, amount: centsToMoney(amount) }));
}

function filterSellerPayoutsForOrders(
  sellerPayouts: readonly SellerPayoutComponent[],
  orderIds: readonly OrderId[],
): SellerPayoutComponent[] {
  const orderSet = new Set(orderIds);
  return sellerPayouts.filter((payout) => orderSet.has(payout.orderId));
}

function findIssuedRefund(state: PaymentState, refundId: RefundId | null, processorRefundReference: string | null) {
  return state.issuedRefunds.find(
    (refund) =>
      (refundId !== null && refund.refundId === refundId) ||
      (processorRefundReference !== null && refund.processorRefundReference === processorRefundReference),
  );
}

export const decidePayment: AggregateDecider<PaymentState, PaymentCommand, PaymentEvent> = (state, command) => {
  switch (command.type) {
    case "CreatePayment":
      assert(state.paymentId === null, "Payment has already been created.");
      const sellerPayouts = normalizeSellerPayoutComponents(command.sellerPayouts ?? []);
      const orderRefundCaps = normalizeOrderMoneyAmounts(
        command.orderRefundCaps ?? command.orderIds.map((orderId) => ({ orderId, amount: command.amount })),
        "Order refundable amount",
      );
      const sellerPayoutAmount = normalizeMoneyAmount(
        command.sellerPayoutAmount ??
          sellerPayouts.reduce((sum, component) => sum + Number.parseFloat(component.sellerPayoutAmount), 0).toFixed(2),
        {
          fieldName: "Seller payout amount",
          allowZero: true,
        },
      );
      return [
        {
          type: "payments.payment-created",
          data: {
            paymentId: command.paymentId,
            buyerAccountId: command.buyerAccountId,
            orderIds: normalizeOrderIds(command.orderIds),
            amount: normalizeMoneyAmount(command.amount, {
              fieldName: "Payment amount",
            }),
            balanceCreditAmount: normalizeMoneyAmount(command.balanceCreditAmount ?? "0.00", {
              fieldName: "Balance credit amount",
              allowZero: true,
            }),
            processorAmount: normalizeMoneyAmount(command.processorAmount ?? command.amount, {
              fieldName: "External payment amount",
              allowZero: true,
            }),
            marketplaceSalesFeeAmount: normalizeMoneyAmount(command.marketplaceSalesFeeAmount, {
              fieldName: "Marketplace sales fee amount",
              allowZero: true,
            }),
            authenticityFeeAmount: normalizeMoneyAmount(command.authenticityFeeAmount ?? "0.00", {
              fieldName: "Authenticity check fee amount",
              allowZero: true,
            }),
            marketplaceCheckoutFeeAmount: normalizeMoneyAmount(command.marketplaceCheckoutFeeAmount, {
              fieldName: "Marketplace checkout fee amount",
              allowZero: true,
            }),
            marketplaceCheckoutFeePolicyVersion: normalizeOptionalText(command.marketplaceCheckoutFeePolicyVersion),
            marketplaceCheckoutFeeQuoteFingerprint: normalizeOptionalText(
              command.marketplaceCheckoutFeeQuoteFingerprint,
            ),
            paymentMethodCategory: normalizeOptionalText(command.paymentMethodCategory),
            savedCheckoutInstrumentId: normalizeOptionalText(command.savedCheckoutInstrumentId),
            sellerNetAmount: normalizeMoneyAmount(command.sellerNetAmount, {
              fieldName: "Seller net amount",
              allowZero: true,
            }),
            sellerPayoutAmount,
            sellerPayouts,
            orderRefundCaps,
            currencyCode: normalizeCurrencyCode(command.currencyCode),
            processorName: normalizeProcessorName(command.processorName),
            processorPaymentKind: command.processorPaymentKind,
            processorPaymentReference: normalizeRequiredText(
              command.processorPaymentReference,
              "Processor payment reference is required.",
            ),
            processorClientSecret: normalizeOptionalText(command.processorClientSecret),
            processorRedirectUrl: normalizeOptionalText(command.processorRedirectUrl),
            processorStatus: normalizeRequiredText(command.processorStatus, "Processor status is required."),
            sourceContext: normalizeOptionalText(command.sourceContext),
            sourceReferenceId: normalizeOptionalText(command.sourceReferenceId),
            threeDSecureRequest: command.threeDSecureRequest ?? null,
            threeDSecureReasonCodes: [...(command.threeDSecureReasonCodes ?? [])]
              .map((reason) => normalizeOptionalText(reason))
              .filter((reason): reason is string => Boolean(reason)),
            createdAt: ensureIsoTimestamp(command.createdAt, "Payment creation must include a timestamp."),
          },
        },
      ];
    case "RecordPaymentAuthorization":
      assert(state.paymentId !== null, "Payment must be created first.");
      if (state.capturedAt !== null || state.status === "cancelled") {
        return [];
      }
      if (state.authorizedAt) {
        return [];
      }
      const authorizationProcessorStatus = normalizeRequiredText(
        command.processorStatus,
        "Processor status is required.",
      );
      return [
        {
          type: "payments.payment-authorized",
          data: {
            paymentId: state.paymentId,
            processorStatus: authorizationProcessorStatus,
            authorizedAt: ensureIsoTimestamp(command.authorizedAt, "Payment authorization must include a timestamp."),
          },
        },
      ];
    case "RecordPaymentCapture":
      assert(state.paymentId !== null, "Payment must be created first.");
      if (state.status === "captured") {
        return [];
      }
      assert(state.status !== "cancelled", "Cancelled payments cannot be captured.");
      assert(state.status !== "failed", "Failed payments cannot be captured.");
      assert(state.status !== "partially-refunded", "Refunded payments cannot be captured.");
      assert(state.status !== "refunded", "Refunded payments cannot be captured.");
      assert(state.status !== "disputed", "Disputed payments cannot be captured.");
      return [
        {
          type: "payments.payment-captured",
          data: {
            paymentId: state.paymentId,
            orderIds: [...state.orderIds],
            buyerAccountId: state.buyerAccountId!,
            amount: state.amount!,
            balanceCreditAmount: state.balanceCreditAmount,
            processorAmount: state.processorAmount!,
            marketplaceSalesFeeAmount: state.marketplaceSalesFeeAmount!,
            authenticityFeeAmount: state.authenticityFeeAmount ?? "0.00",
            marketplaceCheckoutFeeAmount: state.marketplaceCheckoutFeeAmount!,
            marketplaceCheckoutFeePolicyVersion: state.marketplaceCheckoutFeePolicyVersion,
            marketplaceCheckoutFeeQuoteFingerprint: state.marketplaceCheckoutFeeQuoteFingerprint,
            paymentMethodCategory: state.paymentMethodCategory,
            sellerNetAmount: state.sellerNetAmount!,
            sellerPayoutAmount: state.sellerPayoutAmount!,
            sellerPayouts: [...state.sellerPayouts],
            currencyCode: state.currencyCode!,
            processorName: state.processorName!,
            processorPaymentReference: state.processorPaymentReference!,
            processorStatus: normalizeRequiredText(command.processorStatus, "Processor status is required."),
            capturedAt: ensureIsoTimestamp(command.capturedAt, "Payment capture must include a timestamp."),
          },
        },
      ];
    case "RecordPaymentFailure":
      assert(state.paymentId !== null, "Payment must be created first.");
      if (state.status === "failed") {
        return [];
      }
      assert(state.status !== "captured", "Captured payments cannot fail.");
      assert(state.status !== "cancelled", "Cancelled payments cannot fail.");
      return [
        {
          type: "payments.payment-failed",
          data: {
            paymentId: state.paymentId,
            orderIds: [...state.orderIds],
            buyerAccountId: state.buyerAccountId!,
            amount: state.amount!,
            balanceCreditAmount: state.balanceCreditAmount,
            processorAmount: state.processorAmount!,
            marketplaceSalesFeeAmount: state.marketplaceSalesFeeAmount!,
            marketplaceCheckoutFeeAmount: state.marketplaceCheckoutFeeAmount!,
            marketplaceCheckoutFeePolicyVersion: state.marketplaceCheckoutFeePolicyVersion,
            marketplaceCheckoutFeeQuoteFingerprint: state.marketplaceCheckoutFeeQuoteFingerprint,
            paymentMethodCategory: state.paymentMethodCategory,
            sellerNetAmount: state.sellerNetAmount!,
            sellerPayoutAmount: state.sellerPayoutAmount!,
            sellerPayouts: [...state.sellerPayouts],
            currencyCode: state.currencyCode!,
            processorName: state.processorName!,
            processorPaymentReference: state.processorPaymentReference!,
            processorStatus: normalizeRequiredText(command.processorStatus, "Processor status is required."),
            failureCode: normalizeOptionalText(command.failureCode),
            failureMessage: normalizeOptionalText(command.failureMessage),
            failedAt: ensureIsoTimestamp(command.failedAt, "Payment failure must include a timestamp."),
          },
        },
      ];
    case "CancelPayment":
      assert(state.paymentId !== null, "Payment must be created first.");
      if (state.status === "cancelled") {
        return [];
      }
      assert(state.capturedAt === null, "Captured payments cannot be cancelled.");
      return [
        {
          type: "payments.payment-cancelled",
          data: {
            paymentId: state.paymentId,
            cancelledAt: ensureIsoTimestamp(command.cancelledAt, "Payment cancellation must include a timestamp."),
          },
        },
      ];
    case "RequestPaymentRefund": {
      assert(state.paymentId !== null, "Payment must be created first.");
      assert(
        state.status === "captured" || state.status === "partially-refunded",
        "Only captured payments can be refunded.",
      );
      const orderIds = normalizeOrderIds(command.orderIds);
      assertRefundOrdersBelongToPayment(state, orderIds);
      const amount = normalizeMoneyAmount(command.amount, {
        fieldName: "Refund amount",
      });
      const existingRequest = state.refundRequests.find((request) => request.refundId === command.refundId);
      if (existingRequest) {
        assert(
          arraysEqual(existingRequest.orderIds, orderIds) && existingRequest.amount === amount,
          "Refund request does not match the existing payment refund request.",
        );
        return [];
      }
      const remainingPaymentAmount = subtractMoney(
        subtractMoney(state.amount!, state.refundedAmount),
        sumMoney(state.refundRequests.map((request) => request.amount)),
      );
      assert(
        compareMoney(amount, remainingPaymentAmount) <= 0,
        "Refund amount cannot exceed the remaining refundable payment amount.",
      );
      const orderRemainingAmount = sumMoney(
        orderIds.map((orderId) => remainingRefundableAmountForOrder(state, orderId, command.refundId)),
      );
      assert(
        compareMoney(amount, orderRemainingAmount) <= 0,
        "Refund amount cannot exceed the remaining refundable order amount.",
      );
      return [
        {
          type: "payments.payment-refund-requested",
          data: {
            paymentId: state.paymentId,
            refundId: command.refundId,
            orderIds,
            amount,
            requestedAt: ensureIsoTimestamp(command.requestedAt, "Payment refund request must include a timestamp."),
          },
        },
      ];
    }
    case "RecordPaymentRefund": {
      assert(state.paymentId !== null, "Payment must be created first.");
      assert(
        state.status === "captured" ||
          state.status === "partially-refunded" ||
          state.status === "refunded" ||
          state.status === "disputed",
        "Only captured payments can be refunded.",
      );
      assert(command.amount !== null, "Refund webhook must include the refunded amount.");
      const refundId = command.refundId ?? null;
      const processorRefundReference = normalizeOptionalText(command.processorRefundReference);
      const refundAmount = normalizeMoneyAmount(command.amount, {
        fieldName: "Refund amount",
      });
      const orderIds = normalizeOrderIds(command.orderIds ?? []);
      assert(orderIds.length > 0, "Refund webhook must include refunded orders.");
      assertRefundOrdersBelongToPayment(state, orderIds);

      const existingIssuedRefund = findIssuedRefund(state, refundId, processorRefundReference);
      if (existingIssuedRefund) {
        assert(
          arraysEqual(existingIssuedRefund.orderIds, orderIds) && existingIssuedRefund.amount === refundAmount,
          "Refund provider update does not match the existing issued refund.",
        );
        return [];
      }

      const cumulativeRefundedAmount = command.refundedAmount
        ? normalizeMoneyAmount(command.refundedAmount, {
            fieldName: "Cumulative refunded amount",
          })
        : addMoney(state.refundedAmount, refundAmount);
      assert(
        compareMoney(cumulativeRefundedAmount, state.amount!) <= 0,
        "Refunded amount cannot exceed the captured payment amount.",
      );
      assert(
        compareMoney(cumulativeRefundedAmount, state.refundedAmount) >= 0,
        "Refunded amount cannot move backwards.",
      );
      if (compareMoney(cumulativeRefundedAmount, state.refundedAmount) === 0) {
        return [];
      }
      if (command.refundedAmount) {
        assert(
          compareMoney(subtractMoney(cumulativeRefundedAmount, state.refundedAmount), refundAmount) === 0,
          "Cumulative refunded amount must match the refund delta.",
        );
      }
      const orderRefundAmounts = allocateRefundAmountToOrders(state, orderIds, refundAmount);
      const refundedOrderAmounts = mergeRefundedOrderAmounts(state.refundedOrderAmounts, orderRefundAmounts);
      return [
        {
          type: "payments.payment-refunded",
          data: {
            paymentId: state.paymentId,
            refundId,
            orderIds,
            buyerAccountId: state.buyerAccountId!,
            amount: refundAmount,
            refundedAmount: cumulativeRefundedAmount,
            orderRefundAmounts,
            refundedOrderAmounts,
            orderRefundCaps: [...state.orderRefundCaps],
            currencyCode: state.currencyCode!,
            processorName: state.processorName!,
            processorPaymentReference: state.processorPaymentReference!,
            sellerPayouts: filterSellerPayoutsForOrders(state.sellerPayouts, orderIds),
            processorRefundReference,
            processorStatus: normalizeRequiredText(command.processorStatus, "Processor status is required."),
            refundedAt: ensureIsoTimestamp(command.refundedAt, "Payment refund must include a timestamp."),
          },
        },
      ];
    }
    case "RecordPaymentDispute": {
      assert(state.paymentId !== null, "Payment must be created first.");
      const processorStatus = normalizeRequiredText(command.processorStatus, "Processor status is required.");
      const providerEventId = normalizeOptionalText(command.providerEventId);
      const disputeStatus = normalizeOptionalText(command.disputeStatus);
      const disputeMessage = normalizeOptionalText(command.disputeMessage);
      const disputeLifecycleState: PaymentDisputeLifecycleState =
        command.disputeLifecycleState ??
        (disputeMessage === "won" || disputeMessage === "warning_closed"
          ? "won"
          : disputeMessage === "lost"
            ? "lost"
            : "created");
      const disputeEvidenceDueAt = normalizeOptionalText(command.disputeEvidenceDueAt);
      if (providerEventId && state.disputeProviderEventIds.includes(providerEventId)) {
        return [];
      }
      assert(
        state.status === "captured" ||
          state.status === "partially-refunded" ||
          state.status === "refunded" ||
          state.status === "disputed",
        "Only captured payments can be disputed.",
      );
      return [
        {
          type: "payments.payment-disputed",
          data: {
            paymentId: state.paymentId,
            orderIds: [...state.orderIds],
            buyerAccountId: state.buyerAccountId!,
            amount: command.amount
              ? normalizeMoneyAmount(command.amount, {
                  fieldName: "Dispute amount",
                })
              : state.amount!,
            currencyCode: state.currencyCode!,
            processorName: state.processorName!,
            processorPaymentReference: state.processorPaymentReference!,
            providerEventId,
            providerDisputeId: normalizeOptionalText(command.providerDisputeId) ?? `${state.paymentId}-dispute`,
            providerChargeReference: normalizeOptionalText(command.providerChargeReference),
            processorStatus,
            disputeStatus,
            disputeMessage,
            disputeLifecycleState,
            disputeReason: normalizeOptionalText(command.disputeReason),
            disputeEvidenceDueAt: disputeEvidenceDueAt
              ? ensureIsoTimestamp(disputeEvidenceDueAt, "Payment dispute evidence deadline must be an ISO timestamp.")
              : null,
            sellerPayouts: [...state.sellerPayouts],
            disputedAt: ensureIsoTimestamp(command.disputedAt, "Payment dispute must include a timestamp."),
          },
        },
      ];
    }
    case "RecordPaymentDisputeEvidenceSubmitted": {
      assert(state.paymentId !== null, "Payment must be created first.");
      const providerDisputeId = normalizeRequiredText(
        command.providerDisputeId,
        "Dispute evidence submission must include a dispute id.",
      );
      if (state.disputeEvidenceRecords.some((record) => record.providerDisputeId === providerDisputeId)) {
        return [];
      }
      return [
        {
          type: "payments.payment-dispute-evidence-submitted",
          data: {
            paymentId: state.paymentId,
            orderIds: [...state.orderIds],
            providerDisputeId,
            processorName: state.processorName!,
            processorPaymentReference: state.processorPaymentReference!,
            processorStatus: normalizeRequiredText(command.processorStatus, "Processor status is required."),
            evidenceSummary: normalizePaymentDisputeEvidenceSummary(command.evidenceSummary),
            submittedAt: ensureIsoTimestamp(
              command.submittedAt,
              "Dispute evidence submission must include a timestamp.",
            ),
          },
        },
      ];
    }
    case "RecordPaymentDisputeEvidenceUnavailable": {
      assert(state.paymentId !== null, "Payment must be created first.");
      const providerDisputeId = normalizeRequiredText(
        command.providerDisputeId,
        "Dispute evidence unavailability must include a dispute id.",
      );
      if (state.disputeEvidenceRecords.some((record) => record.providerDisputeId === providerDisputeId)) {
        return [];
      }
      return [
        {
          type: "payments.payment-dispute-evidence-unavailable",
          data: {
            paymentId: state.paymentId,
            orderIds: [...state.orderIds],
            providerDisputeId,
            reason: normalizeRequiredText(command.reason, "Dispute evidence unavailability requires a reason."),
            evidenceSummary: normalizePaymentDisputeEvidenceSummary(command.evidenceSummary),
            recordedAt: ensureIsoTimestamp(
              command.recordedAt,
              "Dispute evidence unavailability must include a timestamp.",
            ),
          },
        },
      ];
    }
    case "RecordPaymentEarlyFraudWarning": {
      assert(state.paymentId !== null, "Payment must be created first.");
      const earlyFraudWarningId = normalizeRequiredText(
        command.earlyFraudWarningId,
        "Early fraud warning id is required.",
      );
      if (state.earlyFraudWarningIds.includes(earlyFraudWarningId)) {
        return [];
      }
      return [
        {
          type: "payments.payment-fraud-warning-received",
          data: {
            paymentId: state.paymentId,
            orderIds: [...state.orderIds],
            buyerAccountId: state.buyerAccountId!,
            sellerPayouts: [...state.sellerPayouts],
            processorName: state.processorName!,
            processorPaymentReference: state.processorPaymentReference!,
            providerEventId: normalizeRequiredText(command.providerEventId, "Provider event id is required."),
            earlyFraudWarningId,
            providerChargeReference: normalizeOptionalText(command.providerChargeReference),
            processorStatus: normalizeRequiredText(command.processorStatus, "Processor status is required."),
            fraudType: normalizeOptionalText(command.fraudType),
            chargeDisputed: command.chargeDisputed,
            receivedAt: ensureIsoTimestamp(command.receivedAt, "Fraud warning receipt must include a timestamp."),
          },
        },
      ];
    }
    case "RecordPaymentFraudReviewOpened": {
      assert(state.paymentId !== null, "Payment must be created first.");
      const providerReviewId = normalizeRequiredText(command.providerReviewId, "Fraud review id is required.");
      const existingReview = state.fraudReviews.find((review) => review.providerReviewId === providerReviewId);
      if (existingReview?.status === "opened") {
        return [];
      }
      return [
        {
          type: "payments.payment-fraud-review-opened",
          data: {
            paymentId: state.paymentId,
            orderIds: [...state.orderIds],
            buyerAccountId: state.buyerAccountId!,
            sellerPayouts: [...state.sellerPayouts],
            processorName: state.processorName!,
            processorPaymentReference: state.processorPaymentReference!,
            providerEventId: normalizeRequiredText(command.providerEventId, "Provider event id is required."),
            providerReviewId,
            providerChargeReference: normalizeOptionalText(command.providerChargeReference),
            processorStatus: normalizeRequiredText(command.processorStatus, "Processor status is required."),
            reason: normalizeOptionalText(command.reason),
            openedAt: ensureIsoTimestamp(command.openedAt, "Fraud review opening must include a timestamp."),
          },
        },
      ];
    }
    case "RecordPaymentFraudReviewClosed": {
      assert(state.paymentId !== null, "Payment must be created first.");
      const providerReviewId = normalizeRequiredText(command.providerReviewId, "Fraud review id is required.");
      const existingReview = state.fraudReviews.find((review) => review.providerReviewId === providerReviewId);
      const outcome = normalizeOptionalText(command.outcome);
      if (existingReview?.status === "closed" && existingReview.outcome === outcome) {
        return [];
      }
      return [
        {
          type: "payments.payment-fraud-review-closed",
          data: {
            paymentId: state.paymentId,
            orderIds: [...state.orderIds],
            buyerAccountId: state.buyerAccountId!,
            sellerPayouts: [...state.sellerPayouts],
            processorName: state.processorName!,
            processorPaymentReference: state.processorPaymentReference!,
            providerEventId: normalizeRequiredText(command.providerEventId, "Provider event id is required."),
            providerReviewId,
            providerChargeReference: normalizeOptionalText(command.providerChargeReference),
            processorStatus: normalizeRequiredText(command.processorStatus, "Processor status is required."),
            reason: normalizeOptionalText(command.reason),
            outcome,
            closedAt: ensureIsoTimestamp(command.closedAt, "Fraud review closing must include a timestamp."),
          },
        },
      ];
    }
    case "RecordPaymentLiabilityShiftOutcome": {
      assert(state.paymentId !== null, "Payment must be created first.");
      const providerEventId = normalizeRequiredText(command.providerEventId, "Provider event id is required.");
      const existing = state.liabilityShiftOutcomes.find((outcome) => outcome.providerEventId === providerEventId);
      const status = normalizeRequiredText(command.status, "Liability shift status is required.");
      const authenticationResult = normalizeOptionalText(command.authenticationResult);
      const radarRiskLevel = normalizeOptionalText(command.radarRiskLevel);
      const threeDSecureRequested = command.threeDSecureRequested ?? null;
      if (
        existing &&
        existing.status === status &&
        existing.authenticationResult === authenticationResult &&
        existing.radarRiskLevel === radarRiskLevel &&
        existing.threeDSecureRequested === threeDSecureRequested
      ) {
        return [];
      }
      return [
        {
          type: "payments.payment-liability-shift-recorded",
          data: {
            paymentId: state.paymentId,
            orderIds: [...state.orderIds],
            buyerAccountId: state.buyerAccountId!,
            processorName: state.processorName!,
            processorPaymentReference: state.processorPaymentReference!,
            providerEventId,
            threeDSecureRequested,
            status: status as PaymentLiabilityShiftStatus,
            authenticationResult,
            radarRiskLevel,
            recordedAt: ensureIsoTimestamp(command.recordedAt, "Liability shift outcome must include a timestamp."),
          },
        },
      ];
    }
    default:
      return assertNever(command);
  }
};

export const evolvePayment: AggregateEvolver<PaymentState, PaymentEvent> = (state, event) => {
  switch (event.type) {
    case "payments.payment-created":
      return {
        paymentId: event.data.paymentId,
        buyerAccountId: event.data.buyerAccountId,
        orderIds: [...event.data.orderIds],
        orderRefundCaps: normalizeOrderMoneyAmounts(event.data.orderRefundCaps ?? [], "Order refundable amount"),
        amount: event.data.amount,
        balanceCreditAmount: event.data.balanceCreditAmount,
        processorAmount: event.data.processorAmount,
        marketplaceSalesFeeAmount: event.data.marketplaceSalesFeeAmount,
        authenticityFeeAmount: event.data.authenticityFeeAmount ?? "0.00",
        marketplaceCheckoutFeeAmount: event.data.marketplaceCheckoutFeeAmount,
        marketplaceCheckoutFeePolicyVersion: event.data.marketplaceCheckoutFeePolicyVersion ?? null,
        marketplaceCheckoutFeeQuoteFingerprint: event.data.marketplaceCheckoutFeeQuoteFingerprint ?? null,
        paymentMethodCategory: event.data.paymentMethodCategory ?? null,
        savedCheckoutInstrumentId: event.data.savedCheckoutInstrumentId ?? null,
        sellerNetAmount: event.data.sellerNetAmount,
        sellerPayoutAmount: event.data.sellerPayoutAmount ?? event.data.sellerNetAmount,
        sellerPayouts: [...(event.data.sellerPayouts ?? [])],
        currencyCode: event.data.currencyCode,
        processorName: event.data.processorName,
        processorPaymentKind: event.data.processorPaymentKind,
        processorPaymentReference: event.data.processorPaymentReference,
        processorClientSecret: event.data.processorClientSecret,
        processorRedirectUrl: event.data.processorRedirectUrl,
        processorStatus: event.data.processorStatus,
        sourceContext: event.data.sourceContext,
        sourceReferenceId: event.data.sourceReferenceId,
        threeDSecureRequest: event.data.threeDSecureRequest ?? null,
        threeDSecureReasonCodes: [...(event.data.threeDSecureReasonCodes ?? [])],
        status: "pending-confirmation",
        failureCode: null,
        failureMessage: null,
        createdAt: event.data.createdAt,
        authorizedAt: null,
        capturedAt: null,
        failedAt: null,
        cancelledAt: null,
        refundedAt: null,
        refundedAmount: "0.00",
        refundedOrderAmounts: [],
        refundRequests: [],
        issuedRefunds: [],
        disputedAt: null,
        disputeProviderEventIds: [],
        disputeEvidenceRecords: [],
        earlyFraudWarningIds: [],
        fraudReviews: [],
        liabilityShiftOutcomes: [],
      };
    case "payments.payment-authorized":
      return {
        ...state,
        processorStatus: event.data.processorStatus,
        authorizedAt: event.data.authorizedAt,
      };
    case "payments.payment-captured":
      return {
        ...state,
        processorStatus: event.data.processorStatus,
        status: "captured",
        failureCode: null,
        failureMessage: null,
        capturedAt: event.data.capturedAt,
        failedAt: null,
      };
    case "payments.payment-failed":
      return {
        ...state,
        processorStatus: event.data.processorStatus,
        status: "failed",
        failureCode: event.data.failureCode,
        failureMessage: event.data.failureMessage,
        failedAt: event.data.failedAt,
      };
    case "payments.payment-cancelled":
      return {
        ...state,
        status: "cancelled",
        cancelledAt: event.data.cancelledAt,
      };
    case "payments.payment-refund-requested":
      if (state.refundRequests.some((request) => request.refundId === event.data.refundId)) {
        return state;
      }
      return {
        ...state,
        refundRequests: [
          ...state.refundRequests,
          {
            refundId: event.data.refundId,
            orderIds: [...event.data.orderIds],
            amount: event.data.amount,
          },
        ],
      };
    case "payments.payment-refunded":
      return {
        ...state,
        processorStatus: event.data.processorStatus,
        status: event.data.refundedAmount === state.amount ? "refunded" : "partially-refunded",
        failureCode: null,
        failureMessage: null,
        refundedAt: event.data.refundedAt,
        refundedAmount: event.data.refundedAmount,
        refundedOrderAmounts: normalizeOrderMoneyAmounts(
          event.data.refundedOrderAmounts ??
            mergeRefundedOrderAmounts(state.refundedOrderAmounts, event.data.orderRefundAmounts ?? []),
          "Order refunded amount",
        ),
        refundRequests: state.refundRequests.filter((request) => request.refundId !== event.data.refundId),
        issuedRefunds: [
          ...state.issuedRefunds,
          {
            refundId: event.data.refundId ?? null,
            processorRefundReference: event.data.processorRefundReference ?? null,
            orderIds: [...event.data.orderIds],
            amount: event.data.amount,
          },
        ],
      };
    case "payments.payment-disputed":
      return {
        ...state,
        processorStatus: event.data.processorStatus,
        status: "disputed",
        failureCode: event.data.disputeStatus,
        failureMessage: event.data.disputeMessage,
        disputedAt: event.data.disputedAt,
        disputeProviderEventIds:
          event.data.providerEventId && !state.disputeProviderEventIds.includes(event.data.providerEventId)
            ? [...state.disputeProviderEventIds, event.data.providerEventId]
            : state.disputeProviderEventIds,
      };
    case "payments.payment-dispute-evidence-submitted":
      return {
        ...state,
        disputeEvidenceRecords: [
          ...state.disputeEvidenceRecords.filter((record) => record.providerDisputeId !== event.data.providerDisputeId),
          {
            providerDisputeId: event.data.providerDisputeId,
            status: "submitted",
            reason: null,
            submittedAt: event.data.submittedAt,
            recordedAt: event.data.submittedAt,
          },
        ],
      };
    case "payments.payment-dispute-evidence-unavailable":
      return {
        ...state,
        disputeEvidenceRecords: [
          ...state.disputeEvidenceRecords.filter((record) => record.providerDisputeId !== event.data.providerDisputeId),
          {
            providerDisputeId: event.data.providerDisputeId,
            status: "unavailable",
            reason: event.data.reason,
            submittedAt: null,
            recordedAt: event.data.recordedAt,
          },
        ],
      };
    case "payments.payment-fraud-warning-received":
      return {
        ...state,
        earlyFraudWarningIds: state.earlyFraudWarningIds.includes(event.data.earlyFraudWarningId)
          ? state.earlyFraudWarningIds
          : [...state.earlyFraudWarningIds, event.data.earlyFraudWarningId],
      };
    case "payments.payment-fraud-review-opened": {
      const withoutReview = state.fraudReviews.filter(
        (review) => review.providerReviewId !== event.data.providerReviewId,
      );
      return {
        ...state,
        fraudReviews: [
          ...withoutReview,
          {
            providerReviewId: event.data.providerReviewId,
            providerChargeReference: event.data.providerChargeReference,
            reason: event.data.reason,
            status: "opened",
            outcome: null,
            openedAt: event.data.openedAt,
            closedAt: null,
          },
        ],
      };
    }
    case "payments.payment-fraud-review-closed": {
      const existingReview = state.fraudReviews.find(
        (review) => review.providerReviewId === event.data.providerReviewId,
      );
      const withoutReview = state.fraudReviews.filter(
        (review) => review.providerReviewId !== event.data.providerReviewId,
      );
      return {
        ...state,
        fraudReviews: [
          ...withoutReview,
          {
            providerReviewId: event.data.providerReviewId,
            providerChargeReference:
              event.data.providerChargeReference ?? existingReview?.providerChargeReference ?? null,
            reason: event.data.reason ?? existingReview?.reason ?? null,
            status: "closed",
            outcome: event.data.outcome,
            openedAt: existingReview?.openedAt ?? null,
            closedAt: event.data.closedAt,
          },
        ],
      };
    }
    case "payments.payment-liability-shift-recorded": {
      const withoutOutcome = state.liabilityShiftOutcomes.filter(
        (outcome) => outcome.providerEventId !== event.data.providerEventId,
      );
      return {
        ...state,
        liabilityShiftOutcomes: [
          ...withoutOutcome,
          {
            providerEventId: event.data.providerEventId,
            threeDSecureRequested: event.data.threeDSecureRequested,
            status: event.data.status,
            authenticationResult: event.data.authenticationResult,
            radarRiskLevel: event.data.radarRiskLevel,
            recordedAt: event.data.recordedAt,
          },
        ],
      };
    }
    default:
      return assertNever(event);
  }
};
