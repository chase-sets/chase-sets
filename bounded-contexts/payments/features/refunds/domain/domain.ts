import type {
  AggregateDecider,
  AggregateEvolver,
  DomainEvent,
} from "@chase-sets/event-core";
import type { OrderId, PaymentId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  assertNever,
  ensureIsoTimestamp,
  normalizeCurrencyCode,
  normalizeMoneyAmount,
  normalizeOptionalText,
  normalizeOrderIds,
  normalizeProcessorName,
  normalizeRefundStatus,
  normalizeRequiredText,
  type CurrencyCode,
  type PaymentProcessorName,
  type RefundId,
  type RefundStatus,
} from "../../../support/runtime-support/common";

export type RefundState = Readonly<{
  refundId: RefundId | null;
  paymentId: PaymentId | null;
  orderIds: readonly OrderId[];
  amount: string | null;
  currencyCode: CurrencyCode | null;
  reason: string | null;
  processorName: PaymentProcessorName | null;
  processorRefundReference: string | null;
  processorStatus: string | null;
  status: RefundStatus | null;
  failureCode: string | null;
  failureMessage: string | null;
  requestedAt: string | null;
  issuedAt: string | null;
  failedAt: string | null;
}>;

export const initialRefundState: RefundState = {
  refundId: null,
  paymentId: null,
  orderIds: [],
  amount: null,
  currencyCode: null,
  reason: null,
 processorName: null,
  processorRefundReference: null,
  processorStatus: null,
  status: null,
  failureCode: null,
  failureMessage: null,
  requestedAt: null,
  issuedAt: null,
  failedAt: null,
};

export type RequestRefundCommand = Readonly<{
  type: "RequestRefund";
  refundId: RefundId;
  paymentId: PaymentId;
  orderIds: readonly OrderId[];
  amount: string;
  currencyCode: CurrencyCode;
  reason: string;
  processorName: PaymentProcessorName;
  requestedAt: string;
}>;

export type RecordRefundIssuedCommand = Readonly<{
  type: "RecordRefundIssued";
  processorRefundReference: string;
  processorStatus: string;
  issuedAt: string;
}>;

export type RecordRefundFailureCommand = Readonly<{
  type: "RecordRefundFailure";
  processorStatus: string;
  failureCode: string | null;
  failureMessage: string | null;
  failedAt: string;
}>;

export type RefundCommand =
  | RequestRefundCommand
  | RecordRefundIssuedCommand
  | RecordRefundFailureCommand;

export type RefundRequestedEvent = DomainEvent<
  "payments.refund-requested",
  Readonly<{
    refundId: RefundId;
    paymentId: PaymentId;
    orderIds: OrderId[];
    amount: string;
    currencyCode: CurrencyCode;
    reason: string;
    processorName: PaymentProcessorName;
    requestedAt: string;
  }>
>;

export type RefundIssuedEvent = DomainEvent<
  "payments.refund-issued",
  Readonly<{
    refundId: RefundId;
    paymentId: PaymentId;
    orderIds: OrderId[];
    amount: string;
    currencyCode: CurrencyCode;
    reason: string;
    processorName: PaymentProcessorName;
    processorRefundReference: string;
    processorStatus: string;
    issuedAt: string;
  }>
>;

export type RefundFailedEvent = DomainEvent<
  "payments.refund-failed",
  Readonly<{
    refundId: RefundId;
    paymentId: PaymentId;
    orderIds: OrderId[];
    amount: string;
    currencyCode: CurrencyCode;
    reason: string;
    processorName: PaymentProcessorName;
    processorStatus: string;
    failureCode: string | null;
    failureMessage: string | null;
    failedAt: string;
  }>
>;

export type RefundEvent =
  | RefundRequestedEvent
  | RefundIssuedEvent
  | RefundFailedEvent;

export const decideRefund: AggregateDecider<
  RefundState,
  RefundCommand,
  RefundEvent
> = (state, command) => {
  switch (command.type) {
    case "RequestRefund":
      assert(state.refundId === null, "Refund has already been requested.");
      return [
        {
          type: "payments.refund-requested",
          data: {
            refundId: command.refundId,
            paymentId: command.paymentId,
            orderIds: normalizeOrderIds(command.orderIds),
            amount: normalizeMoneyAmount(command.amount, {
              fieldName: "Refund amount",
            }),
            currencyCode: normalizeCurrencyCode(command.currencyCode),
            reason: normalizeRequiredText(
              command.reason,
              "Refund reason is required.",
            ),
            processorName: normalizeProcessorName(command.processorName),
            requestedAt: ensureIsoTimestamp(
              command.requestedAt,
              "Refund request must include a timestamp.",
            ),
          },
        },
      ];
    case "RecordRefundIssued":
      assert(state.refundId !== null, "Refund must be requested first.");
      if (state.status === "issued") {
        return [];
      }
      return [
        {
          type: "payments.refund-issued",
          data: {
            refundId: state.refundId,
            paymentId: state.paymentId!,
            orderIds: [...state.orderIds],
            amount: state.amount!,
            currencyCode: state.currencyCode!,
            reason: state.reason!,
            processorName: state.processorName!,
            processorRefundReference: normalizeRequiredText(
              command.processorRefundReference,
              "Processor refund reference is required.",
            ),
            processorStatus: normalizeRequiredText(
              command.processorStatus,
              "Processor refund status is required.",
            ),
            issuedAt: ensureIsoTimestamp(
              command.issuedAt,
              "Refund issuance must include a timestamp.",
            ),
          },
        },
      ];
    case "RecordRefundFailure":
      assert(state.refundId !== null, "Refund must be requested first.");
      if (state.status === "failed") {
        return [];
      }
      return [
        {
          type: "payments.refund-failed",
          data: {
            refundId: state.refundId,
            paymentId: state.paymentId!,
            orderIds: [...state.orderIds],
            amount: state.amount!,
            currencyCode: state.currencyCode!,
            reason: state.reason!,
            processorName: state.processorName!,
            processorStatus: normalizeRequiredText(
              command.processorStatus,
              "Processor refund status is required.",
            ),
            failureCode: normalizeOptionalText(command.failureCode),
            failureMessage: normalizeOptionalText(command.failureMessage),
            failedAt: ensureIsoTimestamp(
              command.failedAt,
              "Refund failure must include a timestamp.",
            ),
          },
        },
      ];
    default:
      return assertNever(command);
  }
};

export const evolveRefund: AggregateEvolver<RefundState, RefundEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "payments.refund-requested":
      return {
        refundId: event.data.refundId,
        paymentId: event.data.paymentId,
        orderIds: [...event.data.orderIds],
        amount: event.data.amount,
        currencyCode: event.data.currencyCode,
        reason: event.data.reason,
        processorName: event.data.processorName,
        processorRefundReference: null,
        processorStatus: "requested",
        status: "requested",
        failureCode: null,
        failureMessage: null,
        requestedAt: event.data.requestedAt,
        issuedAt: null,
        failedAt: null,
      };
    case "payments.refund-issued":
      return {
        ...state,
        processorRefundReference: event.data.processorRefundReference,
        processorStatus: event.data.processorStatus,
        status: normalizeRefundStatus("issued"),
        failureCode: null,
        failureMessage: null,
        issuedAt: event.data.issuedAt,
      };
    case "payments.refund-failed":
      return {
        ...state,
        processorStatus: event.data.processorStatus,
        status: normalizeRefundStatus("failed"),
        failureCode: event.data.failureCode,
        failureMessage: event.data.failureMessage,
        failedAt: event.data.failedAt,
      };
    default:
      return assertNever(event);
  }
};
