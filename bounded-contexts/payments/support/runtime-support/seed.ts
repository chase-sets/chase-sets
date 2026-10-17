import type { BcSeedAggregateStateReport } from "@chase-sets/bounded-context-module";
import { loadSeedStreamEvents } from "@chase-sets/bounded-context-runtime";
import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  evolvePayment,
  initialPaymentState,
  type PaymentEvent,
  type PaymentState,
} from "../../features/payments/domain/domain";
import {
  evolveRefund,
  initialRefundState,
  type RefundEvent,
  type RefundState,
} from "../../features/refunds/domain/domain";
import { identitySeedIds } from "@chase-sets/identity-seed";
import { marketplaceReservedSeedIds, reputationReservedSeedIds } from "@chase-sets/marketplace/seed-support/ids";
import { orderingReservedSeedIds } from "@chase-sets/ordering/seed-support/ids";
import { paymentsReservedSeedIds } from "@chase-sets/payments/seed-support/ids";
import { createPaymentsServices } from "./services";
import type { PaymentId, AccountId, OrderId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { RefundId } from "./common";
import { normalizeCurrencyCode, normalizeMoneyAmount } from "./common";

type OrderRow = Readonly<{
  order_id: string;
  buyer_account_id: string;
  seller_account_id: string;
  total_amount: string;
  marketplace_sales_fee_amount: string;
  marketplace_checkout_fee_amount: string;
  seller_net_amount: string;
  seller_item_net_amount: string;
  shipping_allowance_amount: string;
  seller_shipping_payout_amount: string;
  protection_amount: string;
  protection_allowance_amount: string;
  protection_overage_amount: string;
  seller_payout_amount: string;
}>;

class SeedOrderMissingError extends Error {}

function logWaitingForSeedOrder(orderDescription: string) {
  console.log(`Payments seed is waiting for ${orderDescription}. Skipping dependent payment data for this pass.`);
}

function createSeedContext(accountId: string, userId: string): EventStoreContext {
  return {
    tenantId: "tnt_seed_development" as TenantId,
    audit: {
      performedByUserId: userId as UserId,
      forAccountId: accountId as AccountId,
    },
  };
}

async function getSeedOrder(pool: PgTransactionalPool, orderId: string, buyerAccountId: string): Promise<OrderRow> {
  const result = await pool.query<OrderRow & Readonly<{ status: string }>>(
    `SELECT
       order_id,
       buyer_account_id,
       seller_account_id,
       total_amount::text AS total_amount,
       marketplace_sales_fee_amount::text AS marketplace_sales_fee_amount,
       marketplace_checkout_fee_amount::text AS marketplace_checkout_fee_amount,
       seller_net_amount::text AS seller_net_amount,
       seller_item_net_amount::text AS seller_item_net_amount,
       shipping_allowance_amount::text AS shipping_allowance_amount,
       seller_shipping_payout_amount::text AS seller_shipping_payout_amount,
       protection_amount::text AS protection_amount,
       protection_allowance_amount::text AS protection_allowance_amount,
       protection_overage_amount::text AS protection_overage_amount,
       seller_payout_amount::text AS seller_payout_amount,
       status
     FROM payments_order_inputs
     WHERE order_id = $1
       AND buyer_account_id = $2`,
    [orderId, buyerAccountId],
  );
  const order = result.rows[0];

  if (!order) {
    throw new SeedOrderMissingError(`Payments seed requires order ${orderId} to exist.`);
  }

  return requirePendingPaymentOrder(order, `order ${orderId}`);
}

function requirePendingPaymentOrder(order: OrderRow & Readonly<{ status: string }>, description: string): OrderRow {
  if (order.status !== "pending-payment") {
    throw new Error(`Payments seed requires ${description} to be in pending-payment status.`);
  }

  return {
    order_id: order.order_id,
    buyer_account_id: order.buyer_account_id,
    seller_account_id: order.seller_account_id,
    total_amount: order.total_amount,
    marketplace_sales_fee_amount: order.marketplace_sales_fee_amount,
    marketplace_checkout_fee_amount: order.marketplace_checkout_fee_amount,
    seller_net_amount: order.seller_net_amount,
    seller_item_net_amount: order.seller_item_net_amount,
    shipping_allowance_amount: order.shipping_allowance_amount,
    seller_shipping_payout_amount: order.seller_shipping_payout_amount,
    protection_amount: order.protection_amount,
    protection_allowance_amount: order.protection_allowance_amount,
    protection_overage_amount: order.protection_overage_amount,
    seller_payout_amount: order.seller_payout_amount,
  };
}

async function getSeedOrderForSource(
  pool: PgTransactionalPool,
  sourceType: "cart-checkout" | "offer-acceptance" | "buy-now",
  sourceReferenceId: string,
  buyerAccountId: string,
): Promise<OrderRow | null> {
  const result = await pool.query<OrderRow & Readonly<{ status: string }>>(
    `SELECT
       order_id,
       buyer_account_id,
       seller_account_id,
       total_amount::text AS total_amount,
       marketplace_sales_fee_amount::text AS marketplace_sales_fee_amount,
       marketplace_checkout_fee_amount::text AS marketplace_checkout_fee_amount,
       seller_net_amount::text AS seller_net_amount,
       seller_item_net_amount::text AS seller_item_net_amount,
       shipping_allowance_amount::text AS shipping_allowance_amount,
       seller_shipping_payout_amount::text AS seller_shipping_payout_amount,
       protection_amount::text AS protection_amount,
       protection_allowance_amount::text AS protection_allowance_amount,
       protection_overage_amount::text AS protection_overage_amount,
       seller_payout_amount::text AS seller_payout_amount,
       status
     FROM payments_order_inputs
     WHERE source_type = $1
       AND source_reference_id = $2
       AND buyer_account_id = $3
     ORDER BY order_id ASC
     LIMIT 1`,
    [sourceType, sourceReferenceId, buyerAccountId],
  );
  const order = result.rows[0];

  return order ? requirePendingPaymentOrder(order, `${sourceType} ${sourceReferenceId}`) : null;
}

async function getSeedOrderIfAvailable(
  pool: PgTransactionalPool,
  orderId: string,
  buyerAccountId: string,
): Promise<OrderRow | null> {
  try {
    return await getSeedOrder(pool, orderId, buyerAccountId);
  } catch (error) {
    if (error instanceof SeedOrderMissingError) {
      logWaitingForSeedOrder(`order ${orderId} to be projected`);
      return null;
    }
    throw error;
  }
}

async function getAcceptedOfferSeedOrder(pool: PgTransactionalPool): Promise<OrderRow | null> {
  try {
    return await getSeedOrder(
      pool,
      orderingReservedSeedIds.orders.acceptedOfferReady,
      identitySeedIds.collector.accountId,
    );
  } catch (error) {
    if (!(error instanceof SeedOrderMissingError)) {
      throw error;
    }

    const sourceType = "offer-acceptance";
    const sourceReferenceId = marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerSubmitted;
    const sourceOrder = await getSeedOrderForSource(
      pool,
      sourceType,
      sourceReferenceId,
      identitySeedIds.collector.accountId,
    );

    if (!sourceOrder) {
      logWaitingForSeedOrder(`accepted-offer order ${sourceReferenceId} to be projected`);
      return null;
    }

    return sourceOrder;
  }
}

async function getReviewEligibleSeedOrder(pool: PgTransactionalPool): Promise<OrderRow | null> {
  try {
    return await getSeedOrder(
      pool,
      reputationReservedSeedIds.orders.reviewEligibleDelivered,
      identitySeedIds.collector.accountId,
    );
  } catch (error) {
    if (!(error instanceof SeedOrderMissingError)) {
      throw error;
    }

    const sourceType = "offer-acceptance";
    const sourceReferenceId = marketplaceReservedSeedIds.offers.twilightMasqueradeEliteTrainerEncore;
    const sourceOrder = await getSeedOrderForSource(
      pool,
      sourceType,
      sourceReferenceId,
      identitySeedIds.collector.accountId,
    );

    if (!sourceOrder) {
      logWaitingForSeedOrder(`review-eligible order ${sourceReferenceId} to be projected`);
      return null;
    }

    return sourceOrder;
  }
}

async function seedSavedCheckoutInstruments(pool: PgTransactionalPool) {
  await pool.query(
    `INSERT INTO payments_provider_customers (
       account_id,
       provider,
       provider_customer_reference,
       display_name,
       email,
       created_at,
       updated_at
     ) VALUES ($1, 'stripe', 'cus_seed_collector', 'Seed collector', NULL, '2026-03-20T08:55:00.000Z', '2026-03-20T08:55:00.000Z')
     ON CONFLICT (account_id, provider) DO UPDATE SET
       provider_customer_reference = EXCLUDED.provider_customer_reference,
       updated_at = EXCLUDED.updated_at`,
    [identitySeedIds.collector.accountId],
  );
  await pool.query(
    `INSERT INTO payments_saved_checkout_instruments (
       instrument_id,
       account_id,
       payment_method_category,
       provider,
       provider_customer_reference,
       provider_reference,
       display_label,
       confirmation_experience,
       readiness,
       allow_redisplay,
       consent_id,
       consent_text,
       is_default,
       created_at,
       updated_at
     )
     VALUES
       (
         'sci_seed_collector_card',
         $1,
         'card',
         'stripe',
         'cus_seed_collector',
         'pm_seed_collector_card',
         'Visa ending in 4242',
         'off-session-token',
         'ready',
         'always',
         'consent_seed_collector_card',
         'Save this payment method for future Chase Sets checkout.',
         true,
         '2026-03-20T09:00:00.000Z',
         '2026-03-20T09:00:00.000Z'
       ),
       (
         'sci_seed_collector_bank',
         $1,
         'bank-account',
         'stripe',
         'cus_seed_collector',
         'pm_seed_collector_bank',
         'Bank account ending in 6789',
         'trusted-payment-step',
         'ready',
         'always',
         'consent_seed_collector_bank',
         'Save this payment method for future Chase Sets checkout.',
         false,
         '2026-03-20T09:05:00.000Z',
         '2026-03-20T09:05:00.000Z'
       )
     ON CONFLICT (instrument_id) DO UPDATE SET
       display_label = EXCLUDED.display_label,
       provider_customer_reference = EXCLUDED.provider_customer_reference,
       confirmation_experience = EXCLUDED.confirmation_experience,
       readiness = EXCLUDED.readiness,
       allow_redisplay = EXCLUDED.allow_redisplay,
       consent_id = EXCLUDED.consent_id,
       consent_text = EXCLUDED.consent_text,
       is_default = EXCLUDED.is_default,
       updated_at = EXCLUDED.updated_at`,
    [identitySeedIds.collector.accountId],
  );
}

const PAYMENTS_BOOTSTRAP_LABEL = "Payments seed bootstrap";

const paymentStreamId = (paymentId: string) => `payments.payment-${paymentId}`;
const refundStreamId = (refundId: string) => `payments.refund-${refundId}`;

/**
 * Folds one seeded payment from its own `payments.payment-*` stream.
 *
 * `payments_payment_pages` is UNLOGGED, so PostgreSQL truncates it on crash
 * recovery while the logged streams survive. The projection-sourced guard this
 * replaced answered a single all-or-nothing question across five independent
 * payments and two refunds; a partially seeded set was therefore re-authored
 * into existing aggregates. Each payment and refund is now decided on its own
 * committed events, and the processor session is only opened for a payment the
 * stream does not already carry.
 */
async function loadSeedPaymentState(db: PgQueryable, paymentId: string): Promise<PaymentState> {
  const committed = await loadSeedStreamEvents<PaymentEvent>(db, paymentStreamId(paymentId));
  return committed.reduce(evolvePayment, initialPaymentState);
}

async function loadSeedRefundState(db: PgQueryable, refundId: string): Promise<RefundState> {
  const committed = await loadSeedStreamEvents<RefundEvent>(db, refundStreamId(refundId));
  return committed.reduce(evolveRefund, initialRefundState);
}

const seedPaymentInventory = [
  { id: paymentsReservedSeedIds.payments.checkoutPending, key: "checkout-pending", expectedStatus: null },
  {
    id: paymentsReservedSeedIds.payments.failedModernCheckout,
    key: "failed-modern-checkout",
    expectedStatus: "failed",
  },
  {
    id: paymentsReservedSeedIds.payments.cancelledVintageCheckout,
    key: "cancelled-vintage-checkout",
    expectedStatus: "cancelled",
  },
  {
    id: paymentsReservedSeedIds.payments.acceptedOfferCaptured,
    key: "accepted-offer-captured",
    expectedStatus: "captured",
  },
  {
    id: paymentsReservedSeedIds.payments.reviewEligibleCaptured,
    key: "review-eligible-captured",
    expectedStatus: "captured",
  },
] as const;

const seedRefundInventory = [
  { id: paymentsReservedSeedIds.refunds.acceptedOfferIssued, key: "accepted-offer-issued" },
  { id: paymentsReservedSeedIds.refunds.acceptedOfferFailed, key: "accepted-offer-failed" },
] as const;

/**
 * Reports the Payments seed's base aggregate state from the authoritative
 * `payments.*` streams.
 */
export async function inspectPaymentsSeedState(
  pool: PgTransactionalPool,
): Promise<readonly BcSeedAggregateStateReport[]> {
  const reports: BcSeedAggregateStateReport[] = [];

  for (const payment of seedPaymentInventory) {
    const committed = await loadSeedStreamEvents<PaymentEvent>(pool, paymentStreamId(payment.id));
    const state = committed.reduce(evolvePayment, initialPaymentState);
    const complete =
      state.paymentId !== null && (payment.expectedStatus === null || state.status === payment.expectedStatus);
    reports.push({
      contextName: "payments",
      aggregateName: "Payment",
      id: payment.id,
      key: payment.key,
      streamId: paymentStreamId(payment.id),
      kind: state.paymentId === null ? "absent" : complete ? "active" : "draft",
      status: state.status,
      eventCount: committed.length,
    });
  }

  for (const refund of seedRefundInventory) {
    const committed = await loadSeedStreamEvents<RefundEvent>(pool, refundStreamId(refund.id));
    const state = committed.reduce(evolveRefund, initialRefundState);
    const complete = state.status === "issued" || state.status === "failed";
    reports.push({
      contextName: "payments",
      aggregateName: "Refund",
      id: refund.id,
      key: refund.key,
      streamId: refundStreamId(refund.id),
      kind: state.refundId === null ? "absent" : complete ? "active" : "draft",
      status: state.status,
      eventCount: committed.length,
    });
  }

  return reports;
}

type SeedPaymentProcessorGateway = NonNullable<
  NonNullable<Parameters<typeof createPaymentsServices>[1]>["processorGateway"]
>;

export async function seedPaymentsDatabase(pool: PgTransactionalPool) {
  const { createFakePaymentProcessorGateway } = await import("@chase-sets/payment-processing/test-support");
  const processorGateway = createFakePaymentProcessorGateway();
  const services = createPaymentsServices(pool, {
    processorGateway,
  });

  await seedSavedCheckoutInstruments(pool);

  // Upstream order snapshots are a precondition only for payments this seed has
  // still to create. Existing payment streams can resume status transitions
  // after their order has legitimately moved past `pending-payment`.
  const paymentsRemaining = !(await everySeedPaymentComplete(services.db));
  let pendingCheckoutOrder: OrderRow | null = null;
  let acceptedOfferOrder: OrderRow | null = null;
  let reviewEligibleOrder: OrderRow | null = null;
  if (paymentsRemaining) {
    const pendingCheckoutOrderNeeded =
      (await seedPaymentNeedsCreation(services.db, paymentsReservedSeedIds.payments.checkoutPending)) ||
      (await seedPaymentNeedsCreation(services.db, paymentsReservedSeedIds.payments.failedModernCheckout)) ||
      (await seedPaymentNeedsCreation(services.db, paymentsReservedSeedIds.payments.cancelledVintageCheckout));
    if (pendingCheckoutOrderNeeded) {
      pendingCheckoutOrder = await getSeedOrderIfAvailable(
        pool,
        orderingReservedSeedIds.orders.checkoutPending,
        identitySeedIds.collector.accountId,
      );
      if (!pendingCheckoutOrder) {
        return;
      }
    }

    const acceptedOfferOrderNeeded = await seedPaymentNeedsCreation(
      services.db,
      paymentsReservedSeedIds.payments.acceptedOfferCaptured,
    );
    if (acceptedOfferOrderNeeded) {
      acceptedOfferOrder = await getAcceptedOfferSeedOrder(pool);
      if (!acceptedOfferOrder) {
        return;
      }
    }

    const reviewEligibleOrderNeeded = await seedPaymentNeedsCreation(
      services.db,
      paymentsReservedSeedIds.payments.reviewEligibleCaptured,
    );
    if (reviewEligibleOrderNeeded) {
      reviewEligibleOrder = await getReviewEligibleSeedOrder(pool);
      if (!reviewEligibleOrder) {
        return;
      }
    }
  }

  const buyerContext = createSeedContext(identitySeedIds.collector.accountId, identitySeedIds.collector.userId);
  const sellerContext = createSeedContext(identitySeedIds.demo.accountId, identitySeedIds.demo.userId);

  const ensurePayment = async (
    paymentId: PaymentId,
    order: OrderRow | null,
    createdAt: string,
  ): Promise<PaymentState> => {
    const existing = await loadSeedPaymentState(services.db, paymentId);
    if (existing.paymentId !== null) {
      return existing;
    }
    if (!order) {
      throw new Error(`${PAYMENTS_BOOTSTRAP_LABEL} Payment '${paymentId}' is absent without its required seed order.`);
    }

    const processorPayment = await processorGateway.createPaymentSession({
      paymentId,
      buyerAccountId: order.buyer_account_id as AccountId,
      orderIds: [order.order_id as OrderId],
      amount: normalizeMoneyAmount(order.total_amount, { allowZero: true }),
      currencyCode: normalizeCurrencyCode("usd"),
      paymentMethodCategory: "card",
      description: `Seed payment ${paymentId}`,
    });

    await services.payments.commandHandler({
      streamId: paymentStreamId(paymentId),
      command: {
        type: "CreatePayment",
        paymentId,
        buyerAccountId: order.buyer_account_id as AccountId,
        orderIds: [order.order_id as OrderId],
        amount: normalizeMoneyAmount(order.total_amount, { allowZero: true }),
        marketplaceSalesFeeAmount: normalizeMoneyAmount(order.marketplace_sales_fee_amount, {
          allowZero: true,
        }),
        marketplaceCheckoutFeeAmount: normalizeMoneyAmount(order.marketplace_checkout_fee_amount, {
          allowZero: true,
        }),
        marketplaceCheckoutFeePolicyVersion: "seed",
        marketplaceCheckoutFeeQuoteFingerprint: "seed",
        paymentMethodCategory: "card",
        sellerNetAmount: normalizeMoneyAmount(order.seller_net_amount, {
          allowZero: true,
        }),
        sellerPayoutAmount: normalizeMoneyAmount(order.seller_payout_amount, {
          allowZero: true,
        }),
        sellerPayouts: [
          {
            orderId: order.order_id as OrderId,
            sellerAccountId: order.seller_account_id as AccountId,
            sellerItemNetAmount: normalizeMoneyAmount(order.seller_item_net_amount, {
              allowZero: true,
            }),
            shippingAllowanceAmount: normalizeMoneyAmount(order.shipping_allowance_amount, {
              allowZero: true,
            }),
            sellerShippingPayoutAmount: normalizeMoneyAmount(order.seller_shipping_payout_amount, {
              allowZero: true,
            }),
            protectionAmount: normalizeMoneyAmount(order.protection_amount, {
              allowZero: true,
            }),
            protectionAllowanceAmount: normalizeMoneyAmount(order.protection_allowance_amount, {
              allowZero: true,
            }),
            protectionOverageAmount: normalizeMoneyAmount(order.protection_overage_amount, {
              allowZero: true,
            }),
            sellerPayoutAmount: normalizeMoneyAmount(order.seller_payout_amount, {
              allowZero: true,
            }),
          },
        ],
        currencyCode: "usd",
        processorName: processorPayment.processorName,
        processorPaymentKind: processorPayment.processorPaymentKind,
        processorPaymentReference: processorPayment.processorPaymentReference,
        processorClientSecret: processorPayment.processorClientSecret,
        processorRedirectUrl: processorPayment.processorRedirectUrl,
        processorStatus: processorPayment.processorStatus,
        createdAt,
      },
      context: buyerContext,
    });

    return loadSeedPaymentState(services.db, paymentId);
  };

  if (paymentsRemaining) {
    await seedReservedPayments(ensurePayment, services, buyerContext, {
      pendingCheckoutOrder,
      acceptedOfferOrder,
      reviewEligibleOrder,
    });
  }

  await seedReservedRefunds(services, processorGateway, sellerContext);
}

type SeedPaymentEnsurer = (paymentId: PaymentId, order: OrderRow | null, createdAt: string) => Promise<PaymentState>;

async function seedPaymentNeedsCreation(db: PgQueryable, paymentId: PaymentId): Promise<boolean> {
  return (await loadSeedPaymentState(db, paymentId)).paymentId === null;
}

async function everySeedPaymentComplete(db: PgQueryable): Promise<boolean> {
  for (const payment of seedPaymentInventory) {
    const state = await loadSeedPaymentState(db, payment.id);
    if (state.paymentId === null) {
      return false;
    }
    if (payment.expectedStatus !== null && state.status !== payment.expectedStatus) {
      return false;
    }
  }
  return true;
}

async function seedReservedPayments(
  ensurePayment: SeedPaymentEnsurer,
  services: ReturnType<typeof createPaymentsServices>,
  buyerContext: EventStoreContext,
  orders: Readonly<{
    pendingCheckoutOrder: OrderRow | null;
    acceptedOfferOrder: OrderRow | null;
    reviewEligibleOrder: OrderRow | null;
  }>,
): Promise<void> {
  const { pendingCheckoutOrder, acceptedOfferOrder, reviewEligibleOrder } = orders;

  await ensurePayment(
    paymentsReservedSeedIds.payments.checkoutPending,
    pendingCheckoutOrder,
    "2026-03-20T10:00:00.000Z",
  );

  const failedPayment = await ensurePayment(
    paymentsReservedSeedIds.payments.failedModernCheckout,
    pendingCheckoutOrder,
    "2026-03-20T10:05:00.000Z",
  );
  if (failedPayment.status !== "failed") {
    await services.payments.commandHandler({
      streamId: paymentStreamId(paymentsReservedSeedIds.payments.failedModernCheckout),
      command: {
        type: "RecordPaymentFailure",
        processorStatus: "failed",
        failureCode: "card_declined",
        failureMessage: "Seeded card decline.",
        failedAt: "2026-03-20T10:06:00.000Z",
      },
      context: buyerContext,
    });
  }

  const cancelledPayment = await ensurePayment(
    paymentsReservedSeedIds.payments.cancelledVintageCheckout,
    pendingCheckoutOrder,
    "2026-03-20T10:10:00.000Z",
  );
  if (cancelledPayment.status !== "cancelled") {
    await services.payments.commandHandler({
      streamId: paymentStreamId(paymentsReservedSeedIds.payments.cancelledVintageCheckout),
      command: {
        type: "CancelPayment",
        cancelledAt: "2026-03-20T10:11:00.000Z",
      },
      context: buyerContext,
    });
  }

  const capturedPayment = await ensurePayment(
    paymentsReservedSeedIds.payments.acceptedOfferCaptured,
    acceptedOfferOrder,
    "2026-03-20T11:00:00.000Z",
  );
  if (capturedPayment.status !== "captured") {
    await services.payments.commandHandler({
      streamId: paymentStreamId(paymentsReservedSeedIds.payments.acceptedOfferCaptured),
      command: {
        type: "RecordPaymentCapture",
        processorStatus: "succeeded",
        capturedAt: "2026-03-20T11:05:00.000Z",
      },
      context: buyerContext,
    });
  }

  const reviewEligiblePayment = await ensurePayment(
    paymentsReservedSeedIds.payments.reviewEligibleCaptured,
    reviewEligibleOrder,
    "2026-03-20T11:30:00.000Z",
  );
  if (reviewEligiblePayment.status !== "captured") {
    await services.payments.commandHandler({
      streamId: paymentStreamId(paymentsReservedSeedIds.payments.reviewEligibleCaptured),
      command: {
        type: "RecordPaymentCapture",
        processorStatus: "succeeded",
        capturedAt: "2026-03-20T11:35:00.000Z",
      },
      context: buyerContext,
    });
  }
}

/**
 * Seeds both reserved refunds from the captured payment's own committed stream,
 * so a refund resumes on a later pass without re-reading an order projection
 * that the capture has already moved on.
 */
async function seedReservedRefunds(
  services: ReturnType<typeof createPaymentsServices>,
  processorGateway: SeedPaymentProcessorGateway,
  sellerContext: EventStoreContext,
): Promise<void> {
  const capturedPayment = await loadSeedPaymentState(
    services.db,
    paymentsReservedSeedIds.payments.acceptedOfferCaptured,
  );
  if (capturedPayment.status !== "captured") {
    logWaitingForSeedOrder(`payment ${paymentsReservedSeedIds.payments.acceptedOfferCaptured} to be captured`);
    return;
  }

  const capturedOrderId = capturedPayment.orderIds[0];
  const capturedAmount = capturedPayment.amount;
  const capturedProcessorPaymentReference = capturedPayment.processorPaymentReference;
  const capturedProcessorName = capturedPayment.processorName;
  if (!capturedProcessorPaymentReference || !capturedProcessorName || !capturedOrderId || !capturedAmount) {
    throw new Error(
      `${PAYMENTS_BOOTSTRAP_LABEL} Payment '${paymentsReservedSeedIds.payments.acceptedOfferCaptured}' has no committed ` +
        `processor reference to issue seeded refunds against. Stream ` +
        `'${paymentStreamId(paymentsReservedSeedIds.payments.acceptedOfferCaptured)}'.`,
    );
  }

  const issueRefund = async (refundId: RefundId, reason: string, requestedAt: string) => {
    const existing = await loadSeedRefundState(services.db, refundId);
    if (existing.status === "issued" || existing.status === "failed") {
      return;
    }

    if (existing.refundId === null) {
      await services.refunds.commandHandler({
        streamId: refundStreamId(refundId),
        command: {
          type: "RequestRefund",
          refundId,
          paymentId: paymentsReservedSeedIds.payments.acceptedOfferCaptured,
          orderIds: [capturedOrderId],
          amount: capturedAmount,
          currencyCode: normalizeCurrencyCode("usd"),
          reason,
          processorName: capturedProcessorName,
          requestedAt,
        },
        context: sellerContext,
      });
    }

    try {
      const processorRefund = await processorGateway.createRefund({
        refundId,
        paymentId: paymentsReservedSeedIds.payments.acceptedOfferCaptured,
        processorPaymentReference: capturedProcessorPaymentReference,
        orderIds: [capturedOrderId],
        amount: capturedAmount,
        currencyCode: normalizeCurrencyCode("usd"),
        reason,
      });
      await services.refunds.commandHandler({
        streamId: refundStreamId(refundId),
        command: {
          type: "RecordRefundIssued",
          processorRefundReference: processorRefund.processorRefundReference,
          processorStatus: processorRefund.processorStatus,
          issuedAt: requestedAt,
        },
        context: sellerContext,
      });
    } catch (error) {
      await services.refunds.commandHandler({
        streamId: refundStreamId(refundId),
        command: {
          type: "RecordRefundFailure",
          processorStatus: "failed",
          failureCode: null,
          failureMessage: error instanceof Error ? error.message : "Refund failed.",
          failedAt: requestedAt,
        },
        context: sellerContext,
      });
    }
  };

  await issueRefund(
    paymentsReservedSeedIds.refunds.acceptedOfferIssued as RefundId,
    "Price adjustment",
    "2026-03-21T09:00:00.000Z",
  );
  await issueRefund(
    paymentsReservedSeedIds.refunds.acceptedOfferFailed as RefundId,
    "Fail refund scenario",
    "2026-03-21T09:05:00.000Z",
  );
}
