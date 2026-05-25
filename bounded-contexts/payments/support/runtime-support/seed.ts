import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { identitySeedIds } from "@chase-sets/identity/seed-support/ids";
import { marketplaceReservedSeedIds } from "@chase-sets/marketplace/seed-support/ids";
import { orderingReservedSeedIds } from "@chase-sets/ordering/seed-support/ids";
import { paymentsReservedSeedIds } from "@chase-sets/payments/seed-support/ids";
import { createPaymentsServices } from "./services";
import { createFakePaymentProcessorGateway } from "@chase-sets/payment-processing-testing";
import type { PaymentId } from "@chase-sets/primitives/typed-ids";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
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
  seller_payout_amount: string;
}>;

type PaymentPageRow = Readonly<{
  payment_id: string;
  buyer_account_id: string;
  order_ids: string[];
  amount: string;
  currency_code: string;
  processor_name: string;
  processor_payment_reference: string;
}>;

class SeedOrderMissingError extends Error {}

function createSeedContext(accountId: string, userId: string): EventStoreContext {
  return {
    tenantId: "tnt_seed_development" as never,
    audit: {
      performedByUserId: userId as never,
      forAccountId: accountId as never,
    },
  };
}

async function drainProjectors(projectors: readonly ProjectionHandlerSet[]) {
  void projectors;
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

async function getAcceptedOfferSeedOrder(pool: PgTransactionalPool): Promise<OrderRow> {
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
      throw error;
    }

    return sourceOrder;
  }
}

async function getPaymentPage(pool: PgTransactionalPool, paymentId: PaymentId): Promise<PaymentPageRow> {
  const result = await pool.query<PaymentPageRow>(
    `SELECT
       payment_id,
       buyer_account_id,
       order_ids,
       amount,
       currency_code,
       processor_name,
       processor_payment_reference
     FROM payments_payment_pages
     WHERE payment_id = $1`,
    [paymentId],
  );
  const payment = result.rows[0];

  if (!payment) {
    throw new Error(`Payments seed could not load payment ${paymentId}.`);
  }

  return payment;
}

export async function seedPaymentsDatabase(pool: PgTransactionalPool) {
  const processorGateway = createFakePaymentProcessorGateway();
  const services = createPaymentsServices(pool, {
    processorGateway,
  });

  try {
    const existing = await services.db.query("SELECT COUNT(*) AS count FROM payments_payment_pages");
    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      console.log("Payments already contain data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet. Proceed with seeding.
  }

  const pendingCheckoutOrder = await getSeedOrder(
    pool,
    orderingReservedSeedIds.orders.checkoutPending,
    identitySeedIds.collector.accountId,
  );
  const acceptedOfferOrder = await getAcceptedOfferSeedOrder(pool);
  const buyerContext = createSeedContext(identitySeedIds.collector.accountId, identitySeedIds.collector.userId);
  const sellerContext = createSeedContext(identitySeedIds.demo.accountId, identitySeedIds.demo.userId);

  const createPayment = async (paymentId: PaymentId, order: OrderRow, createdAt: string) => {
    const processorPayment = await processorGateway.createPaymentSession({
      paymentId,
      buyerAccountId: order.buyer_account_id as never,
      orderIds: [order.order_id as never],
      amount: normalizeMoneyAmount(order.total_amount, { allowZero: true }),
      currencyCode: normalizeCurrencyCode("usd"),
      paymentMethodCategory: "card",
      description: `Seed payment ${paymentId}`,
    });

    await services.payments.commandHandler({
      streamId: `payments.payment-${paymentId}`,
      command: {
        type: "CreatePayment",
        paymentId,
        buyerAccountId: order.buyer_account_id as never,
        orderIds: [order.order_id as never],
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
            orderId: order.order_id as never,
            sellerAccountId: order.seller_account_id as never,
            sellerItemNetAmount: normalizeMoneyAmount(order.seller_item_net_amount, {
              allowZero: true,
            }),
            shippingAllowanceAmount: normalizeMoneyAmount(order.shipping_allowance_amount, {
              allowZero: true,
            }),
            sellerShippingPayoutAmount: normalizeMoneyAmount(order.seller_shipping_payout_amount, {
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

    await drainProjectors(services.projectors);
  };

  await createPayment(
    paymentsReservedSeedIds.payments.checkoutPending,
    pendingCheckoutOrder,
    "2026-03-20T10:00:00.000Z",
  );

  await createPayment(
    paymentsReservedSeedIds.payments.failedModernCheckout,
    pendingCheckoutOrder,
    "2026-03-20T10:05:00.000Z",
  );
  const failedPayment = await getPaymentPage(pool, paymentsReservedSeedIds.payments.failedModernCheckout);
  await services.payments.processWebhook(
    {
      rawBody: JSON.stringify({
        kind: "payment-failed",
        processorPaymentReference: failedPayment.processor_payment_reference,
        processorStatus: "failed",
        failureCode: "card_declined",
        failureMessage: "Seeded card decline.",
        occurredAt: "2026-03-20T10:06:00.000Z",
      }),
      signatureHeader: null,
    },
    buyerContext,
  );
  await drainProjectors(services.projectors);

  await createPayment(
    paymentsReservedSeedIds.payments.cancelledVintageCheckout,
    pendingCheckoutOrder,
    "2026-03-20T10:10:00.000Z",
  );
  await services.payments.commandHandler({
    streamId: `payments.payment-${paymentsReservedSeedIds.payments.cancelledVintageCheckout}`,
    command: {
      type: "CancelPayment",
      cancelledAt: "2026-03-20T10:11:00.000Z",
    },
    context: buyerContext,
  });
  await drainProjectors(services.projectors);

  await createPayment(
    paymentsReservedSeedIds.payments.acceptedOfferCaptured,
    acceptedOfferOrder,
    "2026-03-20T11:00:00.000Z",
  );
  const capturedPayment = await getPaymentPage(pool, paymentsReservedSeedIds.payments.acceptedOfferCaptured);
  await services.payments.processWebhook(
    {
      rawBody: JSON.stringify({
        kind: "payment-captured",
        processorPaymentReference: capturedPayment.processor_payment_reference,
        processorStatus: "succeeded",
        occurredAt: "2026-03-20T11:05:00.000Z",
      }),
      signatureHeader: null,
    },
    buyerContext,
  );
  await drainProjectors(services.projectors);

  const issueRefund = async (refundId: RefundId, reason: string, requestedAt: string) => {
    const payment = await getPaymentPage(pool, paymentsReservedSeedIds.payments.acceptedOfferCaptured);

    await services.refunds.commandHandler({
      streamId: `payments.refund-${refundId}`,
      command: {
        type: "RequestRefund",
        refundId,
        paymentId: payment.payment_id as never,
        orderIds: payment.order_ids as never,
        amount: payment.amount,
        currencyCode: payment.currency_code as never,
        reason,
        processorName: payment.processor_name as never,
        requestedAt,
      },
      context: sellerContext,
    });

    try {
      const processorRefund = await processorGateway.createRefund({
        paymentId: payment.payment_id as never,
        processorPaymentReference: payment.processor_payment_reference,
        orderIds: payment.order_ids as never,
        amount: payment.amount,
        currencyCode: payment.currency_code as never,
        reason,
      });
      await services.refunds.commandHandler({
        streamId: `payments.refund-${refundId}`,
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
        streamId: `payments.refund-${refundId}`,
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

    await drainProjectors(services.projectors);
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
