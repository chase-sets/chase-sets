import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createNoopNotificationOutbox, type NotificationOutbox } from "@chase-sets/outbound-messaging";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { OrderId, PaymentId } from "@chase-sets/primitives/typed-ids";
import {
  compareMoney,
  normalizeMoneyAmount,
  normalizeRequiredText,
  PaymentsDomainError,
  subtractMoney,
  type CurrencyCode,
  type PaymentProcessorName,
  type RefundId,
} from "../../../support/runtime-support/common";
import type { PaymentProcessorGateway } from "@chase-sets/payment-processing";
import { getPaymentById } from "../../payments/read-model/queries";
import {
  buildRefundTransactionalEmailProjectionHandlers,
  PAYMENTS_REFUND_TRANSACTIONAL_EMAIL_PROJECTION,
} from "../integrations/transactional-email/transactional-email-projector";
import { buildRefundProjectionHandlers } from "../read-model/projection";
import {
  decideRefund,
  evolveRefund,
  initialRefundState,
  type RefundCommand,
  type RefundEvent,
  type RefundState,
} from "../domain/domain";
import type { RefundCausationInput } from "../domain/causation";
import {
  decidePayment,
  evolvePayment,
  initialPaymentState,
  remainingRefundableAmountForOrders,
  type PaymentEvent,
} from "../../payments/domain/domain";

type RefundRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  processorGateway: PaymentProcessorGateway;
  notificationOutbox?: NotificationOutbox;
}>;

function arraysEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Distinguishes the three refund submission outcomes so a caller (e.g. a refund
 * effect projection) can react precisely: a `requested` refund reached the
 * processor and must be marked in-flight; a `gateway-failed` refund was recorded
 * as failed at the processor and must be retried (never marked succeeded); a
 * `not-refundable` refund had no remaining refundable balance on the order and
 * must be skipped rather than issued. The `amount` is the amount actually
 * requested at the processor (possibly clamped below the requested amount to the
 * order's cumulative remaining refundable).
 */
export type IssueRefundOutcome =
  | Readonly<{ outcome: "requested"; refundId: RefundId; version: number; amount: string }>
  | Readonly<{
      outcome: "gateway-failed";
      refundId: RefundId;
      version: number;
      amount: string;
      failureMessage: string;
    }>
  | Readonly<{ outcome: "not-refundable"; refundId: RefundId; reason: string }>;

export type IssueRefundParams = Readonly<{
  refundId?: RefundId;
  paymentId: PaymentId;
  orderIds: readonly string[];
  amount: string;
  reason: string;
  causation?: RefundCausationInput | null;
  /**
   * When set, the amount is clamped to the order's authoritative cumulative
   * remaining refundable (settled + reserved) instead of being rejected when it
   * exceeds it; a zero remaining yields a `not-refundable` outcome. Leave unset
   * for callers that must refund an exact amount or fail loudly.
   */
  capToRemainingRefundable?: boolean;
}>;

export type RefundServices = Readonly<{
  commandHandler: CommandHandler<RefundCommand, RefundState, RefundEvent>;
  issueRefund: (params: IssueRefundParams, context: EventStoreContext) => Promise<IssueRefundOutcome>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createRefundRuntime(deps: RefundRuntimeDeps): RefundServices {
  const notificationOutbox = deps.notificationOutbox ?? createNoopNotificationOutbox();
  const { commandHandler: refundCommandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<RefundEvent>(),
    initialState: () => initialRefundState,
    evolve: evolveRefund,
    decide: decideRefund,
  });
  const { commandHandler: paymentCommandHandler, repository: paymentRepository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<PaymentEvent>(),
    initialState: () => initialPaymentState,
    evolve: evolvePayment,
    decide: decidePayment,
  });

  return {
    commandHandler: refundCommandHandler,
    async issueRefund(params, context) {
      const payment = await getPaymentById(deps.db, params.paymentId);
      if (!payment) {
        throw new PaymentsDomainError("Payment not found.");
      }
      if (payment.status !== "captured" && payment.status !== "partially-refunded") {
        throw new PaymentsDomainError("Only captured payments can be refunded.");
      }

      const refundId = params.refundId ?? (createId("rfd") as RefundId);
      const requestedAt = new Date().toISOString();
      const requestedAmount = normalizeMoneyAmount(params.amount, {
        fieldName: "Refund amount",
      });
      const orderIds = [...new Set(params.orderIds.map((orderId) => orderId.trim()).filter(Boolean))];
      if (orderIds.length === 0) {
        throw new PaymentsDomainError("Refund must reference at least one order.");
      }
      const invalidOrderId = orderIds.find((orderId) => !payment.order_ids.includes(orderId));
      if (invalidOrderId) {
        throw new PaymentsDomainError("Refund order must belong to the payment.");
      }
      const reason = normalizeRequiredText(params.reason, "Refund reason is required.");
      const currencyCode = payment.currency_code as CurrencyCode;
      const processorName = payment.processor_name as PaymentProcessorName;
      const refundStreamId = `payments.refund-${refundId}`;

      // Resolve the amount to actually request. A refund that was already
      // requested (including one that failed at the gateway and is now being
      // retried) reuses its own reserved amount verbatim so the retry is a
      // no-op reservation and the processor idempotency key dedupes it. A
      // brand-new refund with capping enabled is clamped to the order's
      // authoritative cumulative remaining refundable.
      let amount: string = requestedAmount;
      const existingRefund = params.refundId ? await repository.load(refundStreamId) : null;
      if (existingRefund && existingRefund.state.refundId !== null) {
        if (existingRefund.state.status === "issued") {
          if (
            existingRefund.state.paymentId !== params.paymentId ||
            !arraysEqual(existingRefund.state.orderIds, orderIds) ||
            existingRefund.state.currencyCode !== currencyCode ||
            existingRefund.state.reason !== reason ||
            existingRefund.state.processorName !== processorName
          ) {
            throw new PaymentsDomainError("Refund request does not match the existing refund.");
          }
          return {
            outcome: "requested",
            refundId,
            version: existingRefund.version,
            amount: existingRefund.state.amount!,
          };
        }
        // Reuse the already-reserved amount for a retry of a requested/failed refund.
        amount = existingRefund.state.amount!;
      } else if (params.capToRemainingRefundable) {
        const { state: paymentState } = await paymentRepository.load(`payments.payment-${params.paymentId}`);
        const remaining = remainingRefundableAmountForOrders(paymentState, orderIds as OrderId[], refundId);
        if (compareMoney(remaining, "0.00") <= 0) {
          return {
            outcome: "not-refundable",
            refundId,
            reason: "Order has no remaining refundable amount.",
          };
        }
        if (compareMoney(amount, remaining) > 0) {
          amount = remaining;
        }
      } else {
        const remainingRefundableAmount = subtractMoney(payment.amount, payment.refunded_amount);
        if (compareMoney(amount, remainingRefundableAmount) > 0) {
          throw new PaymentsDomainError("Refund amount cannot exceed the remaining refundable payment amount.");
        }
      }

      let requested: Awaited<ReturnType<typeof refundCommandHandler>>;
      try {
        await paymentCommandHandler({
          streamId: `payments.payment-${params.paymentId}`,
          command: {
            type: "RequestPaymentRefund",
            refundId,
            orderIds: orderIds as OrderId[],
            amount,
            requestedAt,
          },
          context,
        });

        requested = await refundCommandHandler({
          streamId: refundStreamId,
          command: {
            type: "RequestRefund",
            refundId,
            paymentId: params.paymentId,
            orderIds: orderIds as OrderId[],
            amount,
            currencyCode,
            reason,
            processorName,
            causation: params.causation ?? null,
            requestedAt,
          },
          context,
        });
      } catch (error) {
        // A concurrent refund can consume the order's remaining refundable
        // between the cap read and the reservation append. In capped mode this
        // is not a fault — the order is simply already exhausted — so surface it
        // as not-refundable (skip) rather than a failure to retry.
        if (
          params.capToRemainingRefundable &&
          error instanceof PaymentsDomainError &&
          /remaining refundable/i.test(error.message)
        ) {
          return { outcome: "not-refundable", refundId, reason: error.message };
        }
        throw error;
      }

      try {
        await deps.processorGateway.createRefund({
          refundId,
          paymentId: params.paymentId,
          processorPaymentReference: payment.processor_payment_reference,
          orderIds: orderIds as OrderId[],
          amount,
          currencyCode,
          reason: params.reason,
        });
      } catch (error) {
        const failureMessage = error instanceof Error ? error.message : "Refund failed.";
        const failed = await refundCommandHandler({
          streamId: refundStreamId,
          command: {
            type: "RecordRefundFailure",
            processorStatus: "failed",
            failureCode: null,
            failureMessage,
            failedAt: new Date().toISOString(),
          },
          context,
        });

        // Do NOT return success-shaped: the gateway rejected the refund. The
        // caller must keep the effect retryable instead of marking it issued.
        return {
          outcome: "gateway-failed",
          refundId,
          version: failed.version || requested.version,
          amount,
          failureMessage,
        };
      }

      return { outcome: "requested", refundId, version: requested.version, amount };
    },
    projectors: [
      createProjectionHandlerSet({
        projectionName: "payments-refund-projection",
        handlers: buildRefundProjectionHandlers(deps.db),
      }),
      createProjectionHandlerSet({
        projectionName: PAYMENTS_REFUND_TRANSACTIONAL_EMAIL_PROJECTION,
        handlers: buildRefundTransactionalEmailProjectionHandlers(
          deps.db,
          notificationOutbox,
          PAYMENTS_REFUND_TRANSACTIONAL_EMAIL_PROJECTION,
        ),
      }),
    ],
  };
}
