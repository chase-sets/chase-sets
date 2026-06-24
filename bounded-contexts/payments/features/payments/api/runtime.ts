import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createNoopNotificationOutbox, type NotificationOutbox } from "@chase-sets/notifications";
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
import {
  buildPaymentTransactionalEmailProjectionHandlers,
  PAYMENTS_PAYMENT_TRANSACTIONAL_EMAIL_PROJECTION,
} from "../integrations/transactional-email/transactional-email-projector";
import { buildPaymentProjectionHandlers } from "../read-model/projection";
import {
  getAccountPayment,
  getPaymentById,
  getPaymentByProcessorReference,
  getSavedCheckoutInstrument,
  getSavedCheckoutInstrumentByProviderReference,
  getProviderCustomer,
  getSavedCheckoutSetupSessionByProcessorReference,
  getSavedCheckoutSetupSessionBySetupReference,
  listPaymentProviderEvents,
  listPaymentProviderIdempotencyKeys,
  listPaymentsNeedingReconciliation,
  listSavedCheckoutInstruments,
  completeSavedCheckoutSetupSession,
  markSavedCheckoutInstrumentRemoved,
  recordSavedCheckoutInstrumentAudit,
  recordSavedCheckoutSetupSession,
  recordPaymentReconciliationRun,
  recordPaymentProviderIdempotencyKey,
  recordPaymentProviderOperationFailed,
  recordPaymentProviderOperationPending,
  recordPaymentProviderOperationSucceeded,
  setSavedCheckoutInstrumentDefault,
  upsertProviderCustomer,
  upsertSavedCheckoutInstrument,
  getPaymentBySource,
  type PaymentDetailRow,
  type PaymentProviderEventRow,
  type SavedCheckoutInstrumentRow,
  type ProviderCustomerRow,
  type SavedCheckoutSetupSessionRow,
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
  notificationOutbox?: NotificationOutbox;
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

const SAVE_PAYMENT_CONSENT_TEXT =
  "Save this payment method for future Chase Sets checkout and allow Chase Sets to use it for future purchases I approve.";

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

  return raw.replaceAll(":paymentId", paymentId).replaceAll("{paymentId}", paymentId);
}

function sumOrderAmounts(orders: readonly Readonly<{ total_amount: string }>[]) {
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
    return [
      {
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
      },
    ];
  });
}

function buildMarketplaceRiskMetadata(
  sellerPayouts: readonly SellerPayoutComponent[],
): Record<string, string | number | boolean> {
  const sellerAccountIds = [...new Set(sellerPayouts.map((payout) => payout.sellerAccountId))].sort();
  const maxSellerOrderAmount = sellerPayouts.reduce(
    (max, payout) => Math.max(max, Number.parseFloat(payout.sellerPayoutAmount)),
    0,
  );

  return {
    seller_account_ids: sellerAccountIds.join(","),
    seller_account_count: sellerAccountIds.length,
    max_seller_order_amount: maxSellerOrderAmount.toFixed(2),
    high_dollar_order: maxSellerOrderAmount >= 250,
    fulfillment_required: sellerPayouts.length > 0,
  };
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

function quoteMarketplaceCheckoutFee(
  params: Readonly<{
    orderAmount: string;
    externalBasisAmount: string;
    balanceCreditAmount: string;
    paymentMethodCategory: PaymentMethodCategory;
    quotedAt?: string;
  }>,
): MarketplaceCheckoutFeeQuote {
  const policyVersion = "marketplace-checkout-fee-v1";
  const externalBasis = Number.parseFloat(
    normalizeMoneyAmount(params.externalBasisAmount, {
      fieldName: "External payment amount",
      allowZero: true,
    }),
  );
  const method = externalBasis === 0 ? "platform-credit" : params.paymentMethodCategory;
  const rateBps = method === "platform-credit" ? 0 : method === "bank-account" ? 50 : 290;
  const fixedAmount = method === "card" ? 0.3 : 0;
  const rate = rateBps / 10_000;
  const feeAmount =
    rate > 0 || fixedAmount > 0 ? ceilMoneyAmount((externalBasis * rate + fixedAmount) / (1 - rate)) : "0.00";
  const cardFeeAmount = externalBasis > 0 ? ceilMoneyAmount((externalBasis * 0.029 + 0.3) / (1 - 0.029)) : "0.00";
  const reductionAmount = ceilMoneyAmount(Number.parseFloat(cardFeeAmount) - Number.parseFloat(feeAmount));
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

async function buildCheckoutStatusFromAmount(
  deps: Pick<PaymentRuntimeDeps, "balanceCreditResolver">,
  params: Readonly<{
    accountId: AccountId;
    orderIds: readonly OrderId[];
    amount: string;
    currencyCode: string;
    requestedBalanceCreditAmount?: string | null;
    paymentMethodCategory?: string | null;
  }>,
): Promise<CheckoutStatusResult> {
  const amount = normalizeMoneyAmount(params.amount, {
    fieldName: "Checkout amount",
    allowZero: true,
  });
  const currencyCode = normalizeCurrencyCode(params.currencyCode);
  const requestedBalanceCreditAmount = normalizeMoneyAmount(params.requestedBalanceCreditAmount ?? "0.00", {
    fieldName: "Balance credit amount",
    allowZero: true,
  });
  const balanceCredit = deps.balanceCreditResolver
    ? await deps.balanceCreditResolver.resolveBalanceCredit({
        buyerAccountId: params.accountId,
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
  const paymentMethodCategory = normalizePaymentMethodCategory(params.paymentMethodCategory);
  const paymentMethodQuotes = (["card", "bank-account", "platform-credit"] as const).map((method) =>
    quoteMarketplaceCheckoutFee({
      orderAmount: amount,
      externalBasisAmount: externalAmount,
      balanceCreditAmount: appliedAmount,
      paymentMethodCategory: method,
    }),
  );
  const marketplaceCheckoutFee =
    paymentMethodQuotes.find((quote) => quote.payment_method_category === paymentMethodCategory) ??
    paymentMethodQuotes[0]!;

  return {
    order_ids: params.orderIds,
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
    unavailable_reasons: compareMoney(amount, "0.00") > 0 ? [] : ["no-payable-order-balance"],
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
}

async function loadAccountOrders(db: PgQueryable, orderIds: readonly OrderId[], accountId: AccountId) {
  const orders = await listPaymentOrderInputs(db, orderIds, accountId);
  const ordersById = new Map(orders.map((order) => [order.order_id, order]));

  for (const orderId of orderIds) {
    const order = ordersById.get(orderId);
    if (!order) {
      throw new PaymentsDomainError(`Order ${orderId} was not found.`, "order_input_not_ready");
    }
    if (order.status !== "pending-payment") {
      throw new PaymentsDomainError(
        `Order ${orderId} is not eligible for payment in status ${order.status}.`,
        order.status === "pending-reservation" ? "order_not_payment_ready" : "validation_failed",
      );
    }
  }

  return orders;
}

async function resolveSavedCheckoutInstrument(
  db: PgQueryable,
  params: Readonly<{
    accountId: AccountId;
    instrumentId?: string | null;
    paymentMethodCategory: PaymentMethodCategory;
  }>,
) {
  const instrumentId = params.instrumentId?.trim() || null;
  if (!instrumentId) {
    return null;
  }

  const instrument = await getSavedCheckoutInstrument(db, {
    accountId: params.accountId,
    instrumentId,
  });
  if (!instrument) {
    throw new PaymentsDomainError("Saved checkout instrument was not found for this account.");
  }
  if (instrument.readiness !== "ready") {
    throw new PaymentsDomainError("Saved checkout instrument is not ready for checkout.");
  }
  if (!instrument.provider_customer_reference?.trim() || !instrument.provider_reference?.trim()) {
    throw new PaymentsDomainError("Saved checkout instrument is not backed by a processor payment method.");
  }
  if (instrument.payment_method_category !== params.paymentMethodCategory) {
    throw new PaymentsDomainError("Saved checkout instrument does not match the selected payment method.");
  }

  return instrument;
}

function savedInstrumentIdForProviderReference(providerReference: string) {
  return `sci_${providerReference.replaceAll(/[^a-zA-Z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "")}`;
}

async function ensureProviderCustomer(
  deps: Pick<PaymentRuntimeDeps, "db" | "processorGateway">,
  params: Readonly<{ accountId: AccountId; displayName?: string | null; email?: string | null }>,
): Promise<ProviderCustomerRow> {
  const providerName = deps.processorGateway.getPublicConfiguration().processorName;
  const existing = await getProviderCustomer(deps.db, {
    accountId: params.accountId,
    provider: providerName,
  });
  if (existing) {
    return existing;
  }

  const created = await deps.processorGateway.createCustomer({
    accountId: params.accountId,
    displayName: params.displayName ?? `Chase Sets account ${params.accountId}`,
    email: params.email ?? null,
    idempotencyKey: `payments:account:${params.accountId}:${providerName}:customer`,
  });

  return upsertProviderCustomer(deps.db, {
    accountId: params.accountId,
    provider: created.processorName,
    providerCustomerReference: created.providerCustomerReference,
    displayName: params.displayName ?? null,
    email: params.email ?? null,
  });
}

async function persistProcessorSavedPaymentMethod(
  deps: Pick<PaymentRuntimeDeps, "db" | "processorGateway">,
  params: Readonly<{
    accountId: AccountId;
    providerCustomerReference: string;
    savedPaymentMethod: NonNullable<Awaited<ReturnType<PaymentProcessorGateway["retrieveSavedPaymentMethod"]>>>;
    consentId?: string | null;
    consentText?: string | null;
    isDefault?: boolean;
    auditAction: string;
  }>,
) {
  const instrument = await upsertSavedCheckoutInstrument(deps.db, {
    instrumentId: savedInstrumentIdForProviderReference(params.savedPaymentMethod.providerReference),
    accountId: params.accountId,
    paymentMethodCategory: params.savedPaymentMethod.paymentMethodCategory,
    provider: params.savedPaymentMethod.processorName,
    providerCustomerReference: params.savedPaymentMethod.providerCustomerReference ?? params.providerCustomerReference,
    providerReference: params.savedPaymentMethod.providerReference,
    displayLabel: params.savedPaymentMethod.displayLabel,
    confirmationExperience: "off-session-token",
    readiness: params.savedPaymentMethod.removed ? "removed" : params.savedPaymentMethod.readiness,
    allowRedisplay: params.savedPaymentMethod.allowRedisplay,
    consentId: params.consentId ?? null,
    consentText: params.consentText ?? null,
    isDefault: params.isDefault ?? false,
    removedAt: params.savedPaymentMethod.removed ? new Date().toISOString() : null,
  });
  await recordSavedCheckoutInstrumentAudit(deps.db, {
    auditId: createId("audit"),
    instrumentId: instrument.instrument_id,
    accountId: params.accountId,
    action: params.auditAction,
    reason: params.consentId ?? null,
    performedByAccountId: params.accountId,
  });
  return instrument;
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
      savedCheckoutInstrumentId?: string | null;
      savePaymentMethodForFuture?: boolean;
      returnUrlBase?: string | null;
      returnUrlPath?: string | null;
      clientRiskContext?: Readonly<{
        ipAddress?: string | null;
        userAgent?: string | null;
      }> | null;
      agenticPayment?: AgenticProcessorPaymentInput["agenticPayment"] | null;
    }>,
    context: EventStoreContext,
  ) => Promise<
    PaymentDetailRow &
      Readonly<{
        processor_publishable_key: string | null;
        provider_events: readonly PaymentProviderEventRow[];
      }>
  >;
  recoverCheckoutPayment: (
    params: Readonly<{
      accountId: AccountId;
      orderIds: readonly OrderId[];
      currencyCode?: string;
      requestedBalanceCreditAmount?: string | null;
      paymentMethodCategory?: string | null;
      marketplaceCheckoutFeeQuoteFingerprint?: string | null;
      savedCheckoutInstrumentId?: string | null;
      savePaymentMethodForFuture?: boolean;
      returnUrlBase?: string | null;
      returnUrlPath?: string | null;
      clientRiskContext?: Readonly<{
        ipAddress?: string | null;
        userAgent?: string | null;
      }> | null;
      agenticPayment?: AgenticProcessorPaymentInput["agenticPayment"] | null;
    }>,
    context: EventStoreContext,
  ) => Promise<
    PaymentDetailRow &
      Readonly<{
        processor_publishable_key: string | null;
        provider_events: readonly PaymentProviderEventRow[];
      }>
  >;
  getCheckoutRecoveryOptions: (
    params: Readonly<{
      accountId: AccountId;
      orderIds: readonly OrderId[];
      currencyCode?: string;
      requestedBalanceCreditAmount?: string | null;
      paymentMethodCategory?: string | null;
    }>,
  ) => Promise<
    Readonly<{
      recovery_reference_id: string;
      can_recover: boolean;
      recommended_action: "start-payment" | "use-existing-payment" | "unavailable";
      checkout_status: CheckoutStatusResult;
    }>
  >;
  listSavedCheckoutInstruments: (accountId: AccountId) => Promise<SavedCheckoutInstrumentRow[]>;
  ensureProviderCustomer: (params: Readonly<{ accountId: AccountId }>) => Promise<ProviderCustomerRow>;
  createSavedCheckoutSetupSession: (
    params: Readonly<{ accountId: AccountId; returnUrlBase?: string | null; returnUrlPath?: string | null }>,
  ) => Promise<SavedCheckoutSetupSessionRow>;
  reconcileSavedCheckoutSetupSession: (
    params: Readonly<{ accountId: AccountId; setupReference: string }>,
  ) => Promise<SavedCheckoutInstrumentRow | null>;
  setSavedCheckoutInstrumentDefault: (
    params: Readonly<{ accountId: AccountId; instrumentId: string }>,
  ) => Promise<SavedCheckoutInstrumentRow | null>;
  removeSavedCheckoutInstrument: (
    params: Readonly<{ accountId: AccountId; instrumentId: string }>,
  ) => Promise<SavedCheckoutInstrumentRow | null>;
  reconcileSavedCheckoutInstruments: (
    params: Readonly<{ accountId: AccountId }>,
  ) => Promise<Readonly<{ checked: number; updated: number; removed: number }>>;
  getAccountPayment: (
    paymentId: string,
    accountId: string,
  ) => Promise<
    | (PaymentDetailRow &
        Readonly<{
          processor_publishable_key: string | null;
          provider_events: readonly PaymentProviderEventRow[];
        }>)
    | null
  >;
  getPaymentMoneyTimeline: (params: Readonly<{ paymentId: string; accountId: string }>) => Promise<Readonly<{
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
  previewCheckoutStatus: (
    params: Readonly<{
      accountId: AccountId;
      amount: string;
      currencyCode?: string;
      requestedBalanceCreditAmount?: string | null;
      paymentMethodCategory?: string | null;
    }>,
  ) => Promise<CheckoutStatusResult>;
  getMarketplaceCheckoutFeePolicy: () => Promise<MarketplaceCheckoutFeePolicy>;
  listPaymentsNeedingReconciliation: (
    params?: Readonly<{ limit?: number; claimOwnerId?: string; claimTtlMs?: number }>,
  ) => Promise<PaymentDetailRow[]>;
  scanPaymentsNeedingReconciliation: (
    params?: Readonly<{ limit?: number; claimOwnerId?: string; claimTtlMs?: number }>,
  ) => Promise<Readonly<{ checked: number; attention: number; payment_ids: readonly string[] }>>;
  processWebhook: (
    params: Readonly<{ rawBody: string; signatureHeader: string | null }>,
    context: EventStoreContext,
  ) => Promise<{ received: boolean; ignored: boolean }>;
  publicConfig: PaymentProcessorPublicConfig;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createPaymentRuntime(deps: PaymentRuntimeDeps): PaymentServices {
  const notificationOutbox = deps.notificationOutbox ?? createNoopNotificationOutbox();
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<PaymentEvent>(),
    initialState: () => initialPaymentState,
    evolve: evolvePayment,
    decide: decidePayment,
  });

  const publicConfig = deps.processorGateway.getPublicConfiguration();

  function exposePayment(
    payment: PaymentDetailRow,
    providerEvents: readonly PaymentProviderEventRow[] = [],
  ): PaymentDetailRow &
    Readonly<{
      processor_publishable_key: string | null;
      provider_events: readonly PaymentProviderEventRow[];
    }> {
    const canConfirmWithProcessor = payment.status === "pending-confirmation";
    const canUseProcessorManagedForm = canConfirmWithProcessor && Boolean(payment.processor_client_secret);

    return {
      ...payment,
      processor_client_secret: canUseProcessorManagedForm ? payment.processor_client_secret : null,
      processor_redirect_url: canConfirmWithProcessor ? payment.processor_redirect_url : null,
      processor_publishable_key: canUseProcessorManagedForm ? publicConfig.publishableKey : null,
      provider_events: providerEvents,
    };
  }

  return {
    commandHandler,
    async getCheckoutStatus(params) {
      const accountId = normalizeRequiredText(params.accountId, "Account is required.") as AccountId;
      const orderIds = normalizeOrderIds(params.orderIds);
      const orders = await loadAccountOrders(deps.db, orderIds, accountId);
      const amount = sumOrderAmounts(orders);
      return buildCheckoutStatusFromAmount(deps, {
        accountId,
        orderIds,
        amount,
        currencyCode: params.currencyCode ?? "usd",
        requestedBalanceCreditAmount: params.requestedBalanceCreditAmount,
        paymentMethodCategory: params.paymentMethodCategory,
      });
    },
    async previewCheckoutStatus(params) {
      const accountId = normalizeRequiredText(params.accountId, "Account is required.") as AccountId;
      return buildCheckoutStatusFromAmount(deps, {
        accountId,
        orderIds: [],
        amount: params.amount,
        currencyCode: params.currencyCode ?? "usd",
        requestedBalanceCreditAmount: params.requestedBalanceCreditAmount,
        paymentMethodCategory: params.paymentMethodCategory,
      });
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
    listSavedCheckoutInstruments: (accountId) => listSavedCheckoutInstruments(deps.db, accountId),
    ensureProviderCustomer: (params) => ensureProviderCustomer(deps, params),
    async createSavedCheckoutSetupSession(params) {
      const accountId = normalizeRequiredText(params.accountId, "Account is required.") as AccountId;
      const customer = await ensureProviderCustomer(deps, { accountId });
      const setupReferenceId = createId("scs");
      const returnUrlBase = params.returnUrlBase?.trim().replace(/\/+$/, "") ?? "";
      const returnUrlPath = params.returnUrlPath?.trim() || "/account/payment-methods";
      const returnUrl = returnUrlPath.includes("?")
        ? `${returnUrlPath}&setupReferenceId=${encodeURIComponent(setupReferenceId)}`
        : `${returnUrlPath}?setupReferenceId=${encodeURIComponent(setupReferenceId)}`;
      const consentId = createId("consent");
      const setupSession = await deps.processorGateway.createSetupSession({
        accountId,
        providerCustomerReference: customer.provider_customer_reference,
        currencyCode: "usd",
        returnUrl: returnUrlBase ? `${returnUrlBase}${returnUrl}` : null,
        consentId,
        consentText: SAVE_PAYMENT_CONSENT_TEXT,
        idempotencyKey: `payments:account:${accountId}:setup:${setupReferenceId}`,
      });

      return recordSavedCheckoutSetupSession(deps.db, {
        setupReferenceId,
        accountId,
        provider: setupSession.processorName,
        providerCustomerReference: customer.provider_customer_reference,
        processorSetupReference: setupSession.processorSetupReference,
        processorClientSecret: setupSession.processorClientSecret,
        processorRedirectUrl: setupSession.processorRedirectUrl,
        processorStatus: setupSession.processorStatus,
        consentId,
        consentText: SAVE_PAYMENT_CONSENT_TEXT,
      });
    },
    async reconcileSavedCheckoutSetupSession(params) {
      const accountId = normalizeRequiredText(params.accountId, "Account is required.") as AccountId;
      const setupReference = normalizeRequiredText(params.setupReference, "Setup reference is required.");
      const setupSession =
        (await getSavedCheckoutSetupSessionByProcessorReference(deps.db, setupReference)) ??
        (await getSavedCheckoutSetupSessionBySetupReference(deps.db, setupReference));
      if (!setupSession || setupSession.account_id !== accountId) {
        return null;
      }
      const result = await deps.processorGateway.retrieveSetupSessionResult(setupSession.processor_setup_reference);
      await completeSavedCheckoutSetupSession(deps.db, {
        processorSetupReference: setupSession.processor_setup_reference,
        processorStatus: result.processorStatus,
      });
      if (!result.savedPaymentMethod) {
        return null;
      }

      return persistProcessorSavedPaymentMethod(deps, {
        accountId,
        providerCustomerReference: setupSession.provider_customer_reference,
        savedPaymentMethod: result.savedPaymentMethod,
        consentId: setupSession.consent_id,
        consentText: setupSession.consent_text,
        isDefault: true,
        auditAction: "setup-completed",
      });
    },
    async setSavedCheckoutInstrumentDefault(params) {
      const accountId = normalizeRequiredText(params.accountId, "Account is required.") as AccountId;
      const instrument = await getSavedCheckoutInstrument(deps.db, {
        accountId,
        instrumentId: normalizeRequiredText(params.instrumentId, "Saved payment method is required."),
      });
      if (!instrument || instrument.readiness === "removed") {
        return null;
      }
      await setSavedCheckoutInstrumentDefault(deps.db, {
        accountId,
        instrumentId: instrument.instrument_id,
      });
      await recordSavedCheckoutInstrumentAudit(deps.db, {
        auditId: createId("audit"),
        instrumentId: instrument.instrument_id,
        accountId,
        action: "set-default",
        performedByAccountId: accountId,
      });
      return getSavedCheckoutInstrument(deps.db, { accountId, instrumentId: instrument.instrument_id });
    },
    async removeSavedCheckoutInstrument(params) {
      const accountId = normalizeRequiredText(params.accountId, "Account is required.") as AccountId;
      const instrument = await getSavedCheckoutInstrument(deps.db, {
        accountId,
        instrumentId: normalizeRequiredText(params.instrumentId, "Saved payment method is required."),
      });
      if (!instrument) {
        return null;
      }
      if (instrument.provider_reference) {
        await deps.processorGateway.detachSavedPaymentMethod(instrument.provider_reference);
      }
      await markSavedCheckoutInstrumentRemoved(deps.db, {
        accountId,
        instrumentId: instrument.instrument_id,
      });
      await recordSavedCheckoutInstrumentAudit(deps.db, {
        auditId: createId("audit"),
        instrumentId: instrument.instrument_id,
        accountId,
        action: "removed",
        performedByAccountId: accountId,
      });
      return getSavedCheckoutInstrument(deps.db, { accountId, instrumentId: instrument.instrument_id });
    },
    async reconcileSavedCheckoutInstruments(params) {
      const accountId = normalizeRequiredText(params.accountId, "Account is required.") as AccountId;
      const instruments = await listSavedCheckoutInstruments(deps.db, accountId);
      let updated = 0;
      let removed = 0;
      for (const instrument of instruments.filter(
        (entry) => entry.provider_reference && entry.readiness !== "removed",
      )) {
        const providerMethod = await deps.processorGateway.retrieveSavedPaymentMethod(instrument.provider_reference);
        if (!providerMethod || providerMethod.removed) {
          await markSavedCheckoutInstrumentRemoved(deps.db, { accountId, instrumentId: instrument.instrument_id });
          removed += 1;
          updated += 1;
          continue;
        }
        await upsertSavedCheckoutInstrument(deps.db, {
          instrumentId: instrument.instrument_id,
          accountId,
          paymentMethodCategory: providerMethod.paymentMethodCategory,
          provider: providerMethod.processorName,
          providerCustomerReference: providerMethod.providerCustomerReference ?? instrument.provider_customer_reference,
          providerReference: providerMethod.providerReference,
          displayLabel: providerMethod.displayLabel,
          confirmationExperience: instrument.confirmation_experience,
          readiness: providerMethod.readiness,
          allowRedisplay: providerMethod.allowRedisplay,
          consentId: instrument.consent_id,
          consentText: instrument.consent_text,
          isDefault: instrument.is_default,
        });
        updated += 1;
      }

      return { checked: instruments.length, updated, removed };
    },
    async createAccountPayment(params, context) {
      const accountId = normalizeRequiredText(params.accountId, "Account is required.") as AccountId;
      const sourceContext = params.sourceContext?.trim() || null;
      const sourceReferenceId = params.sourceReferenceId?.trim() || null;
      if (sourceContext && sourceReferenceId) {
        const existing = await getPaymentBySource(deps.db, sourceContext, sourceReferenceId, accountId);
        if (existing) {
          return exposePayment(existing);
        }
      }
      const orderIds = normalizeOrderIds(params.orderIds);
      const orders = await loadAccountOrders(deps.db, orderIds, accountId);
      const amount = sumOrderAmounts(orders);
      const currencyCode = normalizeCurrencyCode(params.currencyCode ?? "usd");
      const requestedBalanceCreditAmount = normalizeMoneyAmount(params.requestedBalanceCreditAmount ?? "0.00", {
        fieldName: "Balance credit amount",
        allowZero: true,
      });
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
      const paymentMethodCategory = normalizePaymentMethodCategory(params.paymentMethodCategory);
      if (paymentMethodCategory === "platform-credit" && compareMoney(externalBasisAmount, "0.00") > 0) {
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
      if (params.marketplaceCheckoutFeeQuoteFingerprint !== marketplaceCheckoutFeeQuote.quote_fingerprint) {
        throw new PaymentsDomainError(`fee_quote_stale:${JSON.stringify(marketplaceCheckoutFeeQuote)}`);
      }
      const savedCheckoutInstrument = await resolveSavedCheckoutInstrument(deps.db, {
        accountId,
        instrumentId: params.savedCheckoutInstrumentId,
        paymentMethodCategory,
      });
      const shouldSavePaymentMethod =
        Boolean(params.savePaymentMethodForFuture) &&
        !savedCheckoutInstrument &&
        !params.agenticPayment &&
        paymentMethodCategory !== "platform-credit" &&
        compareMoney(externalBasisAmount, "0.00") > 0;
      const savePaymentProviderCustomer = shouldSavePaymentMethod
        ? await ensureProviderCustomer(deps, { accountId })
        : null;
      const paymentAmount = marketplaceCheckoutFeeQuote.total_amount;
      const processorAmount = marketplaceCheckoutFeeQuote.processor_amount;
      const marketplaceSalesFeeAmount = sumFeeAmounts(orders, "marketplace_sales_fee_amount");
      const marketplaceCheckoutFeeAmount = marketplaceCheckoutFeeQuote.marketplace_checkout_fee_amount;
      const sellerNetAmount = sumFeeAmounts(orders, "seller_net_amount");
      const sellerPayoutAmount = sumFeeAmounts(orders, "seller_payout_amount");
      const sellerPayouts = buildSellerPayoutComponents(orders);
      const paymentId = createId("pay") as PaymentId;
      const returnUrlBase = params.returnUrlBase?.trim().replace(/\/+$/, "") ?? "";
      const returnUrlPath = resolvePaymentReturnPath(params.returnUrlPath, paymentId);
      const providerIdempotencyKey = `payments:payment:${paymentId}:create`;
      const providerOperationKey = `payment:${paymentId}:create`;
      const createAgenticPaymentSession = deps.processorGateway.createAgenticPaymentSession?.bind(
        deps.processorGateway,
      );
      if (params.agenticPayment && !createAgenticPaymentSession) {
        throw new PaymentsDomainError("Agentic payment handoff is not supported by the configured payment processor.");
      }
      const createdAt = new Date().toISOString();
      const providerRequest = {
        paymentId,
        buyerAccountId: accountId,
        orderIds,
        amount: processorAmount,
        currencyCode,
        paymentMethodCategory,
        returnUrl: returnUrlBase ? `${returnUrlBase}${returnUrlPath}` : null,
        clientRiskContext: params.clientRiskContext ?? null,
        marketplaceRiskMetadata: buildMarketplaceRiskMetadata(sellerPayouts),
        savedCheckoutInstrument: savedCheckoutInstrument
          ? {
              instrumentId: savedCheckoutInstrument.instrument_id,
              providerCustomerReference: savedCheckoutInstrument.provider_customer_reference,
              providerReference: savedCheckoutInstrument.provider_reference,
              confirmationExperience: savedCheckoutInstrument.confirmation_experience,
              displayLabel: savedCheckoutInstrument.display_label,
            }
          : null,
        savePaymentMethod: savePaymentProviderCustomer
          ? {
              providerCustomerReference: savePaymentProviderCustomer.provider_customer_reference,
              consentId: createId("consent"),
              consentText: SAVE_PAYMENT_CONSENT_TEXT,
            }
          : null,
        agenticPayment: params.agenticPayment ?? null,
      };
      await recordPaymentProviderOperationPending(deps.db, {
        operationKey: providerOperationKey,
        providerName: publicConfig.processorName,
        operationKind:
          compareMoney(processorAmount, "0.00") === 0 ? "balance-credit-capture" : "payment-session-create",
        accountId,
        paymentId,
        idempotencyKey: providerIdempotencyKey,
        createdAt,
      });

      let processorPayment;
      try {
        processorPayment =
          compareMoney(processorAmount, "0.00") === 0
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
                  returnUrl: returnUrlBase ? `${returnUrlBase}${returnUrlPath}` : null,
                  idempotencyKey: providerIdempotencyKey,
                  clientRiskContext: params.clientRiskContext ?? null,
                  marketplaceRiskMetadata: buildMarketplaceRiskMetadata(sellerPayouts),
                  savedCheckoutInstrument: providerRequest.savedCheckoutInstrument,
                  savePaymentMethod: providerRequest.savePaymentMethod,
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
                  returnUrl: returnUrlBase ? `${returnUrlBase}${returnUrlPath}` : null,
                  idempotencyKey: providerIdempotencyKey,
                  clientRiskContext: params.clientRiskContext ?? null,
                  marketplaceRiskMetadata: buildMarketplaceRiskMetadata(sellerPayouts),
                  savedCheckoutInstrument: providerRequest.savedCheckoutInstrument,
                  savePaymentMethod: providerRequest.savePaymentMethod,
                });
      } catch (error) {
        await recordPaymentProviderOperationFailed(deps.db, {
          operationKey: providerOperationKey,
          errorMessage: error instanceof Error ? error.message : "Payment processor session creation failed.",
        });
        throw error;
      }

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
          savedCheckoutInstrumentId: savedCheckoutInstrument?.instrument_id ?? null,
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
      await recordPaymentProviderOperationSucceeded(deps.db, {
        operationKey: providerOperationKey,
        providerObjectReference: processorPayment.processorPaymentReference,
        completedAt: createdAt,
      });
      await recordPaymentProviderIdempotencyKey(deps.db, {
        operationKey: providerOperationKey,
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
        marketplace_checkout_fee_policy_version: marketplaceCheckoutFeeQuote.policy_version,
        marketplace_checkout_fee_quote_fingerprint: marketplaceCheckoutFeeQuote.quote_fingerprint,
        payment_method_category: marketplaceCheckoutFeeQuote.payment_method_category,
        saved_checkout_instrument_id: savedCheckoutInstrument?.instrument_id ?? null,
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
        status: compareMoney(processorAmount, "0.00") === 0 ? "captured" : "pending-confirmation",
        failure_code: null,
        failure_message: null,
        created_at: createdAt,
        updated_at: createdAt,
        captured_at: compareMoney(processorAmount, "0.00") === 0 ? createdAt : null,
        failed_at: null,
        cancelled_at: null,
        refunded_at: null,
        disputed_at: null,
        processor_publishable_key: publicConfig.publishableKey,
        provider_events: [],
      };
    },
    recoverCheckoutPayment(params, context) {
      const orderIds = normalizeOrderIds(params.orderIds);
      const currencyCode = normalizeCurrencyCode(params.currencyCode ?? "usd");
      const requestedBalanceCreditAmount = normalizeMoneyAmount(params.requestedBalanceCreditAmount ?? "0.00", {
        fieldName: "Balance credit amount",
        allowZero: true,
      });
      return this.createAccountPayment(
        {
          ...params,
          orderIds,
          currencyCode,
          requestedBalanceCreditAmount,
          paymentMethodCategory: normalizePaymentMethodCategory(params.paymentMethodCategory),
          agenticPayment: params.agenticPayment ?? null,
          sourceContext: "checkout-recovery",
          sourceReferenceId: checkoutRecoveryReference({
            accountId: params.accountId,
            orderIds,
            currencyCode,
            requestedBalanceCreditAmount,
            paymentMethodCategory: normalizePaymentMethodCategory(params.paymentMethodCategory),
          }),
        },
        context,
      );
    },
    async getCheckoutRecoveryOptions(params) {
      const accountId = normalizeRequiredText(params.accountId, "Account is required.") as AccountId;
      const orderIds = normalizeOrderIds(params.orderIds);
      const currencyCode = normalizeCurrencyCode(params.currencyCode ?? "usd");
      const requestedBalanceCreditAmount = normalizeMoneyAmount(params.requestedBalanceCreditAmount ?? "0.00", {
        fieldName: "Balance credit amount",
        allowZero: true,
      });
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
        paymentMethodCategory: normalizePaymentMethodCategory(params.paymentMethodCategory),
      });
      const existing = await getPaymentBySource(deps.db, "checkout-recovery", recoveryReferenceId, accountId);

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
      const payment = await getAccountPayment(deps.db, params.paymentId, params.accountId);
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
        ...(payment.refunded_at
          ? [
              {
                occurred_at: payment.refunded_at,
                kind: "payment-refunded",
                label: "Payment refunded",
                reference: payment.processor_payment_reference,
                amount: payment.amount,
                currency_code: payment.currency_code,
              },
            ]
          : []),
        ...(payment.disputed_at
          ? [
              {
                occurred_at: payment.disputed_at,
                kind: "payment-disputed",
                label: "Payment disputed",
                reference: payment.processor_payment_reference,
                amount: payment.amount,
                currency_code: payment.currency_code,
              },
            ]
          : []),
      ].sort((left, right) => left.occurred_at.localeCompare(right.occurred_at));

      return {
        payment_id: payment.payment_id,
        account_id: payment.buyer_account_id,
        items,
      };
    },
    listPaymentsNeedingReconciliation: (params) => listPaymentsNeedingReconciliation(deps.db, params),
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
          webhookEvent.internalPaymentId ??
          webhookEvent.providerObjectReference ??
          webhookEvent.processorPaymentReference,
      });
      if (!isNewProviderEvent) {
        return { received: true, ignored: true };
      }

      if (webhookEvent.kind === "saved-payment-setup-succeeded") {
        const setupReference = webhookEvent.processorSetupReference ?? webhookEvent.processorPaymentReference;
        const setupSession = await getSavedCheckoutSetupSessionByProcessorReference(deps.db, setupReference);
        if (!setupSession) {
          return { received: true, ignored: true };
        }
        await completeSavedCheckoutSetupSession(deps.db, {
          processorSetupReference: setupReference,
          processorStatus: webhookEvent.processorStatus,
          completedAt: webhookEvent.occurredAt,
        });
        if (webhookEvent.savedPaymentMethod) {
          await persistProcessorSavedPaymentMethod(deps, {
            accountId: setupSession.account_id as AccountId,
            providerCustomerReference: setupSession.provider_customer_reference,
            savedPaymentMethod: webhookEvent.savedPaymentMethod,
            consentId: setupSession.consent_id,
            consentText: setupSession.consent_text,
            isDefault: true,
            auditAction: "setup-webhook-saved",
          });
        }
        return { received: true, ignored: false };
      }

      if (webhookEvent.kind === "saved-payment-setup-failed") {
        const setupReference = webhookEvent.processorSetupReference ?? webhookEvent.processorPaymentReference;
        await completeSavedCheckoutSetupSession(deps.db, {
          processorSetupReference: setupReference,
          processorStatus: webhookEvent.processorStatus,
          completedAt: webhookEvent.occurredAt,
        });
        return { received: true, ignored: false };
      }

      if (webhookEvent.kind === "saved-payment-method-detached" && webhookEvent.savedPaymentMethod) {
        const instrument = await getSavedCheckoutInstrumentByProviderReference(deps.db, {
          provider: webhookEvent.savedPaymentMethod.processorName,
          providerReference: webhookEvent.savedPaymentMethod.providerReference,
        });
        if (instrument) {
          await markSavedCheckoutInstrumentRemoved(deps.db, {
            accountId: instrument.account_id,
            instrumentId: instrument.instrument_id,
            timestamp: webhookEvent.occurredAt,
          });
          await recordSavedCheckoutInstrumentAudit(deps.db, {
            auditId: createId("audit"),
            instrumentId: instrument.instrument_id,
            accountId: instrument.account_id,
            action: "provider-detached",
            reason: webhookEvent.eventId,
            performedByAccountId: instrument.account_id,
            createdAt: webhookEvent.occurredAt,
          });
        }
        return { received: true, ignored: !instrument };
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
          if (webhookEvent.savedPaymentMethod) {
            const customer =
              webhookEvent.savedPaymentMethod.providerCustomerReference ??
              (
                await getProviderCustomer(deps.db, {
                  accountId: payment.buyer_account_id,
                  provider: webhookEvent.savedPaymentMethod.processorName,
                })
              )?.provider_customer_reference;
            if (customer) {
              await persistProcessorSavedPaymentMethod(deps, {
                accountId: payment.buyer_account_id as AccountId,
                providerCustomerReference: customer,
                savedPaymentMethod: webhookEvent.savedPaymentMethod,
                consentId: webhookEvent.savedPaymentConsentId ?? null,
                consentText: webhookEvent.savedPaymentConsentText ?? SAVE_PAYMENT_CONSENT_TEXT,
                isDefault: true,
                auditAction: "payment-consent-saved",
              });
            }
          }
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
          await commandHandler({
            streamId,
            command: {
              type: "RecordPaymentRefund",
              processorStatus: webhookEvent.processorStatus,
              processorRefundReference:
                webhookEvent.processorRefundReference ?? webhookEvent.providerObjectReference ?? null,
              amount: webhookEvent.amount ?? null,
              refundedAt: webhookEvent.occurredAt,
            },
            context,
          });
          break;
        case "payment-disputed":
          await commandHandler({
            streamId,
            command: {
              type: "RecordPaymentDispute",
              processorStatus: webhookEvent.processorStatus,
              disputeStatus: webhookEvent.failureCode,
              disputeMessage: webhookEvent.failureMessage,
              amount: webhookEvent.amount ?? null,
              disputedAt: webhookEvent.occurredAt,
            },
            context,
          });
          break;
        case "saved-payment-method-detached":
          break;
        default:
          assert(false, "Unhandled payment webhook kind.");
      }

      return { received: true, ignored: false };
    },
    publicConfig,
    projectors: [
      createProjectionHandlerSet({
        projectionName: "payments-payment-projection",
        handlers: buildPaymentProjectionHandlers(deps.db),
      }),
      createProjectionHandlerSet({
        projectionName: PAYMENTS_PAYMENT_TRANSACTIONAL_EMAIL_PROJECTION,
        handlers: buildPaymentTransactionalEmailProjectionHandlers(
          deps.db,
          notificationOutbox,
          PAYMENTS_PAYMENT_TRANSACTIONAL_EMAIL_PROJECTION,
        ),
      }),
    ],
  };
}
