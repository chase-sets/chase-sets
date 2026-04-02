import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, OrderId, PaymentId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  normalizeCurrencyCode,
  normalizeMoneyAmount,
  normalizeOrderIds,
  normalizeRequiredText,
  PaymentsDomainError,
  type BuyerOrderSnapshot,
} from "../common";
import type {
  PaymentProcessorGateway,
  PaymentProcessorPublicConfig,
} from "../processor-gateway";
import { buildPaymentProjectionHandlers } from "./projection";
import {
  getBuyerPayment,
  getPaymentByProcessorReference,
  type PaymentDetailRow,
} from "./queries";
import {
  decidePayment,
  evolvePayment,
  initialPaymentState,
  type PaymentCommand,
  type PaymentEvent,
  type PaymentState,
} from "./domain";

type PaymentRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  processorGateway: PaymentProcessorGateway;
  getOrderSnapshot: (
    orderId: OrderId,
    buyerAccountId: AccountId,
  ) => Promise<BuyerOrderSnapshot | null>;
}>;

function sumOrderAmounts(orders: readonly BuyerOrderSnapshot[]) {
  return orders
    .reduce(
      (sum, order) =>
        sum +
        Number.parseFloat(
          normalizeMoneyAmount(order.totalAmount, {
            fieldName: "Order total",
          }),
        ),
      0,
    )
    .toFixed(2);
}

async function loadBuyerOrders(
  orderIds: readonly OrderId[],
  buyerAccountId: AccountId,
  getOrderSnapshot: PaymentRuntimeDeps["getOrderSnapshot"],
) {
  const orders: BuyerOrderSnapshot[] = [];

  for (const orderId of orderIds) {
    const order = await getOrderSnapshot(orderId, buyerAccountId);
    if (!order) {
      throw new PaymentsDomainError(`Order ${orderId} was not found.`);
    }
    if (order.status !== "pending-payment") {
      throw new PaymentsDomainError(
        `Order ${orderId} is not eligible for payment in status ${order.status}.`,
      );
    }
    orders.push(order);
  }

  return orders;
}

export type PaymentServices = Readonly<{
  commandHandler: CommandHandler<PaymentCommand, PaymentState, PaymentEvent>;
  createBuyerPayment: (
    params: Readonly<{
      buyerAccountId: AccountId;
      orderIds: readonly OrderId[];
      currencyCode?: string;
    }>,
    context: EventStoreContext,
  ) => Promise<PaymentDetailRow & Readonly<{ processor_publishable_key: string | null }>>;
  getBuyerPayment: (
    paymentId: string,
    buyerAccountId: string,
  ) => Promise<(PaymentDetailRow & Readonly<{ processor_publishable_key: string | null }>) | null>;
  processWebhook: (
    params: Readonly<{ rawBody: string; signatureHeader: string | null }>,
    context: EventStoreContext,
  ) => Promise<{ received: boolean; ignored: boolean }>;
  publicConfig: PaymentProcessorPublicConfig;
  projectors: readonly Projector[];
}>;

export function createPaymentRuntime(
  deps: PaymentRuntimeDeps,
): PaymentServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<PaymentEvent>(),
      initialState: () => initialPaymentState,
      evolve: evolvePayment,
    }),
    evolve: evolvePayment,
    decide: decidePayment,
  });

  const publicConfig = deps.processorGateway.getPublicConfiguration();

  return {
    commandHandler,
    async createBuyerPayment(params, context) {
      const buyerAccountId = normalizeRequiredText(
        params.buyerAccountId,
        "Buyer account is required.",
      ) as AccountId;
      const orderIds = normalizeOrderIds(params.orderIds);
      const orders = await loadBuyerOrders(orderIds, buyerAccountId, deps.getOrderSnapshot);
      const amount = sumOrderAmounts(orders);
      const paymentId = createId("pay") as PaymentId;
      const currencyCode = normalizeCurrencyCode(params.currencyCode ?? "usd");
      const processorPayment = await deps.processorGateway.createPaymentIntent({
        paymentId,
        buyerAccountId,
        orderIds,
        amount,
        currencyCode,
        description:
          orderIds.length === 1
            ? `Chase Sets order ${orderIds[0]}`
            : `Chase Sets checkout for ${orderIds.length} orders`,
      });
      const createdAt = new Date().toISOString();

      await commandHandler({
        streamId: `payments.payment-${paymentId}`,
        command: {
          type: "CreatePayment",
          paymentId,
          buyerAccountId,
          orderIds,
          amount,
          currencyCode,
          processorName: processorPayment.processorName,
          processorPaymentReference: processorPayment.processorPaymentReference,
          processorClientSecret: processorPayment.processorClientSecret,
          processorStatus: processorPayment.processorStatus,
          createdAt,
        },
        context,
      });

      return {
        payment_id: paymentId,
        buyer_account_id: buyerAccountId,
        order_ids: orderIds,
        amount,
        currency_code: currencyCode,
        processor_name: processorPayment.processorName,
        processor_payment_reference: processorPayment.processorPaymentReference,
        processor_client_secret: processorPayment.processorClientSecret,
        processor_status: processorPayment.processorStatus,
        status: "pending-confirmation",
        failure_code: null,
        failure_message: null,
        created_at: createdAt,
        updated_at: createdAt,
        captured_at: null,
        failed_at: null,
        cancelled_at: null,
        processor_publishable_key: publicConfig.publishableKey,
      };
    },
    async getBuyerPayment(paymentId, buyerAccountId) {
      const payment = await getBuyerPayment(deps.db, paymentId, buyerAccountId);
      return payment
        ? {
            ...payment,
            processor_publishable_key: publicConfig.publishableKey,
          }
        : null;
    },
    async processWebhook(params, context) {
      const webhookEvent = await deps.processorGateway.parseWebhook(params);
      if (!webhookEvent) {
        return { received: true, ignored: true };
      }

      const payment = await getPaymentByProcessorReference(
        deps.db,
        webhookEvent.processorName,
        webhookEvent.processorPaymentReference,
      );

      if (!payment) {
        return { received: true, ignored: true };
      }

      const streamId = `payments.payment-${payment.payment_id}`;

      switch (webhookEvent.kind) {
        case "payment-authorized":
          await commandHandler({
            streamId,
            command: {
              type: "RecordPaymentAuthorization",
              processorStatus: webhookEvent.processorStatus,
              authorizedAt: webhookEvent.occurredAt,
            },
            context,
          });
          break;
        case "payment-captured":
          await commandHandler({
            streamId,
            command: {
              type: "RecordPaymentCapture",
              processorStatus: webhookEvent.processorStatus,
              capturedAt: webhookEvent.occurredAt,
            },
            context,
          });
          break;
        case "payment-failed":
          await commandHandler({
            streamId,
            command: {
              type: "RecordPaymentFailure",
              processorStatus: webhookEvent.processorStatus,
              failureCode: webhookEvent.failureCode,
              failureMessage: webhookEvent.failureMessage,
              failedAt: webhookEvent.occurredAt,
            },
            context,
          });
          break;
        default:
          assert(false, "Unhandled payment webhook kind.");
      }

      return { received: true, ignored: false };
    },
    publicConfig,
    projectors: [
      createProjector({
        projectorName: "payments-payment-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildPaymentProjectionHandlers(deps.db),
      }),
    ],
  };
}
