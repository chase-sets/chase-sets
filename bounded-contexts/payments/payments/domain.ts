import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type { AccountId, OrderId, PaymentId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  assertNever,
  ensureIsoTimestamp,
  normalizeCurrencyCode,
  normalizeMoneyAmount,
  normalizeOptionalText,
  normalizeOrderIds,
  normalizeProcessorName,
  normalizeRequiredText,
  type CurrencyCode,
  type PaymentProcessorName,
  type PaymentStatus,
} from "../common";

export type PaymentState = Readonly<{
  paymentId: PaymentId | null;
  buyerAccountId: AccountId | null;
  orderIds: readonly OrderId[];
  amount: string | null;
  currencyCode: CurrencyCode | null;
  processorName: PaymentProcessorName | null;
  processorPaymentReference: string | null;
  processorClientSecret: string | null;
  processorStatus: string | null;
  status: PaymentStatus | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: string | null;
  capturedAt: string | null;
  failedAt: string | null;
  cancelledAt: string | null;
}>;

export const initialPaymentState: PaymentState = {
  paymentId: null,
  buyerAccountId: null,
  orderIds: [],
  amount: null,
  currencyCode: null,
  processorName: null,
  processorPaymentReference: null,
  processorClientSecret: null,
  processorStatus: null,
  status: null,
  failureCode: null,
  failureMessage: null,
  createdAt: null,
  capturedAt: null,
  failedAt: null,
  cancelledAt: null,
};

export type CreatePaymentCommand = Readonly<{
  type: "CreatePayment";
  paymentId: PaymentId;
  buyerAccountId: AccountId;
  orderIds: readonly OrderId[];
  amount: string;
  currencyCode: CurrencyCode;
  processorName: PaymentProcessorName;
  processorPaymentReference: string;
  processorClientSecret: string | null;
  processorStatus: string;
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

export type PaymentCommand =
  | CreatePaymentCommand
  | RecordPaymentAuthorizationCommand
  | RecordPaymentCaptureCommand
  | RecordPaymentFailureCommand
  | CancelPaymentCommand;

export type PaymentCreatedEvent = DomainEvent<
  "payments.payment-created",
  Readonly<{
    paymentId: PaymentId;
    buyerAccountId: AccountId;
    orderIds: OrderId[];
    amount: string;
    currencyCode: CurrencyCode;
    processorName: PaymentProcessorName;
    processorPaymentReference: string;
    processorClientSecret: string | null;
    processorStatus: string;
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

export type PaymentEvent =
  | PaymentCreatedEvent
  | PaymentAuthorizedEvent
  | PaymentCapturedEvent
  | PaymentFailedEvent
  | PaymentCancelledEvent;

export const decidePayment: AggregateDecider<
  PaymentState,
  PaymentCommand,
  PaymentEvent
> = (state, command) => {
  switch (command.type) {
    case "CreatePayment":
      assert(state.paymentId === null, "Payment has already been created.");
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
            currencyCode: normalizeCurrencyCode(command.currencyCode),
            processorName: normalizeProcessorName(command.processorName),
            processorPaymentReference: normalizeRequiredText(
              command.processorPaymentReference,
              "Processor payment reference is required.",
            ),
            processorClientSecret: normalizeOptionalText(command.processorClientSecret),
            processorStatus: normalizeRequiredText(
              command.processorStatus,
              "Processor status is required.",
            ),
            createdAt: ensureIsoTimestamp(
              command.createdAt,
              "Payment creation must include a timestamp.",
            ),
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
            processorStatus: normalizeRequiredText(
              command.processorStatus,
              "Processor status is required.",
            ),
            authorizedAt: ensureIsoTimestamp(
              command.authorizedAt,
              "Payment authorization must include a timestamp.",
            ),
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
      return [
        {
          type: "payments.payment-captured",
          data: {
            paymentId: state.paymentId,
            orderIds: [...state.orderIds],
            buyerAccountId: state.buyerAccountId!,
            amount: state.amount!,
            currencyCode: state.currencyCode!,
            processorName: state.processorName!,
            processorPaymentReference: state.processorPaymentReference!,
            processorStatus: normalizeRequiredText(
              command.processorStatus,
              "Processor status is required.",
            ),
            capturedAt: ensureIsoTimestamp(
              command.capturedAt,
              "Payment capture must include a timestamp.",
            ),
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
            currencyCode: state.currencyCode!,
            processorName: state.processorName!,
            processorPaymentReference: state.processorPaymentReference!,
            processorStatus: normalizeRequiredText(
              command.processorStatus,
              "Processor status is required.",
            ),
            failureCode: normalizeOptionalText(command.failureCode),
            failureMessage: normalizeOptionalText(command.failureMessage),
            failedAt: ensureIsoTimestamp(
              command.failedAt,
              "Payment failure must include a timestamp.",
            ),
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
            cancelledAt: ensureIsoTimestamp(
              command.cancelledAt,
              "Payment cancellation must include a timestamp.",
            ),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolvePayment: AggregateEvolver<
  PaymentState,
  PaymentEvent
> = (state, event) => {
  switch (event.type) {
    case "payments.payment-created":
      return {
        paymentId: event.data.paymentId,
        buyerAccountId: event.data.buyerAccountId,
        orderIds: [...event.data.orderIds],
        amount: event.data.amount,
        currencyCode: event.data.currencyCode,
        processorName: event.data.processorName,
        processorPaymentReference: event.data.processorPaymentReference,
        processorClientSecret: event.data.processorClientSecret,
        processorStatus: event.data.processorStatus,
        status: "pending-confirmation",
        failureCode: null,
        failureMessage: null,
        createdAt: event.data.createdAt,
        capturedAt: null,
        failedAt: null,
        cancelledAt: null,
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
    default:
      return assertNever(event);
  }
};
