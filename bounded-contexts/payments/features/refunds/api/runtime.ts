import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createCommandHandler, type CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createNoopNotificationOutbox, type NotificationOutbox } from "@chase-sets/notifications";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { OrderId, PaymentId } from "@chase-sets/primitives/typed-ids";
import {
  normalizeMoneyAmount,
  normalizeRequiredText,
  PaymentsDomainError,
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

type RefundRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  processorGateway: PaymentProcessorGateway;
  notificationOutbox?: NotificationOutbox;
}>;

export type RefundServices = Readonly<{
  commandHandler: CommandHandler<RefundCommand, RefundState, RefundEvent>;
  issueRefund: (
    params: Readonly<{
      paymentId: PaymentId;
      orderIds: readonly string[];
      amount: string;
      reason: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ refundId: RefundId; version: number }>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createRefundRuntime(deps: RefundRuntimeDeps): RefundServices {
  const notificationOutbox = deps.notificationOutbox ?? createNoopNotificationOutbox();
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<RefundEvent>(),
      initialState: () => initialRefundState,
      evolve: evolveRefund,
    }),
    evolve: evolveRefund,
    decide: decideRefund,
  });

  return {
    commandHandler,
    async issueRefund(params, context) {
      const payment = await getPaymentById(deps.db, params.paymentId);
      if (!payment) {
        throw new PaymentsDomainError("Payment not found.");
      }
      if (payment.status !== "captured") {
        throw new PaymentsDomainError("Only captured payments can be refunded.");
      }

      const refundId = createId("rfd") as RefundId;
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

      const requested = await commandHandler({
        streamId: `payments.refund-${refundId}`,
        command: {
          type: "RequestRefund",
          refundId,
          paymentId: params.paymentId,
          orderIds: orderIds as OrderId[],
          amount,
          currencyCode: payment.currency_code as never,
          reason: normalizeRequiredText(params.reason, "Refund reason is required."),
          processorName: payment.processor_name as never,
          requestedAt,
        },
        context,
      });

      try {
        const processorRefund = await deps.processorGateway.createRefund({
          refundId,
          paymentId: params.paymentId,
          processorPaymentReference: payment.processor_payment_reference,
          orderIds: orderIds as OrderId[],
          amount,
          currencyCode: payment.currency_code as never,
          reason: params.reason,
        });
        const issued = await commandHandler({
          streamId: `payments.refund-${refundId}`,
          command: {
            type: "RecordRefundIssued",
            processorRefundReference: processorRefund.processorRefundReference,
            processorStatus: processorRefund.processorStatus,
            issuedAt: new Date().toISOString(),
          },
          context,
        });

        return { refundId, version: issued.version };
      } catch (error) {
        const failed = await commandHandler({
          streamId: `payments.refund-${refundId}`,
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
