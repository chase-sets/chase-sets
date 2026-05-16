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
  addMoney,
  compareMoney,
  normalizeCurrencyCode,
  normalizeMoneyAmount,
  normalizeOrderIds,
  normalizeRequiredText,
  PaymentsDomainError,
  subtractMoney,
} from "../../../support/runtime-support/common";
import { checkoutUnavailableReasonLabel } from "./reason-codes";
import type {
  AgenticProcessorPaymentInput,
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
  listPaymentReconciliationRuns,
  listPaymentsNeedingReconciliation,
  recordPaymentReconciliationRun,
  recordPaymentProviderIdempotencyKey,
  getPaymentBySource,
  type PaymentDetailRow,
  type PaymentProviderIdempotencyKeyRow,
  type PaymentReconciliationRunRow,
  type PaymentProviderEventRow,
} from "../read-model/queries";
import {
  decidePayment,
  evolvePayment,
  initialPaymentState,
  type PaymentCommand,
  type PaymentEvent,
  type PaymentState,
  type SellerPayoutComponent,
} from "../domain/domain";

type PaymentRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  processorGateway: PaymentProcessorGateway;
  balanceCreditResolver?: BalanceCreditResolver;
}>;

type CheckoutStatusResult = Readonly<{
  order_ids: readonly string[];
  currency_code: string;
  amount: string;
  marketplace_checkout_fee: MarketplaceCheckoutFeeQuote;
  payment_method_quotes: readonly MarketplaceCheckoutFeeQuote[];
  wallet_credit: Readonly<{
    requested_amount: string;
    applied_amount: string;
    external_amount: string;
  }>;
  can_start_payment: boolean;
  unavailable_reasons: readonly string[];
  unavailable_reason_details: readonly Readonly<{
    code: string;
    message: string;
  }>[];
}>;

type PaymentMethodCategory = "card" | "bank-account" | "platform-credit";

type MarketplaceCheckoutFeeQuote = Readonly<{
  payment_method_category: PaymentMethodCategory;
  external_basis_amount: string;
  marketplace_checkout_fee_amount: string;
  marketplace_checkout_fee_reduction_amount: string;
  total_amount: string;
  processor_amount: string;
  policy_version: string;
  quote_fingerprint: string;
  quoted_at: string;
}>;

type MarketplaceCheckoutFeePolicy = Readonly<{
  policy_version: string;
  effective_at: string;
  enabled_jurisdictions: readonly string[];
  base: Readonly<{
    percentage_bps: number;
    fixed_amount: string;
  }>;
  method_adjustments: readonly Readonly<{
    payment_method_category: PaymentMethodCategory;
    percentage_bps_delta: number;
    fixed_amount_delta: string;
    resulting_percentage_bps: number;
    resulting_fixed_amount: string;
  }>[];
  unsupported_methods_default: "no-positive-fee";
  quote_audit: Readonly<{
    confirmation_required: true;
    stale_response_code: 409;
    stale_response_error: "fee_quote_stale";
    snapshot_fields: readonly string[];
  }>;
}>;

function checkoutRecoveryReference(
  params: Readonly<{
    accountId: AccountId;
    orderIds: readonly OrderId[];
    currencyCode: string;
    requestedBalanceCreditAmount: string;
    paymentMethodCategory: string;
  }>,
) {
  return [
    params.accountId,
    [...params.orderIds].sort().join(","),
    params.currencyCode,
    params.requestedBalanceCreditAmount,
    params.paymentMethodCategory,
  ].join(":");
}

function resolvePaymentReturnPath(value: string | null | undefined, paymentId: PaymentId) {
  const fallback = `/account/payments/${paymentId}`;
  const raw = value?.trim();
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) {
    return fallback;
  }

  return raw
    .replaceAll(":paymentId", paymentId)
    .replaceAll("{paymentId}", paymentId);
}

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
    marketplace_sales_fee_amount: string;
    marketplace_checkout_fee_amount: string;
    seller_net_amount: string;
    seller_payout_amount: string;
  }>[],
  fieldName:
    | "marketplace_sales_fee_amount"
    | "marketplace_checkout_fee_amount"
    | "seller_net_amount"
    | "seller_payout_amount",
) {
  return orders
    .reduce(
      (sum, order) =>
        sum +
        Number.parseFloat(
          normalizeMoneyAmount(order[fieldName] ?? order.seller_net_amount, {
            fieldName,
            allowZero: true,
          }),
        ),
      0,
    )
    .toFixed(2);
}

function buildSellerPayoutComponents(
  orders: readonly Readonly<{
    order_id: string;
    seller_account_id: string;
    seller_net_amount: string;
    seller_item_net_amount: string;
    shipping_allowance_amount: string;
    seller_shipping_payout_amount: string;
    seller_payout_amount: string;
  }>[],
): SellerPayoutComponent[] {
  return orders.flatMap((order) => {
    if (!order.seller_account_id) {
      return [];
    }
    return [{
      orderId: order.order_id as OrderId,
      sellerAccountId: order.seller_account_id as AccountId,
      sellerItemNetAmount: normalizeMoneyAmount(order.seller_item_net_amount ?? order.seller_net_amount, {
        fieldName: "Seller item net amount",
        allowZero: true,
      }),
      shippingAllowanceAmount: normalizeMoneyAmount(order.shipping_allowance_amount ?? "0.00", {
        fieldName: "Shipping allowance amount",
        allowZero: true,
      }),
      sellerShippingPayoutAmount: normalizeMoneyAmount(
        order.seller_shipping_payout_amount ?? order.shipping_allowance_amount ?? "0.00",
        {
          fieldName: "Seller shipping payout amount",
          allowZero: true,
        },
      ),
      sellerPayoutAmount: normalizeMoneyAmount(order.seller_payout_amount ?? order.seller_net_amount, {
        fieldName: "Seller payout amount",
        allowZero: true,
      }),
    }];
  });
}

function normalizePaymentMethodCategory(value: string | null | undefined): PaymentMethodCategory {
  switch ((value ?? "card").trim()) {
    case "bank-account":
    case "bank_account":
    case "bank":
      return "bank-account";
    case "platform-credit":
    case "platform_credit":
    case "credit":
      return "platform-credit";
    default:
      return "card";
  }
}

function ceilMoneyAmount(value: number) {
  if (value <= 0) {
    return "0.00";
  }
  return (Math.ceil((value + Number.EPSILON) * 100) / 100).toFixed(2);
}

function quoteMarketplaceCheckoutFee(params: Readonly<{
  orderAmount: string;
  externalBasisAmount: string;
  balanceCreditAmount: string;
  paymentMethodCategory: PaymentMethodCategory;
  quotedAt?: string;
}>): MarketplaceCheckoutFeeQuote {
  const policyVersion = "marketplace-checkout-fee-v1";
  const externalBasis = Number.parseFloat(
    normalizeMoneyAmount(params.externalBasisAmount, {
      fieldName: "External payment amount",
      allowZero: true,
    }),
  );
  const method =
    externalBasis === 0 ? "platform-credit" : params.paymentMethodCategory;
  const rateBps =
    method === "platform-credit" ? 0 : method === "bank-account" ? 50 : 290;
  const fixedAmount = method === "card" ? 0.3 : 0;
  const rate = rateBps / 10_000;
  const feeAmount = rate > 0 || fixedAmount > 0
    ? ceilMoneyAmount((externalBasis * rate + fixedAmount) / (1 - rate))
    : "0.00";
  const cardFeeAmount =
    externalBasis > 0
      ? ceilMoneyAmount((externalBasis * 0.029 + 0.3) / (1 - 0.029))
      : "0.00";
  const reductionAmount = ceilMoneyAmount(
    Number.parseFloat(cardFeeAmount) - Number.parseFloat(feeAmount),
  );
  const totalAmount = addMoney(params.orderAmount, feeAmount);
  const processorAmount = addMoney(params.externalBasisAmount, feeAmount);
  const quotedAt = params.quotedAt ?? new Date().toISOString();
  const quoteFingerprint = [
    policyVersion,
    method,
    params.orderAmount,
    params.balanceCreditAmount,
    params.externalBasisAmount,
    feeAmount,
    totalAmount,
    processorAmount,
  ].join("|");

  return {
    payment_method_category: method,
    external_basis_amount: Number.parseFloat(params.externalBasisAmount).toFixed(2),
    marketplace_checkout_fee_amount: feeAmount,
    marketplace_checkout_fee_reduction_amount: reductionAmount,
    total_amount: totalAmount,
    processor_amount: processorAmount,
    policy_version: policyVersion,
    quote_fingerprint: quoteFingerprint,
    quoted_at: quotedAt,
  };
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
      paymentMethodCategory?: string | null;
      marketplaceCheckoutFeeQuoteFingerprint?: string | null;
      returnUrlBase?: string | null;
      returnUrlPath?: string | null;
      clientRiskContext?: Readonly<{
        ipAddress?: string | null;
        userAgent?: string | null;
      }> | null;
      agenticPayment?: AgenticProcessorPaymentInput["agenticPayment"] | null;
    }>,
    context: EventStoreContext,
  ) => Promise<PaymentDetailRow & Readonly<{
    processor_publishable_key: string | null;
    provider_events: readonly PaymentProviderEventRow[];
  }>>;
  recoverCheckoutPayment: (
    params: Readonly<{
      accountId: AccountId;
      orderIds: readonly OrderId[];
      currencyCode?: string;
      requestedBalanceCreditAmount?: string | null;
      paymentMethodCategory?: string | null;
      marketplaceCheckoutFeeQuoteFingerprint?: string | null;
      returnUrlBase?: string | null;
      returnUrlPath?: string | null;
      clientRiskContext?: Readonly<{
        ipAddress?: string | null;
        userAgent?: string | null;
      }> | null;
      agenticPayment?: AgenticProcessorPaymentInput["agenticPayment"] | null;
    }>,
    context: EventStoreContext,
  ) => Promise<PaymentDetailRow & Readonly<{
    processor_publishable_key: string | null;
    provider_events: readonly PaymentProviderEventRow[];
  }>>;
  getCheckoutRecoveryOptions: (
    params: Readonly<{
      accountId: AccountId;
      orderIds: readonly OrderId[];
      currencyCode?: string;
      requestedBalanceCreditAmount?: string | null;
      paymentMethodCategory?: string | null;
    }>,
  ) => Promise<Readonly<{
    recovery_reference_id: string;
    can_recover: boolean;
    recommended_action: "start-payment" | "use-existing-payment" | "unavailable";
    checkout_status: CheckoutStatusResult;
  }>>;
  getAccountPayment: (
    paymentId: string,
    accountId: string,
  ) => Promise<(PaymentDetailRow & Readonly<{
    processor_publishable_key: string | null;
    provider_events: readonly PaymentProviderEventRow[];
  }>) | null>;
  getPaymentMoneyTimeline: (
    params: Readonly<{ paymentId: string; accountId: string }>,
  ) => Promise<Readonly<{
    payment_id: string;
    account_id: string;
    items: readonly Readonly<{
      occurred_at: string;
      kind: string;
      label: string;
      reference: string | null;
      amount: string | null;
      currency_code: string | null;
    }>[];
  }> | null>;
  getCheckoutStatus: (
    params: Readonly<{
      accountId: AccountId;
      orderIds: readonly OrderId[];
      currencyCode?: string;
      requestedBalanceCreditAmount?: string | null;
      paymentMethodCategory?: string | null;
    }>,
  ) => Promise<CheckoutStatusResult>;
  getMarketplaceCheckoutFeePolicy: () => Promise<MarketplaceCheckoutFeePolicy>;
  getProviderEvent: (
    params: Readonly<{ providerEventId: string; accountId: string }>,
  ) => Promise<PaymentProviderEventRow | null>;
  listProviderIdempotencyKeys: (
    params: Readonly<{ accountId: string; limit?: number }>,
  ) => Promise<PaymentProviderIdempotencyKeyRow[]>;
  listPaymentsNeedingReconciliation: (
    params?: Readonly<{ limit?: number; claimOwnerId?: string; claimTtlMs?: number }>,
  ) => Promise<PaymentDetailRow[]>;
  listReconciliationRuns: (
    params?: Readonly<{ limit?: number }>,
  ) => Promise<PaymentReconciliationRunRow[]>;
  getProviderHealth: () => Promise<Readonly<{
    provider_name: string;
    confirmation_experience: PaymentProcessorPublicConfig["confirmationExperience"];
    dynamic_payment_methods: boolean;
    sensitive_payment_details_handled_by_provider: boolean;
    webhook_signature_required: boolean;
  }>>;
  scanPaymentsNeedingReconciliation: (
    params?: Readonly<{ limit?: number; claimOwnerId?: string; claimTtlMs?: number }>,
  ) => Promise<Readonly<{ checked: number; attention: number; payment_ids: readonly string[] }>>;
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
      const paymentMethodCategory = normalizePaymentMethodCategory(
        params.paymentMethodCategory,
      );
      const paymentMethodQuotes = (["card", "bank-account", "platform-credit"] as const)
        .map((method) =>
          quoteMarketplaceCheckoutFee({
            orderAmount: amount,
            externalBasisAmount: externalAmount,
            balanceCreditAmount: appliedAmount,
            paymentMethodCategory: method,
          }),
        );
      const marketplaceCheckoutFee =
        paymentMethodQuotes.find(
          (quote) => quote.payment_method_category === paymentMethodCategory,
        ) ?? paymentMethodQuotes[0]!;

      return {
        order_ids: orderIds,
        currency_code: currencyCode,
        amount,
        marketplace_checkout_fee: marketplaceCheckoutFee,
        payment_method_quotes: paymentMethodQuotes,
        wallet_credit: {
          requested_amount: balanceCredit.requestedAmount,
          applied_amount: appliedAmount,
          external_amount: externalAmount,
        },
        can_start_payment: compareMoney(amount, "0.00") > 0,
        unavailable_reasons:
          compareMoney(amount, "0.00") > 0 ? [] : ["no-payable-order-balance"],
        unavailable_reason_details:
          compareMoney(amount, "0.00") > 0
            ? []
            : [
                {
                  code: "no-payable-order-balance",
                  message: checkoutUnavailableReasonLabel("no-payable-order-balance"),
                },
              ],
      };
    },
    async getMarketplaceCheckoutFeePolicy() {
      return {
        policy_version: "marketplace-checkout-fee-v1",
        effective_at: "2026-05-03T00:00:00.000Z",
        enabled_jurisdictions: ["US"],
        base: {
          percentage_bps: 290,
          fixed_amount: "0.30",
        },
        method_adjustments: [
          {
            payment_method_category: "card",
            percentage_bps_delta: 0,
            fixed_amount_delta: "0.00",
            resulting_percentage_bps: 290,
            resulting_fixed_amount: "0.30",
          },
          {
            payment_method_category: "bank-account",
            percentage_bps_delta: -240,
            fixed_amount_delta: "-0.30",
            resulting_percentage_bps: 50,
            resulting_fixed_amount: "0.00",
          },
          {
            payment_method_category: "platform-credit",
            percentage_bps_delta: -290,
            fixed_amount_delta: "-0.30",
            resulting_percentage_bps: 0,
            resulting_fixed_amount: "0.00",
          },
        ],
        unsupported_methods_default: "no-positive-fee",
        quote_audit: {
          confirmation_required: true,
          stale_response_code: 409,
          stale_response_error: "fee_quote_stale",
          snapshot_fields: [
            "marketplace_checkout_fee_amount",
            "marketplace_checkout_fee_policy_version",
            "marketplace_checkout_fee_quote_fingerprint",
            "payment_method_category",
          ],
        },
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
      const externalBasisAmount = normalizeMoneyAmount(
        balanceCredit.remainingExternalAmount || subtractMoney(amount, balanceCreditAmount),
        {
          fieldName: "External payment amount",
          allowZero: true,
        },
      );
      if (compareMoney(balanceCreditAmount, amount) > 0) {
        throw new PaymentsDomainError("Balance credit cannot exceed the payment amount.");
      }
      const paymentMethodCategory = normalizePaymentMethodCategory(
        params.paymentMethodCategory,
      );
      if (
        paymentMethodCategory === "platform-credit" &&
        compareMoney(externalBasisAmount, "0.00") > 0
      ) {
        throw new PaymentsDomainError(
          "Platform credit must cover the order balance before it can be used as the payment method.",
        );
      }
      const marketplaceCheckoutFeeQuote = quoteMarketplaceCheckoutFee({
        orderAmount: amount,
        externalBasisAmount,
        balanceCreditAmount,
        paymentMethodCategory,
      });
      if (
        params.marketplaceCheckoutFeeQuoteFingerprint !==
        marketplaceCheckoutFeeQuote.quote_fingerprint
      ) {
        throw new PaymentsDomainError(
          `fee_quote_stale:${JSON.stringify(marketplaceCheckoutFeeQuote)}`,
        );
      }
      const paymentAmount = marketplaceCheckoutFeeQuote.total_amount;
      const processorAmount = marketplaceCheckoutFeeQuote.processor_amount;
      const marketplaceSalesFeeAmount = sumFeeAmounts(orders, "marketplace_sales_fee_amount");
      const marketplaceCheckoutFeeAmount =
        marketplaceCheckoutFeeQuote.marketplace_checkout_fee_amount;
      const sellerNetAmount = sumFeeAmounts(orders, "seller_net_amount");
      const sellerPayoutAmount = sumFeeAmounts(orders, "seller_payout_amount");
      const sellerPayouts = buildSellerPayoutComponents(orders);
      const paymentId = createId("pay") as PaymentId;
      const returnUrlBase = params.returnUrlBase?.trim().replace(/\/+$/, "") ?? "";
      const returnUrlPath = resolvePaymentReturnPath(
        params.returnUrlPath,
        paymentId,
      );
      const providerIdempotencyKey = `payments:payment:${paymentId}:create`;
      const createAgenticPaymentSession =
        deps.processorGateway.createAgenticPaymentSession?.bind(deps.processorGateway);
      if (params.agenticPayment && !createAgenticPaymentSession) {
        throw new PaymentsDomainError(
          "Agentic payment handoff is not supported by the configured payment processor.",
        );
      }
      const processorPayment = compareMoney(processorAmount, "0.00") === 0
        ? {
            processorName: publicConfig.processorName,
            processorPaymentKind: "balance-credit" as const,
            processorPaymentReference: `balance-credit:${paymentId}`,
            processorClientSecret: null,
            processorRedirectUrl: null,
            processorStatus: "balance-credit-captured",
          }
        : params.agenticPayment
          ? await createAgenticPaymentSession!({
              paymentId,
              buyerAccountId: accountId,
              orderIds,
              amount: processorAmount,
              currencyCode,
              paymentMethodCategory,
              description:
                orderIds.length === 1
                  ? `Chase Sets order ${orderIds[0]}`
                  : `Chase Sets checkout for ${orderIds.length} orders`,
              returnUrl: returnUrlBase
                ? `${returnUrlBase}${returnUrlPath}`
                : null,
              idempotencyKey: providerIdempotencyKey,
              clientRiskContext: params.clientRiskContext ?? null,
              agenticPayment: params.agenticPayment,
            })
        : await deps.processorGateway.createPaymentSession({
            paymentId,
            buyerAccountId: accountId,
            orderIds,
            amount: processorAmount,
            currencyCode,
            paymentMethodCategory,
            description:
              orderIds.length === 1
                ? `Chase Sets order ${orderIds[0]}`
                : `Chase Sets checkout for ${orderIds.length} orders`,
            returnUrl: returnUrlBase
              ? `${returnUrlBase}${returnUrlPath}`
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
          amount: paymentAmount,
          balanceCreditAmount,
          processorAmount,
          marketplaceSalesFeeAmount,
          marketplaceCheckoutFeeAmount,
          marketplaceCheckoutFeePolicyVersion: marketplaceCheckoutFeeQuote.policy_version,
          marketplaceCheckoutFeeQuoteFingerprint: marketplaceCheckoutFeeQuote.quote_fingerprint,
          paymentMethodCategory,
          sellerNetAmount,
          sellerPayoutAmount,
          sellerPayouts,
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
        amount: paymentAmount,
        balance_credit_amount: balanceCreditAmount,
        processor_amount: processorAmount,
        marketplace_sales_fee_amount: marketplaceSalesFeeAmount,
        marketplace_checkout_fee_amount: marketplaceCheckoutFeeAmount,
        marketplace_checkout_fee_policy_version:
          marketplaceCheckoutFeeQuote.policy_version,
        marketplace_checkout_fee_quote_fingerprint:
          marketplaceCheckoutFeeQuote.quote_fingerprint,
        payment_method_category: marketplaceCheckoutFeeQuote.payment_method_category,
        seller_net_amount: sellerNetAmount,
        seller_payout_amount: sellerPayoutAmount,
        seller_payouts: sellerPayouts,
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
    recoverCheckoutPayment(params, context) {
      const orderIds = normalizeOrderIds(params.orderIds);
      const currencyCode = normalizeCurrencyCode(params.currencyCode ?? "usd");
      const requestedBalanceCreditAmount = normalizeMoneyAmount(
        params.requestedBalanceCreditAmount ?? "0.00",
        {
          fieldName: "Balance credit amount",
          allowZero: true,
        },
      );
      return this.createAccountPayment(
        {
          ...params,
          orderIds,
          currencyCode,
          requestedBalanceCreditAmount,
          paymentMethodCategory: normalizePaymentMethodCategory(
            params.paymentMethodCategory,
          ),
          agenticPayment: params.agenticPayment ?? null,
          sourceContext: "checkout-recovery",
          sourceReferenceId: checkoutRecoveryReference({
            accountId: params.accountId,
            orderIds,
            currencyCode,
            requestedBalanceCreditAmount,
            paymentMethodCategory: normalizePaymentMethodCategory(
              params.paymentMethodCategory,
            ),
          }),
        },
        context,
      );
    },
    async getCheckoutRecoveryOptions(params) {
      const accountId = normalizeRequiredText(
        params.accountId,
        "Account is required.",
      ) as AccountId;
      const orderIds = normalizeOrderIds(params.orderIds);
      const currencyCode = normalizeCurrencyCode(params.currencyCode ?? "usd");
      const requestedBalanceCreditAmount = normalizeMoneyAmount(
        params.requestedBalanceCreditAmount ?? "0.00",
        {
          fieldName: "Balance credit amount",
          allowZero: true,
        },
      );
      const checkoutStatus = await this.getCheckoutStatus({
        accountId,
        orderIds,
        currencyCode,
        requestedBalanceCreditAmount,
        paymentMethodCategory: params.paymentMethodCategory,
      });
      const recoveryReferenceId = checkoutRecoveryReference({
        accountId,
        orderIds,
        currencyCode,
        requestedBalanceCreditAmount,
        paymentMethodCategory: normalizePaymentMethodCategory(
          params.paymentMethodCategory,
        ),
      });
      const existing = await getPaymentBySource(
        deps.db,
        "checkout-recovery",
        recoveryReferenceId,
        accountId,
      );

      return {
        recovery_reference_id: recoveryReferenceId,
        can_recover: checkoutStatus.can_start_payment,
        recommended_action: existing
          ? "use-existing-payment"
          : checkoutStatus.can_start_payment
            ? "start-payment"
            : "unavailable",
        checkout_status: checkoutStatus,
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
    async getPaymentMoneyTimeline(params) {
      const payment = await getAccountPayment(
        deps.db,
        params.paymentId,
        params.accountId,
      );
      if (!payment) {
        return null;
      }
      const [providerEvents, idempotencyKeys] = await Promise.all([
        listPaymentProviderEvents(deps.db, {
          providerName: payment.processor_name,
          providerObjectReference: payment.processor_payment_reference,
          internalPaymentId: payment.payment_id,
        }),
        listPaymentProviderIdempotencyKeys(deps.db, {
          accountId: params.accountId,
          limit: 100,
        }),
      ]);
      const items = [
        {
          occurred_at: payment.created_at,
          kind: "payment-created",
          label: "Payment started",
          reference: payment.payment_id,
          amount: payment.amount,
          currency_code: payment.currency_code,
        },
        ...idempotencyKeys
          .filter(
            (entry) =>
              entry.provider_object_reference === payment.processor_payment_reference ||
              entry.operation_key.includes(payment.payment_id),
          )
          .map((entry) => ({
            occurred_at: entry.created_at,
            kind: entry.operation_kind,
            label: "Provider operation submitted",
            reference: entry.provider_object_reference ?? entry.operation_key,
            amount: null,
            currency_code: null,
          })),
        ...providerEvents.map((event) => ({
          occurred_at: event.received_at,
          kind: event.event_kind,
          label: "Provider event received",
          reference: event.provider_event_id,
          amount: null,
          currency_code: null,
        })),
        ...(payment.captured_at
          ? [
              {
                occurred_at: payment.captured_at,
                kind: "payment-captured",
                label: "Payment captured",
                reference: payment.processor_payment_reference,
                amount: payment.amount,
                currency_code: payment.currency_code,
              },
            ]
          : []),
        ...(payment.failed_at
          ? [
              {
                occurred_at: payment.failed_at,
                kind: "payment-failed",
                label: "Payment failed",
                reference: payment.processor_payment_reference,
                amount: payment.amount,
                currency_code: payment.currency_code,
              },
            ]
          : []),
      ].sort((left, right) =>
        left.occurred_at.localeCompare(right.occurred_at),
      );

      return {
        payment_id: payment.payment_id,
        account_id: payment.buyer_account_id,
        items,
      };
    },
    getProviderEvent: (params) => getPaymentProviderEvent(deps.db, params),
    listProviderIdempotencyKeys: (params) =>
      listPaymentProviderIdempotencyKeys(deps.db, params),
    listPaymentsNeedingReconciliation: (params) =>
      listPaymentsNeedingReconciliation(deps.db, params),
    listReconciliationRuns: (params) =>
      listPaymentReconciliationRuns(deps.db, params),
    async getProviderHealth() {
      return {
        provider_name: publicConfig.processorName,
        confirmation_experience: publicConfig.confirmationExperience,
        dynamic_payment_methods: publicConfig.dynamicPaymentMethods,
        sensitive_payment_details_handled_by_provider:
          publicConfig.sensitivePaymentDetailsHandledByProcessor,
        webhook_signature_required: true,
      };
    },
    async scanPaymentsNeedingReconciliation(params) {
      const startedAt = new Date().toISOString();
      const payments = await listPaymentsNeedingReconciliation(deps.db, params);
      const result = {
        checked: payments.length,
        attention: payments.length,
        payment_ids: payments.map((payment) => payment.payment_id),
      };
      await recordPaymentReconciliationRun(deps.db, {
        reconciliationRunId: createId("rec"),
        kind: "payments",
        checked: result.checked,
        attention: result.attention,
        status: "completed",
        summary: result,
        startedAt,
        completedAt: new Date().toISOString(),
      });
      return result;
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
