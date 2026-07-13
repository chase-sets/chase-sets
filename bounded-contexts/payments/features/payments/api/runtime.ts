import { createHash } from "node:crypto";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createNoopNotificationOutbox, type NotificationOutbox } from "@chase-sets/outbound-messaging";
import { createConfiguredInMemoryRateLimiter, recordRateLimitExceeded } from "@chase-sets/http/rate-limit";
import { hasProcessedProviderWebhookEvent, recordProviderWebhookEvent } from "@chase-sets/provider-webhook-inbox";
import { createId } from "@chase-sets/primitives/typed-ids";
import type { AccountId, OrderId, PaymentId } from "@chase-sets/primitives/typed-ids";
import { sumMoneyAmounts } from "@chase-sets/primitives/money";
import {
  assert,
  compareMoney,
  normalizeCurrencyCode,
  normalizeMoneyAmount,
  normalizeOrderIds,
  normalizeRequiredText,
  PaymentsDomainError,
  subtractMoney,
  type RefundId,
} from "../../../support/runtime-support/common";
import { checkoutUnavailableReasonLabel } from "./reason-codes";
import type {
  AgenticProcessorPaymentInput,
  PaymentProcessorGateway,
  PaymentProcessorPublicConfig,
  ProcessorPaymentReconciliationResult,
} from "@chase-sets/payment-processing";
import type { BalanceCreditResolver } from "./balance-credit-resolver";
import { listPaymentOrderInputs, type PaymentOrderInputRow } from "../integrations/order-input/order-input-queries";
import {
  submitPaymentDisputeEvidence,
  type PaymentDisputeEvidenceSubmissionResult,
} from "../integrations/dispute-evidence/dispute-evidence-submission";
import {
  buildPaymentTransactionalEmailProjectionHandlers,
  PAYMENTS_PAYMENT_TRANSACTIONAL_EMAIL_PROJECTION,
} from "../integrations/transactional-email/transactional-email-projector";
import {
  buildPaymentFraudAlertProjectionHandlers,
  PAYMENTS_FRAUD_ALERT_PROJECTION,
} from "../integrations/fraud-alerts/fraud-alert-projection";
import { buildPaymentProjectionHandlers } from "../read-model/projection";
import {
  getAccountPayment,
  getPaymentById,
  getPaymentByProcessorReference,
  getSavedCheckoutInstrument,
  getSavedCheckoutInstrumentByProviderReference,
  getProviderCustomer,
  getRevokedAgentGrant,
  getSavedCheckoutSetupSessionByProcessorReference,
  getSavedCheckoutSetupSessionBySetupReference,
  listSavedCheckoutInstrumentsForAgentGrant,
  listPaymentProviderEvents,
  listPaymentProviderIdempotencyKeys,
  listPaymentProviderOperationsNeedingReconciliation,
  listPaymentsNeedingReconciliation,
  listSavedCheckoutInstruments,
  getPaymentAccountRiskSource,
  completeSavedCheckoutSetupSession,
  markSavedCheckoutInstrumentRemoved,
  markPaymentCreationReservationInactive,
  recordSavedCheckoutInstrumentAudit,
  recordRevokedAgentGrant,
  recordSavedCheckoutSetupSession,
  recordPaymentReconciliationRun,
  recordPaymentProviderIdempotencyKey,
  recordPaymentProviderOperationFailed,
  recordPaymentProviderOperationPending,
  recordPaymentProviderOperationSucceeded,
  reservePaymentCreation,
  setSavedCheckoutInstrumentDefault,
  upsertProviderCustomer,
  upsertSavedCheckoutInstrument,
  getActivePaymentByOrderSet,
  getPaymentBySource,
  type PaymentDetailRow,
  type PaymentAccountRiskSourceRow,
  type PaymentProviderEventRow,
  type PaymentProviderOperationRow,
  type SavedCheckoutInstrumentRow,
  type ProviderCustomerRow,
  type SavedCheckoutSetupSessionRow,
} from "../read-model/queries";
import {
  decidePayment,
  evolvePayment,
  initialPaymentState,
  type PaymentCommand,
  type PaymentDisputedEvent,
  type PaymentEvent,
  type PaymentState,
  type SellerPayoutComponent,
} from "../domain/domain";
import { decideRefund, evolveRefund, initialRefundState, type RefundEvent } from "../../refunds/domain/domain";
import type { RefundServices } from "../../refunds/api/runtime";
import {
  defaultMarketplaceCheckoutFeePolicyValue,
  marketplaceCheckoutFeePaymentMethodCategories,
  marketplaceCheckoutFeePolicy,
  normalizeMarketplaceCheckoutFeePaymentMethodCategory,
  quoteMarketplaceCheckoutFee,
  type MarketplaceCheckoutFeePaymentMethodCategory,
  type MarketplaceCheckoutFeePolicy,
  type MarketplaceCheckoutFeePolicyValue,
  type MarketplaceCheckoutFeeQuote,
} from "./marketplace-checkout-fee-policy";
import type { CheckoutProcessingFeePolicyResolver } from "./checkout-processing-fee-policy-resolver";

type PaymentRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
  processorGateway: PaymentProcessorGateway;
  refunds?: Pick<RefundServices, "issueRefund">;
  balanceCreditResolver?: BalanceCreditResolver;
  checkoutProcessingFeePolicyResolver?: CheckoutProcessingFeePolicyResolver;
  notificationOutbox?: NotificationOutbox;
}>;

/**
 * Resolves the checkout processing-fee policy in effect at quote time. When
 * no resolver is wired (standalone/dev usage without Commercial Terms
 * mounted) this falls back to the compiled launch values -- an empty or
 * absent policy table can never break the checkout hot path.
 */
async function resolveMarketplaceCheckoutFeePolicy(
  deps: Pick<PaymentRuntimeDeps, "checkoutProcessingFeePolicyResolver">,
  at?: string,
): Promise<Readonly<{ value: MarketplaceCheckoutFeePolicyValue; effectiveFrom: string | null }>> {
  if (!deps.checkoutProcessingFeePolicyResolver) {
    return { value: defaultMarketplaceCheckoutFeePolicyValue, effectiveFrom: null };
  }

  const resolved = await deps.checkoutProcessingFeePolicyResolver.resolveCheckoutProcessingFeePolicy(
    at ? { at } : undefined,
  );
  return { value: resolved.value, effectiveFrom: resolved.effectiveFrom };
}

export class PaymentsRateLimitExceededError extends Error {
  readonly code = "rate_limited";
  constructor(
    readonly surface: string,
    readonly retryAfterSeconds: number,
  ) {
    super("Too many payment attempts. Please retry after the rate-limit window.");
    this.name = "PaymentsRateLimitExceededError";
  }
}

const cardDeclineVelocityRateLimiter = createConfiguredInMemoryRateLimiter("payments.card-decline.fingerprint", {
  max: 5,
  windowMs: 60 * 60 * 1000,
});

function enforceCardDeclineVelocity(fingerprint: string | null | undefined) {
  const normalized = fingerprint?.trim();
  if (!normalized) {
    return;
  }
  const decision = cardDeclineVelocityRateLimiter.peek(`card:${normalized}`);
  if (decision.limited) {
    recordRateLimitExceeded("payments.card-decline.fingerprint");
    throw new PaymentsRateLimitExceededError("payments.card-decline.fingerprint", decision.retryAfterSeconds);
  }
}

function recordCardDeclineVelocity(
  method:
    | Readonly<{
        paymentMethodCategory?: string | null;
        paymentMethodFingerprint?: string | null;
      }>
    | null
    | undefined,
) {
  if (method?.paymentMethodCategory !== "card" || !method.paymentMethodFingerprint?.trim()) {
    return;
  }
  const decision = cardDeclineVelocityRateLimiter.check(`card:${method.paymentMethodFingerprint.trim()}`);
  if (decision.limited) {
    recordRateLimitExceeded("payments.card-decline.fingerprint");
  }
}

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

type PaymentMethodCategory = MarketplaceCheckoutFeePaymentMethodCategory;
type SavedCheckoutInstrumentReadiness = "ready" | "setup-required" | "removed";
type SavedCheckoutConfirmationExperience = "trusted-payment-step" | "off-session-token";

type PaymentReconciliationAttentionItem = Readonly<{
  kind: "payment" | "provider-operation";
  payment_id?: string | null;
  operation_key?: string | null;
  processor_payment_reference?: string | null;
  provider_status?: string | null;
  reason: string;
}>;

type PaymentReconciliationResult = Readonly<{
  checked: number;
  repaired: number;
  attention: number;
  payment_ids: readonly string[];
  provider_operations_checked: number;
  provider_operations_resolved: number;
  attention_items: readonly PaymentReconciliationAttentionItem[];
}>;

type CheckoutAffordanceInstrument = Readonly<{
  instrumentId: string;
  paymentMethodCategory: PaymentMethodCategory;
  instrumentRiskClusterKey: string | null;
  displayLabel: string;
  confirmationExperience: SavedCheckoutConfirmationExperience;
  readiness: SavedCheckoutInstrumentReadiness;
  checkoutEligible: boolean;
  isDefault: boolean;
  removedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

function instrumentRiskClusterKey(
  provider: string,
  paymentMethodCategory: PaymentMethodCategory,
  providerFingerprint: string | null | undefined,
) {
  if (!providerFingerprint || paymentMethodCategory === "platform-credit") {
    return null;
  }

  return `instrument:${createHash("sha256")
    .update(`${provider}:${paymentMethodCategory}:${providerFingerprint}`)
    .digest("hex")}`;
}

function paymentCommandFromProviderResult(result: ProcessorPaymentReconciliationResult): PaymentCommand | null {
  switch (result.outcome) {
    case "captured":
      return {
        type: "RecordPaymentCapture",
        processorStatus: result.processorStatus,
        capturedAt: result.occurredAt,
      };
    case "failed":
      return {
        type: "RecordPaymentFailure",
        processorStatus: result.processorStatus,
        failureCode: result.failureCode ?? null,
        failureMessage: result.failureMessage ?? null,
        failedAt: result.occurredAt,
      };
    case "cancelled":
      return {
        type: "CancelPayment",
        cancelledAt: result.occurredAt,
      };
    case "authorized":
      return {
        type: "RecordPaymentAuthorization",
        processorStatus: result.processorStatus,
        authorizedAt: result.occurredAt,
      };
    case "pending":
    case "unknown":
      return null;
    default:
      assert(false, "Unhandled provider payment reconciliation outcome.");
  }
}

function providerResultMismatch(
  payment: PaymentDetailRow,
  result: ProcessorPaymentReconciliationResult,
): string | null {
  if (result.processorName !== payment.processor_name) {
    return "Provider returned a different processor name for the payment.";
  }
  if (result.processorPaymentReference !== payment.processor_payment_reference) {
    return "Provider returned a different payment reference for the payment.";
  }
  if (result.internalPaymentId && result.internalPaymentId !== payment.payment_id) {
    return "Provider metadata points at a different Payments payment id.";
  }
  return null;
}

const SAVE_PAYMENT_CONSENT_TEXT =
  "Save this payment method for future Chase Sets checkout and allow Chase Sets to use it for future purchases I approve.";

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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The authenticity-check fee (m109) is frozen once, on the sole
 * order it applies to (single-seller only in v1), so summing it across a
 * payment's orders is a plain zero-default sum -- no `seller_net_amount`
 * fallback quirk like `sumFeeAmounts` applies, since a missing/zero value
 * here means "this order did not opt in," not "data is missing."
 */
function sumAuthenticityFeeAmounts(orders: readonly Readonly<{ authenticity_fee_amount?: string | null }>[]) {
  return sumMoneyAmounts(
    orders.map((order) =>
      normalizeMoneyAmount(order.authenticity_fee_amount ?? "0.00", {
        fieldName: "Authenticity check fee amount",
        allowZero: true,
      }),
    ),
  );
}

function sumOrderAmounts(orders: readonly Readonly<{ total_amount: string }>[]) {
  return sumMoneyAmounts(
    orders.map((order) =>
      normalizeMoneyAmount(order.total_amount, {
        fieldName: "Order total",
      }),
    ),
  );
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
  return sumMoneyAmounts(
    orders.map((order) =>
      normalizeMoneyAmount(order[fieldName] ?? order.seller_net_amount, {
        fieldName,
        allowZero: true,
      }),
    ),
  );
}

function buildSellerPayoutComponents(
  orders: readonly Readonly<{
    order_id: string;
    seller_account_id: string;
    marketplace_sales_fee_amount: string;
    marketplace_sales_fee_lines?: PaymentOrderInputRow["marketplace_sales_fee_lines"];
    seller_net_amount: string;
    seller_item_net_amount: string;
    shipping_allowance_amount: string;
    seller_shipping_payout_amount: string;
    protection_amount?: string;
    protection_allowance_amount?: string;
    protection_overage_amount?: string;
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
        marketplaceSalesFeeAmount: normalizeMoneyAmount(order.marketplace_sales_fee_amount, {
          fieldName: "Marketplace sales fee amount",
          allowZero: true,
        }),
        marketplaceSalesFeeLines: order.marketplace_sales_fee_lines ?? [],
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
        protectionAmount: normalizeMoneyAmount(order.protection_amount ?? "0.00", {
          fieldName: "Order protection amount",
          allowZero: true,
        }),
        protectionAllowanceAmount: normalizeMoneyAmount(order.protection_allowance_amount ?? "0.00", {
          fieldName: "Allowance-funded Order Protection amount",
          allowZero: true,
        }),
        protectionOverageAmount: normalizeMoneyAmount(order.protection_overage_amount ?? "0.00", {
          fieldName: "Overage-funded Order Protection amount",
          allowZero: true,
        }),
        sellerPayoutAmount: normalizeMoneyAmount(order.seller_payout_amount ?? order.seller_net_amount, {
          fieldName: "Seller payout amount",
          allowZero: true,
        }),
      },
    ];
  });
}

function moneyToCents(value: string) {
  return Math.round(Number.parseFloat(value) * 100);
}

function centsToMoney(cents: number) {
  return (cents / 100).toFixed(2);
}

function fraudRefundId(providerEventId: string): RefundId {
  return `rfd_fraud_${providerEventId.replaceAll(/[^a-zA-Z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "")}` as RefundId;
}

function buildOrderRefundCaps(
  orders: readonly Readonly<{
    order_id: string;
    total_amount: string;
  }>[],
  marketplaceCheckoutFeeAmount: string,
) {
  const checkoutFeeCents = moneyToCents(marketplaceCheckoutFeeAmount);
  const orderTotals = orders.map((order) => ({
    orderId: order.order_id as OrderId,
    totalCents: moneyToCents(order.total_amount),
  }));
  const totalCents = orderTotals.reduce((sum, order) => sum + order.totalCents, 0);
  let allocatedCheckoutFeeCents = 0;

  return orderTotals.map((order, index) => {
    const checkoutFeeAllocation =
      checkoutFeeCents <= 0 || totalCents <= 0
        ? 0
        : index === orderTotals.length - 1
          ? checkoutFeeCents - allocatedCheckoutFeeCents
          : Math.floor((order.totalCents * checkoutFeeCents) / totalCents);
    allocatedCheckoutFeeCents += checkoutFeeAllocation;
    return {
      orderId: order.orderId,
      amount: centsToMoney(order.totalCents + checkoutFeeAllocation),
    };
  });
}

function buildMarketplaceRiskMetadata(
  sellerPayouts: readonly SellerPayoutComponent[],
): Record<string, string | number | boolean> {
  const sellerAccountIds = [...new Set(sellerPayouts.map((payout) => payout.sellerAccountId))].sort();
  const maxSellerOrderAmount = sellerPayouts.reduce(
    (max, payout) => (compareMoney(payout.sellerPayoutAmount, max) > 0 ? payout.sellerPayoutAmount : max),
    "0.00",
  );

  return {
    seller_account_ids: sellerAccountIds.join(","),
    seller_account_count: sellerAccountIds.length,
    max_seller_order_amount: maxSellerOrderAmount,
    high_dollar_order: compareMoney(maxSellerOrderAmount, "250.00") >= 0,
    fulfillment_required: sellerPayouts.length > 0,
  };
}

type CardAuthenticationAssessment = Readonly<{
  requestThreeDSecure: "automatic" | "any";
  reasonCodes: readonly string[];
}>;

const THREE_D_SECURE_PAYMENT_AMOUNT_THRESHOLD = "250.00";

function buildCardAuthenticationAssessment(
  params: Readonly<{
    paymentMethodCategory: PaymentMethodCategory;
    processorAmount: string;
    marketplaceRiskMetadata: Readonly<Record<string, string | number | boolean>>;
    accountRisk: PaymentAccountRiskSourceRow | null;
  }>,
): CardAuthenticationAssessment | null {
  if (params.paymentMethodCategory !== "card" || compareMoney(params.processorAmount, "0.00") <= 0) {
    return null;
  }

  const reasonCodes = [
    ...(params.accountRisk?.stripe_fraud_flag ? ["stripe-fraud-flag"] : []),
    ...(params.accountRisk && params.accountRisk.stripe_review_open_count > 0 ? ["stripe-fraud-review-open"] : []),
    ...(params.accountRisk?.manual_payout_review ? ["manual-payout-review"] : []),
    ...(compareMoney(params.processorAmount, THREE_D_SECURE_PAYMENT_AMOUNT_THRESHOLD) >= 0
      ? ["high-payment-amount"]
      : []),
    ...(params.marketplaceRiskMetadata.high_dollar_order === true ? ["high-dollar-seller-exposure"] : []),
  ];

  return {
    requestThreeDSecure: reasonCodes.length > 0 ? "any" : "automatic",
    reasonCodes,
  };
}

async function buildCheckoutStatusFromAmount(
  deps: Pick<PaymentRuntimeDeps, "balanceCreditResolver" | "checkoutProcessingFeePolicyResolver">,
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
  const paymentMethodCategory = normalizeMarketplaceCheckoutFeePaymentMethodCategory(params.paymentMethodCategory);
  const checkoutProcessingFeePolicy = await resolveMarketplaceCheckoutFeePolicy(deps);
  const paymentMethodQuotes = marketplaceCheckoutFeePaymentMethodCategories.map((method) =>
    quoteMarketplaceCheckoutFee(
      {
        orderAmount: amount,
        externalBasisAmount: externalAmount,
        balanceCreditAmount: appliedAmount,
        paymentMethodCategory: method,
      },
      checkoutProcessingFeePolicy.value,
    ),
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
    agentGrantId?: string | null;
    consentId?: string | null;
    consentText?: string | null;
    isDefault?: boolean;
    auditAction: string;
  }>,
) {
  const existingInstruments = await listSavedCheckoutInstruments(deps.db, params.accountId);
  const activeExistingInstruments = existingInstruments.filter(
    (instrument) =>
      instrument.readiness !== "removed" &&
      instrument.provider_reference !== params.savedPaymentMethod.providerReference,
  );
  const existingInstrument = existingInstruments.find(
    (instrument) => instrument.provider_reference === params.savedPaymentMethod.providerReference,
  );
  const revokedGrant = params.agentGrantId
    ? await getRevokedAgentGrant(deps.db, { accountId: params.accountId, agentGrantId: params.agentGrantId })
    : null;
  if (revokedGrant) {
    await deps.processorGateway.detachSavedPaymentMethod(params.savedPaymentMethod.providerReference);
    const instrument = await upsertSavedCheckoutInstrument(deps.db, {
      instrumentId:
        existingInstrument?.instrument_id ??
        savedInstrumentIdForProviderReference(params.savedPaymentMethod.providerReference),
      accountId: params.accountId,
      agentGrantId: params.agentGrantId,
      paymentMethodCategory: params.savedPaymentMethod.paymentMethodCategory,
      provider: params.savedPaymentMethod.processorName,
      providerCustomerReference:
        params.savedPaymentMethod.providerCustomerReference ?? params.providerCustomerReference,
      providerReference: params.savedPaymentMethod.providerReference,
      providerFingerprint: params.savedPaymentMethod.paymentMethodFingerprint ?? null,
      displayLabel: params.savedPaymentMethod.displayLabel,
      confirmationExperience: "off-session-token",
      readiness: "removed",
      allowRedisplay: params.savedPaymentMethod.allowRedisplay,
      consentId: params.consentId ?? null,
      consentText: params.consentText ?? null,
      isDefault: false,
      removedAt: revokedGrant.revoked_at,
      timestamp: revokedGrant.revoked_at,
    });
    await recordSavedCheckoutInstrumentAudit(deps.db, {
      auditId: `audit_agent_grant_revoked_${params.agentGrantId}_${instrument.instrument_id}`,
      instrumentId: instrument.instrument_id,
      accountId: params.accountId,
      action: "agent-grant-revoked",
      reason: params.agentGrantId,
      performedByAccountId: params.accountId,
      createdAt: revokedGrant.revoked_at,
    });
    return instrument;
  }
  const shouldBecomeDefault =
    params.isDefault === true && (existingInstrument?.is_default === true || activeExistingInstruments.length === 0);

  const instrument = await upsertSavedCheckoutInstrument(deps.db, {
    instrumentId: savedInstrumentIdForProviderReference(params.savedPaymentMethod.providerReference),
    accountId: params.accountId,
    agentGrantId: params.agentGrantId ?? existingInstrument?.agent_grant_id ?? null,
    paymentMethodCategory: params.savedPaymentMethod.paymentMethodCategory,
    provider: params.savedPaymentMethod.processorName,
    providerCustomerReference: params.savedPaymentMethod.providerCustomerReference ?? params.providerCustomerReference,
    providerReference: params.savedPaymentMethod.providerReference,
    providerFingerprint: params.savedPaymentMethod.paymentMethodFingerprint ?? null,
    displayLabel: params.savedPaymentMethod.displayLabel,
    confirmationExperience: "off-session-token",
    readiness: params.savedPaymentMethod.removed ? "removed" : params.savedPaymentMethod.readiness,
    allowRedisplay: params.savedPaymentMethod.allowRedisplay,
    consentId: params.consentId ?? null,
    consentText: params.consentText ?? null,
    isDefault: shouldBecomeDefault,
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
      isGuestCheckout?: boolean;
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
      isGuestCheckout?: boolean;
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
    params: Readonly<{
      accountId: AccountId;
      returnUrlBase?: string | null;
      returnUrlPath?: string | null;
      uiMode?: "hosted" | "embedded";
      agentGrantId?: string | null;
    }>,
  ) => Promise<SavedCheckoutSetupSessionRow>;
  reconcileSavedCheckoutSetupSession: (
    params: Readonly<{ accountId: AccountId; setupReference: string }>,
    context: EventStoreContext,
  ) => Promise<SavedCheckoutInstrumentRow | null>;
  setSavedCheckoutInstrumentDefault: (
    params: Readonly<{ accountId: AccountId; instrumentId: string }>,
    context: EventStoreContext,
  ) => Promise<SavedCheckoutInstrumentRow | null>;
  removeSavedCheckoutInstrument: (
    params: Readonly<{ accountId: AccountId; instrumentId: string }>,
    context: EventStoreContext,
  ) => Promise<SavedCheckoutInstrumentRow | null>;
  revokeSavedCheckoutInstrumentsForAgentGrant: (
    params: Readonly<{ accountId: AccountId; agentGrantId: string; revokedAt?: string }>,
  ) => Promise<Readonly<{ detached: number; alreadyRemoved: number; instrumentIds: readonly string[] }>>;
  reconcileSavedCheckoutInstruments: (
    params: Readonly<{ accountId: AccountId }>,
    context: EventStoreContext,
  ) => Promise<Readonly<{ checked: number; updated: number; removed: number }>>;
  listAccountOrderInputs: (
    params: Readonly<{ accountId: AccountId; orderIds: readonly OrderId[] }>,
  ) => Promise<readonly PaymentOrderInputRow[]>;
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
    context?: EventStoreContext,
  ) => Promise<PaymentReconciliationResult>;
  processWebhook: (
    params: Readonly<{ rawBody: string; signatureHeader: string | null }>,
    context: EventStoreContext,
  ) => Promise<{ received: boolean; ignored: boolean }>;
  submitDisputeEvidence: (
    dispute: PaymentDisputedEvent["data"],
    context: EventStoreContext,
  ) => Promise<PaymentDisputeEvidenceSubmissionResult>;
  publicConfig: PaymentProcessorPublicConfig;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createPaymentRuntime(deps: PaymentRuntimeDeps): PaymentServices {
  const notificationOutbox = deps.notificationOutbox ?? createNoopNotificationOutbox();
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<PaymentEvent>(),
    initialState: () => initialPaymentState,
    evolve: evolvePayment,
    decide: decidePayment,
  });
  const { commandHandler: refundCommandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<RefundEvent>(),
    initialState: () => initialRefundState,
    evolve: evolveRefund,
    decide: decideRefund,
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

  function paymentStateToDetailRow(state: PaymentState): PaymentDetailRow {
    assert(state.paymentId, "Payment creation is still in progress.");
    assert(state.buyerAccountId, "Payment creation is still in progress.");
    assert(state.amount, "Payment creation is still in progress.");
    assert(state.processorAmount, "Payment creation is still in progress.");
    assert(state.marketplaceSalesFeeAmount, "Payment creation is still in progress.");
    assert(state.marketplaceCheckoutFeeAmount, "Payment creation is still in progress.");
    assert(state.sellerNetAmount, "Payment creation is still in progress.");
    assert(state.sellerPayoutAmount, "Payment creation is still in progress.");
    assert(state.currencyCode, "Payment creation is still in progress.");
    assert(state.processorName, "Payment creation is still in progress.");
    assert(state.processorPaymentKind, "Payment creation is still in progress.");
    assert(state.processorPaymentReference, "Payment creation is still in progress.");
    assert(state.processorStatus, "Payment creation is still in progress.");
    assert(state.status, "Payment creation is still in progress.");
    assert(state.createdAt, "Payment creation is still in progress.");
    const latestLiabilityShiftOutcome = [...state.liabilityShiftOutcomes].sort((left, right) =>
      left.recordedAt.localeCompare(right.recordedAt),
    )[state.liabilityShiftOutcomes.length - 1];

    return {
      payment_id: state.paymentId,
      buyer_account_id: state.buyerAccountId,
      order_ids: state.orderIds,
      order_refund_caps: state.orderRefundCaps,
      amount: state.amount,
      balance_credit_amount: state.balanceCreditAmount,
      processor_amount: state.processorAmount,
      marketplace_sales_fee_amount: state.marketplaceSalesFeeAmount,
      marketplace_checkout_fee_amount: state.marketplaceCheckoutFeeAmount,
      marketplace_checkout_fee_policy_version: state.marketplaceCheckoutFeePolicyVersion,
      marketplace_checkout_fee_quote_fingerprint: state.marketplaceCheckoutFeeQuoteFingerprint,
      payment_method_category: state.paymentMethodCategory,
      saved_checkout_instrument_id: state.savedCheckoutInstrumentId,
      seller_net_amount: state.sellerNetAmount,
      seller_payout_amount: state.sellerPayoutAmount,
      seller_payouts: state.sellerPayouts,
      currency_code: state.currencyCode,
      processor_name: state.processorName,
      processor_payment_kind: state.processorPaymentKind,
      processor_payment_reference: state.processorPaymentReference,
      processor_client_secret: state.processorClientSecret,
      processor_redirect_url: state.processorRedirectUrl,
      processor_status: state.processorStatus,
      three_d_secure_request: state.threeDSecureRequest,
      three_d_secure_reason_codes: state.threeDSecureReasonCodes,
      liability_shift_status: latestLiabilityShiftOutcome?.status ?? null,
      liability_shift_authentication_result: latestLiabilityShiftOutcome?.authenticationResult ?? null,
      liability_shift_radar_risk_level: latestLiabilityShiftOutcome?.radarRiskLevel ?? null,
      liability_shift_recorded_at: latestLiabilityShiftOutcome?.recordedAt ?? null,
      source_context: state.sourceContext,
      source_reference_id: state.sourceReferenceId,
      status: state.status,
      failure_code: state.failureCode,
      failure_message: state.failureMessage,
      created_at: state.createdAt,
      updated_at:
        state.disputedAt ??
        state.refundedAt ??
        state.cancelledAt ??
        state.failedAt ??
        state.capturedAt ??
        state.createdAt,
      captured_at: state.capturedAt,
      failed_at: state.failedAt,
      cancelled_at: state.cancelledAt,
      refunded_at: state.refundedAt,
      refunded_amount: state.refundedAmount,
      order_refunded_amounts: state.refundedOrderAmounts,
      disputed_at: state.disputedAt,
    };
  }

  async function loadExistingPaymentSnapshot(
    paymentId: PaymentId,
    accountId: AccountId,
  ): Promise<
    | (PaymentDetailRow &
        Readonly<{
          processor_publishable_key: string | null;
          provider_events: readonly PaymentProviderEventRow[];
        }>)
    | null
  > {
    const projected = await getPaymentById(deps.db, paymentId);
    if (projected) {
      return projected.buyer_account_id === accountId ? exposePayment(projected) : null;
    }

    const loaded = await repository.load(`payments.payment-${paymentId}`);
    if (!loaded.state.paymentId || loaded.state.buyerAccountId !== accountId) {
      return null;
    }

    return exposePayment(paymentStateToDetailRow(loaded.state));
  }

  async function waitForExistingPaymentSnapshot(paymentId: PaymentId, accountId: AccountId) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const payment = await loadExistingPaymentSnapshot(paymentId, accountId);
      if (payment) {
        return payment;
      }
      await delay(25);
    }

    throw new PaymentsDomainError(
      "Payment creation is already in progress. Try again in a moment.",
      "payment_creation_in_progress",
    );
  }

  function mapCheckoutAffordanceInstrument(row: SavedCheckoutInstrumentRow): CheckoutAffordanceInstrument {
    const readiness = row.readiness as SavedCheckoutInstrumentReadiness;
    return {
      instrumentId: row.instrument_id,
      paymentMethodCategory: row.payment_method_category as PaymentMethodCategory,
      instrumentRiskClusterKey: instrumentRiskClusterKey(
        row.provider,
        row.payment_method_category as PaymentMethodCategory,
        row.provider_fingerprint,
      ),
      displayLabel: row.display_label,
      confirmationExperience: row.confirmation_experience as SavedCheckoutConfirmationExperience,
      readiness,
      checkoutEligible:
        readiness === "ready" &&
        Boolean(row.provider_customer_reference?.trim()) &&
        Boolean(row.provider_reference?.trim()),
      isDefault: row.is_default,
      removedAt: row.removed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async function publishCheckoutAffordances(accountId: AccountId, context: EventStoreContext) {
    const instruments = await listSavedCheckoutInstruments(deps.db, accountId);
    const publishedAt = new Date().toISOString();
    await deps.eventStore.appendToStream({
      streamId: `payments.checkout-affordances-${accountId}`,
      expectedVersion: "any",
      events: [
        {
          eventType: "payments.checkout-affordances-published",
          payload: {
            accountId,
            savedCheckoutInstruments: instruments.map(mapCheckoutAffordanceInstrument),
            publishedAt,
          } as never,
          occurredAt: publishedAt as never,
        },
      ],
      context,
    });
  }

  async function applyProviderPaymentResult(
    payment: PaymentDetailRow,
    result: ProcessorPaymentReconciliationResult,
    context: EventStoreContext,
  ): Promise<Readonly<{ repaired: boolean; attention: PaymentReconciliationAttentionItem | null }>> {
    const mismatch = providerResultMismatch(payment, result);
    if (mismatch) {
      return {
        repaired: false,
        attention: {
          kind: "payment",
          payment_id: payment.payment_id,
          processor_payment_reference: payment.processor_payment_reference,
          provider_status: result.processorStatus,
          reason: mismatch,
        },
      };
    }

    const command = paymentCommandFromProviderResult(result);
    if (!command) {
      return {
        repaired: false,
        attention:
          payment.status === "pending-confirmation"
            ? {
                kind: "payment",
                payment_id: payment.payment_id,
                processor_payment_reference: payment.processor_payment_reference,
                provider_status: result.processorStatus,
                reason: "Provider payment is still pending after the reconciliation stale threshold.",
              }
            : null,
      };
    }

    try {
      const outcome = await commandHandler({
        streamId: `payments.payment-${payment.payment_id}`,
        command,
        context,
      });
      let repaired = outcome.newEvents.length > 0;
      if (result.liabilityShiftOutcome) {
        const liabilityOutcome = await commandHandler({
          streamId: `payments.payment-${payment.payment_id}`,
          command: {
            type: "RecordPaymentLiabilityShiftOutcome",
            providerEventId: `${result.processorPaymentReference}:${result.processorStatus}:${result.occurredAt}`,
            threeDSecureRequested: result.liabilityShiftOutcome.threeDSecureRequested,
            status: result.liabilityShiftOutcome.status,
            authenticationResult: result.liabilityShiftOutcome.authenticationResult,
            radarRiskLevel: result.liabilityShiftOutcome.radarRiskLevel ?? null,
            recordedAt: result.occurredAt,
          },
          context,
        });
        repaired = repaired || liabilityOutcome.newEvents.length > 0;
      }
      if (result.outcome === "captured" && result.savedPaymentMethod) {
        const customer =
          result.savedPaymentMethod.providerCustomerReference ??
          (
            await getProviderCustomer(deps.db, {
              accountId: payment.buyer_account_id,
              provider: result.savedPaymentMethod.processorName,
            })
          )?.provider_customer_reference;
        if (customer) {
          await persistProcessorSavedPaymentMethod(deps, {
            accountId: payment.buyer_account_id as AccountId,
            providerCustomerReference: customer,
            savedPaymentMethod: result.savedPaymentMethod,
            consentId: result.savedPaymentConsentId ?? null,
            consentText: result.savedPaymentConsentText ?? SAVE_PAYMENT_CONSENT_TEXT,
            isDefault: true,
            auditAction: "payment-reconciliation-saved",
          });
        }
      }
      return { repaired, attention: null };
    } catch (error) {
      return {
        repaired: false,
        attention: {
          kind: "payment",
          payment_id: payment.payment_id,
          processor_payment_reference: payment.processor_payment_reference,
          provider_status: result.processorStatus,
          reason: error instanceof Error ? error.message : "Payment reconciliation command failed.",
        },
      };
    }
  }

  async function reconcileProviderOperation(
    operation: PaymentProviderOperationRow,
    context: EventStoreContext,
  ): Promise<
    Readonly<{
      resolved: boolean;
      repaired: boolean;
      attention: PaymentReconciliationAttentionItem | null;
    }>
  > {
    const paymentId = operation.payment_id?.trim();
    if (!paymentId) {
      await recordPaymentProviderOperationFailed(deps.db, {
        operationKey: operation.operation_key,
        errorMessage: "Provider operation is missing the local payment id needed for support-safe reconciliation.",
      });
      return {
        resolved: true,
        repaired: false,
        attention: {
          kind: "provider-operation",
          operation_key: operation.operation_key,
          reason: "Provider operation is missing a local payment id.",
        },
      };
    }

    const payment = await getPaymentById(deps.db, paymentId);
    if (payment) {
      if (payment.processor_payment_kind === "balance-credit") {
        await recordPaymentProviderOperationSucceeded(deps.db, {
          operationKey: operation.operation_key,
          providerObjectReference: payment.processor_payment_reference,
        });
        return { resolved: true, repaired: false, attention: null };
      }

      const providerResult = await deps.processorGateway.retrievePaymentResult(payment.processor_payment_reference);
      if (!providerResult) {
        return {
          resolved: false,
          repaired: false,
          attention: {
            kind: "provider-operation",
            payment_id: payment.payment_id,
            operation_key: operation.operation_key,
            processor_payment_reference: payment.processor_payment_reference,
            reason: "Provider payment lookup returned no support-safe result for an existing local payment.",
          },
        };
      }

      await recordPaymentProviderOperationSucceeded(deps.db, {
        operationKey: operation.operation_key,
        providerObjectReference: providerResult.processorPaymentReference,
      });
      await recordPaymentProviderIdempotencyKey(deps.db, {
        operationKey: operation.operation_key,
        providerName: providerResult.processorName,
        operationKind: operation.operation_kind,
        accountId: operation.account_id,
        providerObjectReference: providerResult.processorPaymentReference,
        idempotencyKey: operation.idempotency_key,
      });
      const applied = await applyProviderPaymentResult(payment, providerResult, context);
      return { resolved: true, repaired: applied.repaired, attention: applied.attention };
    }

    const providerResult = deps.processorGateway.retrievePaymentResultByPaymentId
      ? await deps.processorGateway.retrievePaymentResultByPaymentId(paymentId as PaymentId)
      : null;
    if (!providerResult) {
      await recordPaymentProviderOperationFailed(deps.db, {
        operationKey: operation.operation_key,
        errorMessage: "Provider payment was not found by support-safe reconciliation lookup.",
      });
      return { resolved: true, repaired: false, attention: null };
    }

    if (providerResult.outcome === "failed" || providerResult.outcome === "cancelled") {
      await recordPaymentProviderOperationFailed(deps.db, {
        operationKey: operation.operation_key,
        errorMessage: `Provider payment was ${providerResult.outcome} before the local payment was recorded.`,
      });
      return { resolved: true, repaired: false, attention: null };
    }

    await recordPaymentProviderOperationSucceeded(deps.db, {
      operationKey: operation.operation_key,
      providerObjectReference: providerResult.processorPaymentReference,
    });
    await recordPaymentProviderIdempotencyKey(deps.db, {
      operationKey: operation.operation_key,
      providerName: providerResult.processorName,
      operationKind: operation.operation_kind,
      accountId: operation.account_id,
      providerObjectReference: providerResult.processorPaymentReference,
      idempotencyKey: operation.idempotency_key,
    });
    return {
      resolved: true,
      repaired: false,
      attention: {
        kind: "provider-operation",
        payment_id: paymentId,
        operation_key: operation.operation_key,
        processor_payment_reference: providerResult.processorPaymentReference,
        provider_status: providerResult.processorStatus,
        reason:
          "Provider payment exists but the local payment aggregate is missing; manual adoption is required to avoid reconstructing money facts from provider metadata.",
      },
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
    async listAccountOrderInputs(params) {
      const accountId = normalizeRequiredText(params.accountId, "Account is required.") as AccountId;
      const orderIds = normalizeOrderIds(params.orderIds);
      const orders = await listPaymentOrderInputs(deps.db, orderIds, accountId);
      const ordersById = new Map(orders.map((order) => [order.order_id, order]));
      return orderIds.map((orderId) => {
        const order = ordersById.get(orderId);
        if (!order) {
          throw new PaymentsDomainError(`Order ${orderId} was not found.`, "order_input_not_ready");
        }
        return order;
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
      const resolved = await resolveMarketplaceCheckoutFeePolicy(deps);
      return marketplaceCheckoutFeePolicy(resolved.value, { effectiveAt: resolved.effectiveFrom });
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
        uiMode: params.uiMode ?? "hosted",
        consentId,
        consentText: SAVE_PAYMENT_CONSENT_TEXT,
        idempotencyKey: `payments:account:${accountId}:setup:${setupReferenceId}`,
      });

      return recordSavedCheckoutSetupSession(deps.db, {
        setupReferenceId,
        accountId,
        agentGrantId: params.agentGrantId ?? null,
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
    async reconcileSavedCheckoutSetupSession(params, context) {
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

      const instrument = await persistProcessorSavedPaymentMethod(deps, {
        accountId,
        providerCustomerReference: setupSession.provider_customer_reference,
        savedPaymentMethod: result.savedPaymentMethod,
        agentGrantId: setupSession.agent_grant_id,
        consentId: setupSession.consent_id,
        consentText: setupSession.consent_text,
        isDefault: true,
        auditAction: "setup-completed",
      });
      await publishCheckoutAffordances(accountId, context);
      return instrument;
    },
    async setSavedCheckoutInstrumentDefault(params, context) {
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
      await publishCheckoutAffordances(accountId, context);
      return getSavedCheckoutInstrument(deps.db, { accountId, instrumentId: instrument.instrument_id });
    },
    async removeSavedCheckoutInstrument(params, context) {
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
      await publishCheckoutAffordances(accountId, context);
      return getSavedCheckoutInstrument(deps.db, { accountId, instrumentId: instrument.instrument_id });
    },
    async revokeSavedCheckoutInstrumentsForAgentGrant(params) {
      const accountId = normalizeRequiredText(params.accountId, "Account is required.") as AccountId;
      const agentGrantId = normalizeRequiredText(params.agentGrantId, "Agent grant is required.");
      const revokedAt = params.revokedAt ?? new Date().toISOString();
      await recordRevokedAgentGrant(deps.db, { accountId, agentGrantId, revokedAt });
      const instruments = await listSavedCheckoutInstrumentsForAgentGrant(deps.db, { accountId, agentGrantId });
      const alreadyRemoved = instruments.filter((instrument) => instrument.readiness === "removed").length;
      let detached = 0;

      for (const instrument of instruments) {
        if (instrument.provider_reference) {
          await deps.processorGateway.detachSavedPaymentMethod(instrument.provider_reference);
          detached += 1;
        }
        await markSavedCheckoutInstrumentRemoved(deps.db, {
          accountId,
          instrumentId: instrument.instrument_id,
          timestamp: revokedAt,
        });
        await recordSavedCheckoutInstrumentAudit(deps.db, {
          auditId: `audit_agent_grant_revoked_${agentGrantId}_${instrument.instrument_id}`,
          instrumentId: instrument.instrument_id,
          accountId,
          action: "agent-grant-revoked",
          reason: agentGrantId,
          performedByAccountId: accountId,
          createdAt: revokedAt,
        });
      }

      return {
        detached,
        alreadyRemoved,
        instrumentIds: instruments.map((instrument) => instrument.instrument_id),
      };
    },
    async reconcileSavedCheckoutInstruments(params, context) {
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
          providerFingerprint: providerMethod.paymentMethodFingerprint ?? instrument.provider_fingerprint ?? null,
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

      if (updated > 0) {
        await publishCheckoutAffordances(accountId, context);
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
      const activeOrderSetPayment = await getActivePaymentByOrderSet(deps.db, orderIds, accountId);
      if (activeOrderSetPayment) {
        if (
          sourceContext &&
          sourceReferenceId &&
          activeOrderSetPayment.source_context === sourceContext &&
          activeOrderSetPayment.source_reference_id === sourceReferenceId
        ) {
          return exposePayment(activeOrderSetPayment);
        }
        throw new PaymentsDomainError(
          "An active payment already exists for this order set.",
          "active_payment_exists_for_order_set",
        );
      }
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
      const paymentMethodCategory = normalizeMarketplaceCheckoutFeePaymentMethodCategory(params.paymentMethodCategory);
      if (paymentMethodCategory === "platform-credit" && compareMoney(externalBasisAmount, "0.00") > 0) {
        throw new PaymentsDomainError(
          "Platform credit must cover the order balance before it can be used as the payment method.",
        );
      }
      const checkoutProcessingFeePolicy = await resolveMarketplaceCheckoutFeePolicy(deps);
      const marketplaceCheckoutFeeQuote = quoteMarketplaceCheckoutFee(
        {
          orderAmount: amount,
          externalBasisAmount,
          balanceCreditAmount,
          paymentMethodCategory,
        },
        checkoutProcessingFeePolicy.value,
      );
      if (params.marketplaceCheckoutFeeQuoteFingerprint !== marketplaceCheckoutFeeQuote.quote_fingerprint) {
        throw new PaymentsDomainError(`fee_quote_stale:${JSON.stringify(marketplaceCheckoutFeeQuote)}`);
      }
      const savedCheckoutInstrument = await resolveSavedCheckoutInstrument(deps.db, {
        accountId,
        instrumentId: params.savedCheckoutInstrumentId,
        paymentMethodCategory,
      });
      enforceCardDeclineVelocity(savedCheckoutInstrument?.provider_fingerprint ?? null);
      const shouldSavePaymentMethod =
        Boolean(params.savePaymentMethodForFuture) &&
        !savedCheckoutInstrument &&
        !params.agenticPayment &&
        paymentMethodCategory !== "platform-credit" &&
        compareMoney(externalBasisAmount, "0.00") > 0;
      const paymentAmount = marketplaceCheckoutFeeQuote.total_amount;
      const processorAmount = marketplaceCheckoutFeeQuote.processor_amount;
      const marketplaceSalesFeeAmount = sumFeeAmounts(orders, "marketplace_sales_fee_amount");
      const authenticityFeeAmount = sumAuthenticityFeeAmounts(orders);
      const marketplaceCheckoutFeeAmount = marketplaceCheckoutFeeQuote.marketplace_checkout_fee_amount;
      const sellerNetAmount = sumFeeAmounts(orders, "seller_net_amount");
      const sellerPayoutAmount = sumFeeAmounts(orders, "seller_payout_amount");
      const sellerPayouts = buildSellerPayoutComponents(orders);
      const orderRefundCaps = buildOrderRefundCaps(orders, marketplaceCheckoutFeeAmount);
      const marketplaceRiskMetadata = buildMarketplaceRiskMetadata(sellerPayouts);
      const accountRisk = await getPaymentAccountRiskSource(deps.db, accountId);
      const cardAuthentication = buildCardAuthenticationAssessment({
        paymentMethodCategory,
        processorAmount,
        marketplaceRiskMetadata,
        accountRisk,
      });
      const paymentId = createId("pay") as PaymentId;
      const createdAt = new Date().toISOString();
      const createAgenticPaymentSession = deps.processorGateway.createAgenticPaymentSession?.bind(
        deps.processorGateway,
      );
      if (params.agenticPayment && !createAgenticPaymentSession) {
        throw new PaymentsDomainError("Agentic payment handoff is not supported by the configured payment processor.");
      }
      const reservation = await reservePaymentCreation(deps.db, {
        paymentId,
        buyerAccountId: accountId,
        orderIds,
        sourceContext,
        sourceReferenceId,
        createdAt,
      });
      if (reservation.outcome === "same-source") {
        return waitForExistingPaymentSnapshot(reservation.reservation.payment_id as PaymentId, accountId);
      }
      if (reservation.outcome === "source-conflict" || reservation.outcome === "same-order-set") {
        throw new PaymentsDomainError(
          "An active payment already exists for this order set.",
          "active_payment_exists_for_order_set",
        );
      }
      let paymentProviderCustomer: ProviderCustomerRow | null = null;
      let savePaymentProviderCustomer: ProviderCustomerRow | null = null;
      if (!params.isGuestCheckout && compareMoney(processorAmount, "0.00") > 0) {
        try {
          paymentProviderCustomer = await ensureProviderCustomer(deps, { accountId });
        } catch (error) {
          await markPaymentCreationReservationInactive(deps.db, {
            paymentId,
            status: "failed",
          });
          throw error;
        }
      }
      if (shouldSavePaymentMethod) {
        savePaymentProviderCustomer = paymentProviderCustomer ?? (await ensureProviderCustomer(deps, { accountId }));
      }
      const returnUrlBase = params.returnUrlBase?.trim().replace(/\/+$/, "") ?? "";
      const returnUrlPath = resolvePaymentReturnPath(params.returnUrlPath, paymentId);
      const providerIdempotencyKey = `payments:payment:${paymentId}:create`;
      const providerOperationKey = `payment:${paymentId}:create`;
      const providerRequest = {
        paymentId,
        buyerAccountId: accountId,
        orderIds,
        amount: processorAmount,
        currencyCode,
        paymentMethodCategory,
        providerCustomerReference: paymentProviderCustomer?.provider_customer_reference ?? null,
        returnUrl: returnUrlBase ? `${returnUrlBase}${returnUrlPath}` : null,
        clientRiskContext: params.clientRiskContext ?? null,
        cardAuthentication,
        marketplaceRiskMetadata,
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
                  providerCustomerReference: providerRequest.providerCustomerReference,
                  description:
                    orderIds.length === 1
                      ? `Chase Sets order ${orderIds[0]}`
                      : `Chase Sets checkout for ${orderIds.length} orders`,
                  returnUrl: returnUrlBase ? `${returnUrlBase}${returnUrlPath}` : null,
                  idempotencyKey: providerIdempotencyKey,
                  clientRiskContext: params.clientRiskContext ?? null,
                  cardAuthentication,
                  marketplaceRiskMetadata,
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
                  providerCustomerReference: providerRequest.providerCustomerReference,
                  description:
                    orderIds.length === 1
                      ? `Chase Sets order ${orderIds[0]}`
                      : `Chase Sets checkout for ${orderIds.length} orders`,
                  returnUrl: returnUrlBase ? `${returnUrlBase}${returnUrlPath}` : null,
                  idempotencyKey: providerIdempotencyKey,
                  clientRiskContext: params.clientRiskContext ?? null,
                  cardAuthentication,
                  marketplaceRiskMetadata,
                  savedCheckoutInstrument: providerRequest.savedCheckoutInstrument,
                  savePaymentMethod: providerRequest.savePaymentMethod,
                });
      } catch (error) {
        await recordPaymentProviderOperationFailed(deps.db, {
          operationKey: providerOperationKey,
          errorMessage: error instanceof Error ? error.message : "Payment processor session creation failed.",
        });
        await markPaymentCreationReservationInactive(deps.db, {
          paymentId,
          status: "failed",
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
          authenticityFeeAmount,
          marketplaceCheckoutFeeAmount,
          marketplaceCheckoutFeePolicyVersion: marketplaceCheckoutFeeQuote.policy_version,
          marketplaceCheckoutFeeQuoteFingerprint: marketplaceCheckoutFeeQuote.quote_fingerprint,
          paymentMethodCategory,
          savedCheckoutInstrumentId: savedCheckoutInstrument?.instrument_id ?? null,
          sellerNetAmount,
          sellerPayoutAmount,
          sellerPayouts,
          orderRefundCaps,
          currencyCode,
          processorName: processorPayment.processorName,
          processorPaymentKind: processorPayment.processorPaymentKind,
          processorPaymentReference: processorPayment.processorPaymentReference,
          processorClientSecret: processorPayment.processorClientSecret,
          processorRedirectUrl: processorPayment.processorRedirectUrl,
          processorStatus: processorPayment.processorStatus,
          sourceContext,
          sourceReferenceId,
          threeDSecureRequest: cardAuthentication?.requestThreeDSecure ?? null,
          threeDSecureReasonCodes: cardAuthentication?.reasonCodes ?? [],
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
        order_refund_caps: orderRefundCaps,
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
        three_d_secure_request: cardAuthentication?.requestThreeDSecure ?? null,
        three_d_secure_reason_codes: cardAuthentication?.reasonCodes ?? [],
        liability_shift_status: null,
        liability_shift_authentication_result: null,
        liability_shift_radar_risk_level: null,
        liability_shift_recorded_at: null,
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
        refunded_amount: "0.00",
        order_refunded_amounts: [],
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
          paymentMethodCategory: normalizeMarketplaceCheckoutFeePaymentMethodCategory(params.paymentMethodCategory),
          agenticPayment: params.agenticPayment ?? null,
          sourceContext: "checkout-recovery",
          sourceReferenceId: checkoutRecoveryReference({
            accountId: params.accountId,
            orderIds,
            currencyCode,
            requestedBalanceCreditAmount,
            paymentMethodCategory: normalizeMarketplaceCheckoutFeePaymentMethodCategory(params.paymentMethodCategory),
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
        paymentMethodCategory: normalizeMarketplaceCheckoutFeePaymentMethodCategory(params.paymentMethodCategory),
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
    async scanPaymentsNeedingReconciliation(params, context) {
      const startedAt = new Date().toISOString();
      const reconciliationContext =
        context ??
        ({
          tenantId: "tnt_identity" as never,
          audit: {
            performedByUserId: "usr_identity_system" as never,
            forAccountId: "acc_identity_system" as never,
          },
        } satisfies EventStoreContext);
      const payments = await listPaymentsNeedingReconciliation(deps.db, params);
      const providerOperations = await listPaymentProviderOperationsNeedingReconciliation(deps.db, params);
      const attentionItems: PaymentReconciliationAttentionItem[] = [];
      let repaired = 0;
      let providerOperationsResolved = 0;

      for (const payment of payments) {
        const providerResult = await deps.processorGateway.retrievePaymentResult(payment.processor_payment_reference);
        if (!providerResult) {
          attentionItems.push({
            kind: "payment",
            payment_id: payment.payment_id,
            processor_payment_reference: payment.processor_payment_reference,
            reason: "Provider payment lookup returned no support-safe result.",
          });
          continue;
        }

        const outcome = await applyProviderPaymentResult(payment, providerResult, reconciliationContext);
        if (outcome.repaired) {
          repaired += 1;
        }
        if (outcome.attention) {
          attentionItems.push(outcome.attention);
        }
      }

      for (const operation of providerOperations) {
        const outcome = await reconcileProviderOperation(operation, reconciliationContext);
        if (outcome.resolved) {
          providerOperationsResolved += 1;
        }
        if (outcome.repaired) {
          repaired += 1;
        }
        if (outcome.attention) {
          attentionItems.push(outcome.attention);
        }
      }

      const result = {
        checked: payments.length,
        repaired,
        attention: attentionItems.length,
        payment_ids: payments.map((payment) => payment.payment_id),
        provider_operations_checked: providerOperations.length,
        provider_operations_resolved: providerOperationsResolved,
        attention_items: attentionItems,
      };
      await recordPaymentReconciliationRun(deps.db, {
        reconciliationRunId: createId("rec"),
        kind: "payments",
        checked: result.checked,
        attention: result.attention,
        status: result.attention > 0 ? "attention-required" : "completed",
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
      const inboxEntry = {
        tableName: "payments_provider_webhook_events",
        providerEventId: webhookEvent.eventId,
        providerName: webhookEvent.processorName,
        eventKind: webhookEvent.kind,
        providerObjectReference:
          webhookEvent.kind === "shared-payment-token-used" || webhookEvent.kind === "shared-payment-token-deactivated"
            ? (webhookEvent.providerObjectReference ??
              webhookEvent.internalPaymentId ??
              webhookEvent.processorPaymentReference)
            : (webhookEvent.internalPaymentId ??
              webhookEvent.providerObjectReference ??
              webhookEvent.processorPaymentReference),
      };
      const alreadyProcessed = await hasProcessedProviderWebhookEvent(deps.db, inboxEntry);
      if (alreadyProcessed) {
        return { received: true, ignored: true };
      }
      const recordProcessed = () => recordProviderWebhookEvent(deps.db, inboxEntry);

      if (
        webhookEvent.kind === "shared-payment-token-used" ||
        webhookEvent.kind === "shared-payment-token-deactivated"
      ) {
        await recordProcessed();
        return { received: true, ignored: true };
      }

      if (webhookEvent.kind === "saved-payment-setup-succeeded") {
        const setupReference = webhookEvent.processorSetupReference ?? webhookEvent.processorPaymentReference;
        const setupSession = await getSavedCheckoutSetupSessionByProcessorReference(deps.db, setupReference);
        if (!setupSession) {
          throw new PaymentsDomainError(
            "Payment webhook setup session was not found.",
            "payment_webhook_target_not_ready",
          );
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
            agentGrantId: setupSession.agent_grant_id,
            consentId: setupSession.consent_id,
            consentText: setupSession.consent_text,
            isDefault: true,
            auditAction: "setup-webhook-saved",
          });
        }
        await recordProcessed();
        return { received: true, ignored: false };
      }

      if (webhookEvent.kind === "saved-payment-setup-failed") {
        const setupReference = webhookEvent.processorSetupReference ?? webhookEvent.processorPaymentReference;
        const setupSession = await getSavedCheckoutSetupSessionByProcessorReference(deps.db, setupReference);
        if (!setupSession) {
          throw new PaymentsDomainError(
            "Payment webhook setup session was not found.",
            "payment_webhook_target_not_ready",
          );
        }
        await completeSavedCheckoutSetupSession(deps.db, {
          processorSetupReference: setupReference,
          processorStatus: webhookEvent.processorStatus,
          completedAt: webhookEvent.occurredAt,
        });
        await recordProcessed();
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
          await recordProcessed();
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
        throw new PaymentsDomainError("Payment webhook target was not found.", "payment_webhook_target_not_ready");
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
          recordCardDeclineVelocity(webhookEvent.savedPaymentMethod);
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
          await markPaymentCreationReservationInactive(deps.db, {
            paymentId: payment.payment_id,
            status: "failed",
            updatedAt: webhookEvent.occurredAt,
          });
          break;
        case "payment-cancelled":
          if (
            webhookEvent.processorPaymentKind !== "payment-intent" ||
            payment.processor_payment_kind !== "payment-intent"
          ) {
            await recordProcessed();
            return { received: true, ignored: true };
          }
          await commandHandler({
            streamId,
            command: {
              type: "CancelPayment",
              cancelledAt: webhookEvent.occurredAt,
            },
            context,
          });
          await markPaymentCreationReservationInactive(deps.db, {
            paymentId: payment.payment_id,
            status: "released",
            updatedAt: webhookEvent.occurredAt,
          });
          break;
        case "payment-refunded":
          if (webhookEvent.refundId) {
            await refundCommandHandler({
              streamId: `payments.refund-${webhookEvent.refundId}`,
              command: {
                type: "RecordRefundIssued",
                processorRefundReference:
                  webhookEvent.processorRefundReference ?? webhookEvent.providerObjectReference ?? "",
                processorStatus: webhookEvent.processorStatus,
                issuedAt: webhookEvent.occurredAt,
              },
              context,
            });
          }
          await commandHandler({
            streamId,
            command: {
              type: "RecordPaymentRefund",
              refundId: webhookEvent.refundId ? (webhookEvent.refundId as RefundId) : null,
              orderIds: webhookEvent.orderIds ?? [],
              processorStatus: webhookEvent.processorStatus,
              processorRefundReference:
                webhookEvent.processorRefundReference ?? webhookEvent.providerObjectReference ?? null,
              amount: webhookEvent.amount ?? null,
              refundedAmount: webhookEvent.refundedAmount ?? null,
              refundedAt: webhookEvent.occurredAt,
            },
            context,
          });
          break;
        case "payment-early-fraud-warning":
          await commandHandler({
            streamId,
            command: {
              type: "RecordPaymentEarlyFraudWarning",
              providerEventId: webhookEvent.eventId,
              earlyFraudWarningId: webhookEvent.providerObjectReference ?? webhookEvent.eventId,
              providerChargeReference: webhookEvent.providerChargeReference ?? null,
              processorStatus: webhookEvent.processorStatus,
              fraudType: webhookEvent.fraudType ?? webhookEvent.failureCode,
              chargeDisputed: Boolean(webhookEvent.chargeDisputed),
              receivedAt: webhookEvent.occurredAt,
            },
            context,
          });
          if (
            deps.refunds &&
            webhookEvent.chargeDisputed === false &&
            !payment.disputed_at &&
            (payment.status === "captured" || payment.status === "partially-refunded")
          ) {
            const refundableAmount = subtractMoney(payment.amount, payment.refunded_amount);
            if (compareMoney(refundableAmount, "0.00") > 0) {
              await deps.refunds.issueRefund(
                {
                  refundId: fraudRefundId(webhookEvent.providerObjectReference ?? webhookEvent.eventId),
                  paymentId: payment.payment_id as PaymentId,
                  orderIds: payment.order_ids,
                  amount: refundableAmount,
                  reason: `Stripe early fraud warning ${webhookEvent.providerObjectReference ?? webhookEvent.eventId}.`,
                },
                context,
              );
            }
          }
          break;
        case "payment-fraud-review-opened":
          await commandHandler({
            streamId,
            command: {
              type: "RecordPaymentFraudReviewOpened",
              providerEventId: webhookEvent.eventId,
              providerReviewId: webhookEvent.providerObjectReference ?? webhookEvent.eventId,
              providerChargeReference: webhookEvent.providerChargeReference ?? null,
              processorStatus: webhookEvent.processorStatus,
              reason: webhookEvent.fraudReviewReason ?? webhookEvent.failureCode,
              openedAt: webhookEvent.occurredAt,
            },
            context,
          });
          break;
        case "payment-fraud-review-closed":
          await commandHandler({
            streamId,
            command: {
              type: "RecordPaymentFraudReviewClosed",
              providerEventId: webhookEvent.eventId,
              providerReviewId: webhookEvent.providerObjectReference ?? webhookEvent.eventId,
              providerChargeReference: webhookEvent.providerChargeReference ?? null,
              processorStatus: webhookEvent.processorStatus,
              reason: webhookEvent.fraudReviewReason ?? webhookEvent.failureCode,
              outcome: webhookEvent.fraudReviewOutcome,
              closedAt: webhookEvent.occurredAt,
            },
            context,
          });
          break;
        case "payment-disputed":
          await commandHandler({
            streamId,
            command: {
              type: "RecordPaymentDispute",
              providerEventId: webhookEvent.eventId,
              providerDisputeId: webhookEvent.providerObjectReference ?? webhookEvent.eventId,
              providerChargeReference: webhookEvent.providerChargeReference ?? null,
              processorStatus: webhookEvent.processorStatus,
              disputeStatus: webhookEvent.failureCode,
              disputeMessage: webhookEvent.disputeStatus ?? webhookEvent.failureMessage,
              disputeLifecycleState: webhookEvent.disputeLifecycleState,
              disputeReason: webhookEvent.disputeReason,
              disputeEvidenceDueAt: webhookEvent.disputeEvidenceDueAt,
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

      if (webhookEvent.liabilityShiftOutcome) {
        await commandHandler({
          streamId,
          command: {
            type: "RecordPaymentLiabilityShiftOutcome",
            providerEventId: webhookEvent.eventId,
            threeDSecureRequested: webhookEvent.liabilityShiftOutcome.threeDSecureRequested,
            status: webhookEvent.liabilityShiftOutcome.status,
            authenticationResult: webhookEvent.liabilityShiftOutcome.authenticationResult,
            radarRiskLevel: webhookEvent.liabilityShiftOutcome.radarRiskLevel ?? null,
            recordedAt: webhookEvent.occurredAt,
          },
          context,
        });
      }

      await recordProcessed();
      return { received: true, ignored: false };
    },
    submitDisputeEvidence: (dispute, context) =>
      submitPaymentDisputeEvidence(
        {
          db: deps.db,
          processorGateway: deps.processorGateway,
          commandHandler,
        },
        dispute,
        context,
      ),
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
      createProjectionHandlerSet({
        projectionName: PAYMENTS_FRAUD_ALERT_PROJECTION,
        handlers: buildPaymentFraudAlertProjectionHandlers(notificationOutbox, PAYMENTS_FRAUD_ALERT_PROJECTION),
      }),
    ],
  };
}
