import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { identitySeedIds, paymentsReservedSeedIds } from "@chase-sets/dev-seeds";
import { createPaymentsServices } from "./services";
import { createFakePaymentProcessorGateway } from "./fake-gateway";
import type { PaymentId } from "@chase-sets/primitives/typed-ids";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { Projector } from "@chase-sets/event-core/projector";
import type { RefundId } from "./common";
import { normalizeCurrencyCode, normalizeMoneyAmount } from "./common";
import {
  createMarketplaceServices,
  createMarketplaceSupplyResolver,
} from "@chase-sets/marketplace";
import { createOrderingServices } from "@chase-sets/ordering";

type OrderRow = Readonly<{
  order_id: string;
  buyer_account_id: string;
  total_amount: string;
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

function createSeedContext(accountId: string, userId: string): EventStoreContext {
  return {
    tenantId: "tnt_seed_development" as never,
    audit: {
      performedByUserId: userId as never,
      forAccountId: accountId as never,
    },
  };
}

async function drainProjectors(projectors: readonly Projector[]) {
  let processed = 0;

  do {
    processed = 0;
    for (const projector of projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

async function getPendingCartCheckoutOrder(
  pool: PgTransactionalPool,
): Promise<OrderRow> {
  const result = await pool.query<OrderRow>(
    `SELECT order_id, buyer_account_id, total_amount
     FROM ordering_order_pages
     WHERE source_type = 'cart-checkout'
       AND status = 'pending-payment'
     ORDER BY created_at ASC, order_id ASC
     LIMIT 1`,
  );
  const order = result.rows[0];

  if (!order) {
    throw new Error("Payments seed requires at least one pending cart checkout order.");
  }

  return order;
}

async function getAcceptedOfferOrder(
  pool: PgTransactionalPool,
): Promise<OrderRow> {
  const result = await pool.query<OrderRow>(
    `SELECT order_id, buyer_account_id, total_amount
     FROM ordering_order_pages
     WHERE source_type = 'offer-acceptance'
       AND status = 'pending-payment'
     ORDER BY created_at ASC, order_id ASC
     LIMIT 1`,
  );
  const order = result.rows[0];

  if (!order) {
    throw new Error("Payments seed requires an accepted-offer order in pending-payment status.");
  }

  return order;
}

async function getPaymentPage(
  pool: PgTransactionalPool,
  paymentId: PaymentId,
): Promise<PaymentPageRow> {
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
  const marketplace = createMarketplaceServices(pool);
  const ordering = createOrderingServices(pool, {
    supplyResolver: createMarketplaceSupplyResolver(marketplace),
  });
  const processorGateway = createFakePaymentProcessorGateway();
  const services = createPaymentsServices(pool, {
    processorGateway,
  });

  try {
    const existing = await services.db.query(
      "SELECT COUNT(*) AS count FROM payments_payment_pages",
    );
    if (Number(existing.rows[0]?.count ?? 0) > 0) {
      console.log("Payments already contain data. Skipping seed.");
      return;
    }
  } catch {
    // Table may not exist yet. Proceed with seeding.
  }

  const pendingCheckoutOrder = await getPendingCartCheckoutOrder(pool);
  const acceptedOfferOrder = await getAcceptedOfferOrder(pool);
  const buyerContext = createSeedContext(
    identitySeedIds.buyer.accountId,
    identitySeedIds.buyer.userId,
  );
  const sellerContext = createSeedContext(
    identitySeedIds.seller.accountId,
    identitySeedIds.seller.userId,
  );

  const createPayment = async (paymentId: PaymentId, order: OrderRow, createdAt: string) => {
    const processorPayment = await processorGateway.createPaymentIntent({
      paymentId,
      buyerAccountId: order.buyer_account_id as never,
      orderIds: [order.order_id as never],
      amount: normalizeMoneyAmount(order.total_amount, { allowZero: true }),
      currencyCode: normalizeCurrencyCode("usd"),
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
        currencyCode: "usd",
        processorName: processorPayment.processorName,
        processorPaymentReference: processorPayment.processorPaymentReference,
        processorClientSecret: processorPayment.processorClientSecret,
        processorStatus: processorPayment.processorStatus,
        createdAt,
      },
      context: buyerContext,
    });

    await drainProjectors([...services.projectors, ...ordering.projectors]);
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
  const failedPayment = await getPaymentPage(
    pool,
    paymentsReservedSeedIds.payments.failedModernCheckout,
  );
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
  await drainProjectors([...services.projectors, ...ordering.projectors]);

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
  await drainProjectors([...services.projectors, ...ordering.projectors]);

  await createPayment(
    paymentsReservedSeedIds.payments.acceptedOfferCaptured,
    acceptedOfferOrder,
    "2026-03-20T11:00:00.000Z",
  );
  const capturedPayment = await getPaymentPage(
    pool,
    paymentsReservedSeedIds.payments.acceptedOfferCaptured,
  );
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
  await drainProjectors([...services.projectors, ...ordering.projectors]);

  const issueRefund = async (
    refundId: RefundId,
    reason: string,
    requestedAt: string,
  ) => {
    const payment = await getPaymentPage(
      pool,
      paymentsReservedSeedIds.payments.acceptedOfferCaptured,
    );

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

    await drainProjectors([...services.projectors, ...ordering.projectors]);
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

