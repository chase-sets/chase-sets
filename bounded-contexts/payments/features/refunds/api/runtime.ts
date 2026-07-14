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
import { decidePayment, evolvePayment, initialPaymentState, type PaymentEvent } from "../../payments/domain/domain";

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

export type RefundServices = Readonly<{
  commandHandler: CommandHandler<RefundCommand, RefundState, RefundEvent>;
  issueRefund: (
    params: Readonly<{
      refundId?: RefundId;
      paymentId: PaymentId;
      orderIds: readonly string[];
      amount: string;
      reason: string;
      causation?: RefundCausationInput | null;
    }>,
    context: EventStoreContext,
  ) => Promise<{ refundId: RefundId; version: number }>;
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
  const { commandHandler: paymentCommandHandler } = createAggregateCommandHandler({
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
      const amount = normalizeMoneyAmount(params.amount, {
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
      if (params.refundId) {
        const existingRefund = await repository.load(refundStreamId);
        if (existingRefund.state.status === "issued") {
          if (
            existingRefund.state.paymentId !== params.paymentId ||
            !arraysEqual(existingRefund.state.orderIds, orderIds) ||
            existingRefund.state.amount !== amount ||
            existingRefund.state.currencyCode !== currencyCode ||
            existingRefund.state.reason !== reason ||
            existingRefund.state.processorName !== processorName
          ) {
            throw new PaymentsDomainError("Refund request does not match the existing refund.");
          }
          return { refundId, version: existingRefund.version };
        }
      }

      const remainingRefundableAmount = subtractMoney(payment.amount, payment.refunded_amount);
      if (compareMoney(amount, remainingRefundableAmount) > 0) {
        throw new PaymentsDomainError("Refund amount cannot exceed the remaining refundable payment amount.");
      }

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

      const requested = await refundCommandHandler({
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

      let processorRefund: Awaited<ReturnType<PaymentProcessorGateway["createRefund"]>>;
      try {
        processorRefund = await deps.processorGateway.createRefund({
          refundId,
          paymentId: params.paymentId,
          processorPaymentReference: payment.processor_payment_reference,
          orderIds: orderIds as OrderId[],
          amount,
          currencyCode,
          reason: params.reason,
        });
      } catch (error) {
        const failed = await refundCommandHandler({
          streamId: refundStreamId,
          command: {
            type: "RecordRefundFailure",
            processorStatus: "failed",
            failureCode: null,
            failureMessage: error instanceof Error ? error.message : "Refund failed.",
            failedAt: new Date().toISOString(),
          },
          context,
        });

        return { refundId, version: failed.version || requested.version };
      }

      void processorRefund;
      return { refundId, version: requested.version };
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
