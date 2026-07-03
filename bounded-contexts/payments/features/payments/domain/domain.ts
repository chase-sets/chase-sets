import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";
import type { AccountId, OrderId, PaymentId } from "@chase-sets/primitives/typed-ids";
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
} from "../../../support/runtime-support/common";

export type PaymentState = Readonly<{
  paymentId: PaymentId | null;
  buyerAccountId: AccountId | null;
  orderIds: readonly OrderId[];
  amount: string | null;
  balanceCreditAmount: string;
  processorAmount: string | null;
  marketplaceSalesFeeAmount: string | null;
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
  capturedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
  refundedAt: string | null;
  refundedAmount: string;
  disputedAt: string | null;
}>;

export type SellerPayoutComponent = Readonly<{
  orderId: OrderId;
  sellerAccountId: AccountId;
  sellerItemNetAmount: string;
  shippingAllowanceAmount: string;
  sellerShippingPayoutAmount: string;
  sellerPayoutAmount: string;
}>;

export const initialPaymentState: PaymentState = {
  paymentId: null,
  buyerAccountId: null,
  orderIds: [],
  amount: null,
  balanceCreditAmount: "0.00",
  processorAmount: null,
  marketplaceSalesFeeAmount: null,
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
  capturedAt: null,
  failedAt: null,
  cancelledAt: null,
  refundedAt: null,
  refundedAmount: "0.00",
  disputedAt: null,
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
  marketplaceCheckoutFeeAmount: string;
  marketplaceCheckoutFeePolicyVersion?: string | null;
  marketplaceCheckoutFeeQuoteFingerprint?: string | null;
  paymentMethodCategory?: string | null;
  savedCheckoutInstrumentId?: string | null;
  sellerNetAmount: string;
  sellerPayoutAmount?: string;
  sellerPayouts?: readonly SellerPayoutComponent[];
  currencyCode: CurrencyCode;
  processorName: PaymentProcessorName;
  processorPaymentKind: "checkout-session" | "payment-intent" | "balance-credit";
  processorPaymentReference: string;
  processorClientSecret: string | null;
  processorRedirectUrl?: string | null;
  processorStatus: string;
  sourceContext?: string | null;
  sourceReferenceId?: string | null;
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
  processorStatus: string;
  processorRefundReference: string | null;
  amount: string | null;
  refundedAt: string;
}>;

export type RecordPaymentDisputeCommand = Readonly<{
  type: "RecordPaymentDispute";
  processorStatus: string;
  disputeStatus: string | null;
  disputeMessage: string | null;
  amount: string | null;
  disputedAt: string;
}>;

export type PaymentCommand =
  | CreatePaymentCommand
  | RecordPaymentAuthorizationCommand
  | RecordPaymentCaptureCommand
  | RecordPaymentFailureCommand
  | CancelPaymentCommand
  | RecordPaymentRefundCommand
  | RecordPaymentDisputeCommand;

export type PaymentCreatedEvent = DomainEvent<
  "payments.payment-created",
  Readonly<{
    paymentId: PaymentId;
    buyerAccountId: AccountId;
    orderIds: OrderId[];
    amount: string;
    balanceCreditAmount: string;
    processorAmount: string;
    marketplaceSalesFeeAmount: string;
    marketplaceCheckoutFeeAmount: string;
    marketplaceCheckoutFeePolicyVersion: string | null;
    marketplaceCheckoutFeeQuoteFingerprint: string | null;
    paymentMethodCategory: string | null;
    savedCheckoutInstrumentId: string | null;
    sellerNetAmount: string;
    sellerPayoutAmount: string;
    sellerPayouts: SellerPayoutComponent[];
    currencyCode: CurrencyCode;
    processorName: PaymentProcessorName;
    processorPaymentKind: "checkout-session" | "payment-intent" | "balance-credit";
    processorPaymentReference: string;
    processorClientSecret: string | null;
    processorRedirectUrl: string | null;
    processorStatus: string;
    sourceContext: string | null;
    sourceReferenceId: string | null;
    createdAt: string;
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
  Readonly<{
    paymentId: PaymentId;
    orderIds: OrderId[];
    buyerAccountId: AccountId;
    amount: string;
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
    capturedAt: string;
  }>
>;

export type PaymentFailedEvent = DomainEvent<
  "payments.payment-failed",
  Readonly<{
    paymentId: PaymentId;
    orderIds: OrderId[];
    buyerAccountId: AccountId;
    amount: string;
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
    failedAt: string;
  }>
>;

export type PaymentCancelledEvent = DomainEvent<
  "payments.payment-cancelled",
  Readonly<{
    paymentId: PaymentId;
    cancelledAt: string;
  }>
>;

export type PaymentRefundedEvent = DomainEvent<
  "payments.payment-refunded",
  Readonly<{
    paymentId: PaymentId;
    orderIds: OrderId[];
    buyerAccountId: AccountId;
    amount: string;
    refundedAmount: string;
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
    processorStatus: string;
    disputeStatus: string | null;
    disputeMessage: string | null;
    disputedAt: string;
  }>
>;

export type PaymentEvent =
  | PaymentCreatedEvent
  | PaymentAuthorizedEvent
  | PaymentCapturedEvent
  | PaymentFailedEvent
  | PaymentCancelledEvent
  | PaymentRefundedEvent
  | PaymentDisputedEvent;

function normalizeSellerPayoutComponents(components: readonly SellerPayoutComponent[]): SellerPayoutComponent[] {
  return components.map((component) => ({
    orderId: normalizeRequiredText(component.orderId, "Seller payout component must include an order.") as OrderId,
    sellerAccountId: normalizeRequiredText(
      component.sellerAccountId,
      "Seller payout component must include a seller account.",
    ) as AccountId,
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
    sellerPayoutAmount: normalizeMoneyAmount(component.sellerPayoutAmount, {
      fieldName: "Seller payout amount",
      allowZero: true,
    }),
  }));
}

export const decidePayment: AggregateDecider<PaymentState, PaymentCommand, PaymentEvent> = (state, command) => {
  switch (command.type) {
    case "CreatePayment":
      assert(state.paymentId === null, "Payment has already been created.");
      const sellerPayouts = normalizeSellerPayoutComponents(command.sellerPayouts ?? []);
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
            createdAt: ensureIsoTimestamp(command.createdAt, "Payment creation must include a timestamp."),
          },
        },
      ];
    case "RecordPaymentAuthorization":
      assert(state.paymentId !== null, "Payment must be created first.");
      if (state.status === "captured" || state.status === "cancelled") {
        return [];
      }
      return [
        {
          type: "payments.payment-authorized",
          data: {
            paymentId: state.paymentId,
            processorStatus: normalizeRequiredText(command.processorStatus, "Processor status is required."),
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
      assert(state.status !== "captured", "Captured payments cannot be cancelled.");
      return [
        {
          type: "payments.payment-cancelled",
          data: {
            paymentId: state.paymentId,
            cancelledAt: ensureIsoTimestamp(command.cancelledAt, "Payment cancellation must include a timestamp."),
          },
        },
      ];
    case "RecordPaymentRefund": {
      assert(state.paymentId !== null, "Payment must be created first.");
      if (state.status === "refunded") {
        return [];
      }
      assert(
        state.status === "captured" || state.status === "partially-refunded" || state.status === "disputed",
        "Only captured payments can be refunded.",
      );
      assert(command.amount !== null, "Refund webhook must include the cumulative refunded amount.");
      const cumulativeRefundedAmount = normalizeMoneyAmount(command.amount, {
        fieldName: "Refund amount",
      });
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
      const refundAmount = subtractMoney(cumulativeRefundedAmount, state.refundedAmount);
      return [
        {
          type: "payments.payment-refunded",
          data: {
            paymentId: state.paymentId,
            orderIds: [...state.orderIds],
            buyerAccountId: state.buyerAccountId!,
            amount: refundAmount,
            refundedAmount: cumulativeRefundedAmount,
            currencyCode: state.currencyCode!,
            processorName: state.processorName!,
            processorPaymentReference: state.processorPaymentReference!,
            sellerPayouts: [...state.sellerPayouts],
            processorRefundReference: normalizeOptionalText(command.processorRefundReference),
            processorStatus: normalizeRequiredText(command.processorStatus, "Processor status is required."),
            refundedAt: ensureIsoTimestamp(command.refundedAt, "Payment refund must include a timestamp."),
          },
        },
      ];
    }
    case "RecordPaymentDispute":
      assert(state.paymentId !== null, "Payment must be created first.");
      if (
        state.status === "disputed" &&
        state.processorStatus === normalizeRequiredText(command.processorStatus, "Processor status is required.") &&
        state.failureCode === normalizeOptionalText(command.disputeStatus) &&
        state.failureMessage === normalizeOptionalText(command.disputeMessage)
      ) {
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
            processorStatus: normalizeRequiredText(command.processorStatus, "Processor status is required."),
            disputeStatus: normalizeOptionalText(command.disputeStatus),
            disputeMessage: normalizeOptionalText(command.disputeMessage),
            disputedAt: ensureIsoTimestamp(command.disputedAt, "Payment dispute must include a timestamp."),
          },
        },
      ];
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
        amount: event.data.amount,
        balanceCreditAmount: event.data.balanceCreditAmount,
        processorAmount: event.data.processorAmount,
        marketplaceSalesFeeAmount: event.data.marketplaceSalesFeeAmount,
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
        status: "pending-confirmation",
        failureCode: null,
        failureMessage: null,
        createdAt: event.data.createdAt,
        capturedAt: null,
        failedAt: null,
        cancelledAt: null,
        refundedAt: null,
        refundedAmount: "0.00",
        disputedAt: null,
      };
    case "payments.payment-authorized":
      return {
        ...state,
        processorStatus: event.data.processorStatus,
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
    case "payments.payment-refunded":
      return {
        ...state,
        processorStatus: event.data.processorStatus,
        status: event.data.refundedAmount === state.amount ? "refunded" : "partially-refunded",
        failureCode: null,
        failureMessage: null,
        refundedAt: event.data.refundedAt,
        refundedAmount: event.data.refundedAmount,
      };
    case "payments.payment-disputed":
      return {
        ...state,
        processorStatus: event.data.processorStatus,
        status: "disputed",
        failureCode: event.data.disputeStatus,
        failureMessage: event.data.disputeMessage,
        disputedAt: event.data.disputedAt,
      };
    default:
      return assertNever(event);
  }
};
