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
  getPaymentById,
  getPaymentByProcessorReference,
  getPaymentProviderEvent,
  listPaymentProviderEvents,
  listPaymentProviderIdempotencyKeys,
  listPaymentsNeedingReconciliation,
  recordPaymentProviderIdempotencyKey,
  getPaymentBySource,
  type PaymentDetailRow,
  type PaymentProviderIdempotencyKeyRow,
  type PaymentProviderEventRow,
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
  ) => Promise<PaymentDetailRow & Readonly<{
    processor_publishable_key: string | null;
    provider_events: readonly PaymentProviderEventRow[];
  }>>;
  getAccountPayment: (
    paymentId: string,
    accountId: string,
  ) => Promise<(PaymentDetailRow & Readonly<{
    processor_publishable_key: string | null;
    provider_events: readonly PaymentProviderEventRow[];
  }>) | null>;
  getCheckoutStatus: (
    params: Readonly<{
      accountId: AccountId;
      orderIds: readonly OrderId[];
      currencyCode?: string;
      requestedBalanceCreditAmount?: string | null;
    }>,
  ) => Promise<Readonly<{
    order_ids: readonly string[];
    currency_code: string;
    amount: string;
    wallet_credit: Readonly<{
      requested_amount: string;
      applied_amount: string;
      external_amount: string;
    }>;
    can_start_payment: boolean;
    unavailable_reasons: readonly string[];
  }>>;
  getProviderEvent: (
    params: Readonly<{ providerEventId: string; accountId: string }>,
  ) => Promise<PaymentProviderEventRow | null>;
  listProviderIdempotencyKeys: (
    params: Readonly<{ accountId: string; limit?: number }>,
  ) => Promise<PaymentProviderIdempotencyKeyRow[]>;
  listPaymentsNeedingReconciliation: (
    params?: Readonly<{ limit?: number }>,
  ) => Promise<PaymentDetailRow[]>;
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
    providerEvents: readonly PaymentProviderEventRow[] = [],
  ): PaymentDetailRow & Readonly<{
    processor_publishable_key: string | null;
    provider_events: readonly PaymentProviderEventRow[];
  }> {
    const canConfirmWithProcessor = payment.status === "pending-confirmation";
    const canUseProcessorManagedForm =
      canConfirmWithProcessor && Boolean(payment.processor_client_secret);

    return {
      ...payment,
      processor_client_secret: canUseProcessorManagedForm
        ? payment.processor_client_secret
        : null,
      processor_redirect_url: canConfirmWithProcessor
        ? payment.processor_redirect_url
        : null,
      processor_publishable_key: canUseProcessorManagedForm
        ? publicConfig.publishableKey
        : null,
      provider_events: providerEvents,
    };
  }

  return {
    commandHandler,
    async getCheckoutStatus(params) {
      const accountId = normalizeRequiredText(
        params.accountId,
        "Account is required.",
      ) as AccountId;
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
      const appliedAmount = normalizeMoneyAmount(balanceCredit.appliedAmount, {
        fieldName: "Balance credit amount",
        allowZero: true,
      });
      const externalAmount = normalizeMoneyAmount(
        balanceCredit.remainingExternalAmount || subtractMoney(amount, appliedAmount),
        {
          fieldName: "External payment amount",
          allowZero: true,
        },
      );

      return {
        order_ids: orderIds,
        currency_code: currencyCode,
        amount,
        wallet_credit: {
          requested_amount: balanceCredit.requestedAmount,
          applied_amount: appliedAmount,
          external_amount: externalAmount,
        },
        can_start_payment: compareMoney(amount, "0.00") > 0,
        unavailable_reasons:
          compareMoney(amount, "0.00") > 0 ? [] : ["no-payable-order-balance"],
      };
    },
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
      const providerIdempotencyKey = `payments:payment:${paymentId}:create`;
      const processorPayment = compareMoney(processorAmount, "0.00") === 0
        ? {
            processorName: publicConfig.processorName,
            processorPaymentKind: "balance-credit" as const,
            processorPaymentReference: `balance-credit:${paymentId}`,
            processorClientSecret: null,
            processorRedirectUrl: null,
            processorStatus: "balance-credit-captured",
          }
        : await deps.processorGateway.createPaymentSession({
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
            idempotencyKey: providerIdempotencyKey,
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
          processorPaymentKind: processorPayment.processorPaymentKind,
          processorPaymentReference: processorPayment.processorPaymentReference,
          processorClientSecret: processorPayment.processorClientSecret,
          processorRedirectUrl: processorPayment.processorRedirectUrl,
          processorStatus: processorPayment.processorStatus,
          sourceContext,
          sourceReferenceId,
          createdAt,
        },
        context,
      });
      await recordPaymentProviderIdempotencyKey(deps.db, {
        operationKey: `payment:${paymentId}:create`,
        providerName: processorPayment.processorName,
        operationKind: "payment-session-create",
        accountId,
        providerObjectReference: processorPayment.processorPaymentReference,
        idempotencyKey: providerIdempotencyKey,
        createdAt,
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
        processor_payment_kind: processorPayment.processorPaymentKind,
        processor_payment_reference: processorPayment.processorPaymentReference,
        processor_client_secret: processorPayment.processorClientSecret,
        processor_redirect_url: processorPayment.processorRedirectUrl,
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
        provider_events: [],
      };
    },
    async getAccountPayment(paymentId, accountId) {
      const payment = await getAccountPayment(deps.db, paymentId, accountId);
      if (!payment) {
        return null;
      }
      const providerEvents = await listPaymentProviderEvents(deps.db, {
        providerName: payment.processor_name,
        providerObjectReference: payment.processor_payment_reference,
        internalPaymentId: payment.payment_id,
      });
      return exposePayment(payment, providerEvents);
    },
    getProviderEvent: (params) => getPaymentProviderEvent(deps.db, params),
    listProviderIdempotencyKeys: (params) =>
      listPaymentProviderIdempotencyKeys(deps.db, params),
    listPaymentsNeedingReconciliation: (params) =>
      listPaymentsNeedingReconciliation(deps.db, params),
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
        providerObjectReference:
          webhookEvent.internalPaymentId ?? webhookEvent.processorPaymentReference,
      });
      if (!isNewProviderEvent) {
        return { received: true, ignored: true };
      }

      const payment = webhookEvent.internalPaymentId
        ? await getPaymentById(deps.db, webhookEvent.internalPaymentId)
        : await getPaymentByProcessorReference(
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
        case "payment-refunded":
        case "payment-disputed":
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
