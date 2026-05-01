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
import { recordProviderWebhookEvent } from "@chase-sets/provider-webhook-inbox";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, OrderId, PaymentId } from "@chase-sets/primitives/typed-ids";
import {
  assert,
  compareMoney,
  normalizeCurrencyCode,
  normalizeMoneyAmount,
  normalizeOrderIds,
  normalizeRequiredText,
  PaymentsDomainError,
  subtractMoney,
} from "../../../support/runtime-support/common";
import type {
  PaymentProcessorGateway,
  PaymentProcessorPublicConfig,
} from "@chase-sets/payment-processing";
import type { BalanceCreditResolver } from "./balance-credit-resolver";
import { listPaymentOrderInputs } from "../integrations/order-input/order-input-queries";
import { buildPaymentProjectionHandlers } from "../read-model/projection";
import {
  getAccountPayment,
  getPaymentByProcessorReference,
  getPaymentBySource,
  type PaymentDetailRow,
} from "../read-model/queries";
import {
  decidePayment,
  evolvePayment,
  initialPaymentState,
  type PaymentCommand,
  type PaymentEvent,
  type PaymentState,
} from "../domain/domain";

type PaymentRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  processorGateway: PaymentProcessorGateway;
  balanceCreditResolver?: BalanceCreditResolver;
}>;

function sumOrderAmounts(
  orders: readonly Readonly<{ total_amount: string }>[],
) {
  return orders
    .reduce(
      (sum, order) =>
        sum +
        Number.parseFloat(
          normalizeMoneyAmount(order.total_amount, {
            fieldName: "Order total",
          }),
        ),
      0,
    )
    .toFixed(2);
}

function sumFeeAmounts(
  orders: readonly Readonly<{
    marketplace_fee_amount: string;
    payment_fee_amount: string;
    seller_net_amount: string;
  }>[],
  fieldName: "marketplace_fee_amount" | "payment_fee_amount" | "seller_net_amount",
) {
  return orders
    .reduce(
      (sum, order) =>
        sum +
        Number.parseFloat(
          normalizeMoneyAmount(order[fieldName], {
            fieldName,
            allowZero: true,
          }),
        ),
      0,
    )
    .toFixed(2);
}

async function loadAccountOrders(
  db: PgQueryable,
  orderIds: readonly OrderId[],
  accountId: AccountId,
) {
  const orders = await listPaymentOrderInputs(db, orderIds, accountId);
  const ordersById = new Map(orders.map((order) => [order.order_id, order]));

  for (const orderId of orderIds) {
    const order = ordersById.get(orderId);
    if (!order) {
      throw new PaymentsDomainError(`Order ${orderId} was not found.`);
    }
    if (order.status !== "pending-payment") {
      throw new PaymentsDomainError(
        `Order ${orderId} is not eligible for payment in status ${order.status}.`,
      );
    }
  }

  return orders;
}

export type PaymentServices = Readonly<{
  commandHandler: CommandHandler<PaymentCommand, PaymentState, PaymentEvent>;
  createAccountPayment: (
    params: Readonly<{
      accountId: AccountId;
      orderIds: readonly OrderId[];
      currencyCode?: string;
      sourceContext?: string | null;
      sourceReferenceId?: string | null;
      requestedBalanceCreditAmount?: string | null;
      returnUrlBase?: string | null;
      clientRiskContext?: Readonly<{
        ipAddress?: string | null;
        userAgent?: string | null;
      }> | null;
    }>,
    context: EventStoreContext,
  ) => Promise<PaymentDetailRow & Readonly<{ processor_publishable_key: string | null }>>;
  getAccountPayment: (
    paymentId: string,
    accountId: string,
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

  function exposePayment(
    payment: PaymentDetailRow,
  ): PaymentDetailRow & Readonly<{ processor_publishable_key: string | null }> {
    const canConfirmWithProcessor =
      payment.status === "pending-confirmation" &&
      Boolean(payment.processor_client_secret);

    return {
      ...payment,
      processor_client_secret: canConfirmWithProcessor
        ? payment.processor_client_secret
        : null,
      processor_publishable_key: canConfirmWithProcessor
        ? publicConfig.publishableKey
        : null,
    };
  }

  return {
    commandHandler,
    async createAccountPayment(params, context) {
      const accountId = normalizeRequiredText(
        params.accountId,
        "Account is required.",
      ) as AccountId;
      const sourceContext = params.sourceContext?.trim() || null;
      const sourceReferenceId = params.sourceReferenceId?.trim() || null;
      if (sourceContext && sourceReferenceId) {
        const existing = await getPaymentBySource(
          deps.db,
          sourceContext,
          sourceReferenceId,
          accountId,
        );
        if (existing) {
          return exposePayment(existing);
        }
      }
      const orderIds = normalizeOrderIds(params.orderIds);
      const orders = await loadAccountOrders(deps.db, orderIds, accountId);
      const amount = sumOrderAmounts(orders);
      const currencyCode = normalizeCurrencyCode(params.currencyCode ?? "usd");
      const requestedBalanceCreditAmount = normalizeMoneyAmount(
        params.requestedBalanceCreditAmount ?? "0.00",
        {
          fieldName: "Balance credit amount",
          allowZero: true,
        },
      );
      const balanceCredit = deps.balanceCreditResolver
        ? await deps.balanceCreditResolver.resolveBalanceCredit({
            buyerAccountId: accountId,
            currencyCode,
            requestedAmount: requestedBalanceCreditAmount,
            orderTotalAmount: amount,
          })
        : {
            requestedAmount: requestedBalanceCreditAmount,
            appliedAmount: "0.00",
            remainingExternalAmount: amount,
          };
      const balanceCreditAmount = normalizeMoneyAmount(balanceCredit.appliedAmount, {
        fieldName: "Balance credit amount",
        allowZero: true,
      });
      const processorAmount = normalizeMoneyAmount(
        balanceCredit.remainingExternalAmount || subtractMoney(amount, balanceCreditAmount),
        {
          fieldName: "External payment amount",
          allowZero: true,
        },
      );
      if (compareMoney(balanceCreditAmount, amount) > 0) {
        throw new PaymentsDomainError("Balance credit cannot exceed the payment amount.");
      }
      const marketplaceFeeAmount = sumFeeAmounts(orders, "marketplace_fee_amount");
      const paymentFeeAmount = sumFeeAmounts(orders, "payment_fee_amount");
      const sellerNetAmount = sumFeeAmounts(orders, "seller_net_amount");
      const paymentId = createId("pay") as PaymentId;
      const returnUrlBase = params.returnUrlBase?.trim().replace(/\/+$/, "") ?? "";
      const processorPayment = compareMoney(processorAmount, "0.00") === 0
        ? {
            processorName: publicConfig.processorName,
            processorPaymentReference: `balance-credit:${paymentId}`,
            processorClientSecret: null,
            processorStatus: "balance-credit-captured",
          }
        : await deps.processorGateway.createPaymentIntent({
            paymentId,
            buyerAccountId: accountId,
            orderIds,
            amount: processorAmount,
            currencyCode,
            description:
              orderIds.length === 1
                ? `Chase Sets order ${orderIds[0]}`
                : `Chase Sets checkout for ${orderIds.length} orders`,
            returnUrl: returnUrlBase
              ? `${returnUrlBase}/account/payments/${paymentId}`
              : null,
            idempotencyKey: `payments:payment:${paymentId}:create`,
            clientRiskContext: params.clientRiskContext ?? null,
          });
      const createdAt = new Date().toISOString();

      await commandHandler({
        streamId: `payments.payment-${paymentId}`,
        command: {
          type: "CreatePayment",
          paymentId,
          buyerAccountId: accountId,
          orderIds,
          amount,
          balanceCreditAmount,
          processorAmount,
          marketplaceFeeAmount,
          paymentFeeAmount,
          sellerNetAmount,
          currencyCode,
          processorName: processorPayment.processorName,
          processorPaymentReference: processorPayment.processorPaymentReference,
          processorClientSecret: processorPayment.processorClientSecret,
          processorStatus: processorPayment.processorStatus,
          sourceContext,
          sourceReferenceId,
          createdAt,
        },
        context,
      });

      if (compareMoney(processorAmount, "0.00") === 0) {
        await commandHandler({
          streamId: `payments.payment-${paymentId}`,
          command: {
            type: "RecordPaymentCapture",
            processorStatus: processorPayment.processorStatus,
            capturedAt: createdAt,
          },
          context,
        });
      }

      return {
        payment_id: paymentId,
        buyer_account_id: accountId,
        order_ids: orderIds,
        amount,
        balance_credit_amount: balanceCreditAmount,
        processor_amount: processorAmount,
        marketplace_fee_amount: marketplaceFeeAmount,
        payment_fee_amount: paymentFeeAmount,
        seller_net_amount: sellerNetAmount,
        currency_code: currencyCode,
        processor_name: processorPayment.processorName,
        processor_payment_reference: processorPayment.processorPaymentReference,
        processor_client_secret: processorPayment.processorClientSecret,
        processor_status: processorPayment.processorStatus,
        source_context: sourceContext,
        source_reference_id: sourceReferenceId,
        status: compareMoney(processorAmount, "0.00") === 0
          ? "captured"
          : "pending-confirmation",
        failure_code: null,
        failure_message: null,
        created_at: createdAt,
        updated_at: createdAt,
        captured_at: compareMoney(processorAmount, "0.00") === 0 ? createdAt : null,
        failed_at: null,
        cancelled_at: null,
        processor_publishable_key: publicConfig.publishableKey,
      };
    },
    async getAccountPayment(paymentId, accountId) {
      const payment = await getAccountPayment(deps.db, paymentId, accountId);
      return payment ? exposePayment(payment) : null;
    },
    async processWebhook(params, context) {
      const webhookEvent = await deps.processorGateway.parseWebhook(params);
      if (!webhookEvent) {
        return { received: true, ignored: true };
      }
      const isNewProviderEvent = await recordProviderWebhookEvent(deps.db, {
        tableName: "payments_provider_webhook_events",
        providerEventId: webhookEvent.eventId,
        providerName: webhookEvent.processorName,
        eventKind: webhookEvent.kind,
        providerObjectReference: webhookEvent.processorPaymentReference,
      });
      if (!isNewProviderEvent) {
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
        case "payment-cancelled":
          await commandHandler({
            streamId,
            command: {
              type: "CancelPayment",
              cancelledAt: webhookEvent.occurredAt,
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
