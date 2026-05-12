import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { PaymentId } from "@chase-sets/primitives/typed-ids";
import type { RefundServices } from "../../api/runtime";
import {
  getCapturedPaymentByOrderId,
  getOrderPaymentInput,
} from "../../../payments/read-model/queries";

function moneyToCents(value: string) {
  return Math.round(Number.parseFloat(value) * 100);
}

function centsToMoney(cents: number) {
  return (cents / 100).toFixed(2);
}

async function loadOrderTotals(
  db: PgQueryable,
  orderIds: readonly string[],
): Promise<Map<string, number>> {
  if (orderIds.length === 0) {
    return new Map();
  }

  const result = await db.query<{ order_id: string; total_cents: string }>(
    `SELECT
       order_id,
       ROUND(total_amount * 100)::text AS total_cents
     FROM payments_order_inputs
     WHERE order_id = ANY($1)`,
    [orderIds],
  );

  return new Map(
    result.rows.map((row) => [row.order_id, Number.parseInt(row.total_cents, 10)]),
  );
}

function allocateCheckoutFeeCents(
  params: Readonly<{
    orderId: string;
    paymentOrderIds: readonly string[];
    orderTotals: ReadonlyMap<string, number>;
    checkoutFeeCents: number;
  }>,
) {
  if (params.checkoutFeeCents <= 0) {
    return 0;
  }

  const orderedIds = params.paymentOrderIds.filter((orderId) =>
    params.orderTotals.has(orderId),
  );
  const totalCents = orderedIds.reduce(
    (sum, orderId) => sum + (params.orderTotals.get(orderId) ?? 0),
    0,
  );
  if (orderedIds.length === 0 || totalCents <= 0) {
    return 0;
  }

  let allocatedBeforeTarget = 0;
  for (const orderId of orderedIds) {
    const isLast = orderId === orderedIds[orderedIds.length - 1];
    const allocation = isLast
      ? params.checkoutFeeCents - allocatedBeforeTarget
      : Math.floor(((params.orderTotals.get(orderId) ?? 0) * params.checkoutFeeCents) / totalCents);
    if (orderId === params.orderId) {
      return allocation;
    }
    allocatedBeforeTarget += allocation;
  }

  return 0;
}

async function claimCancellationRefundEffect(
  db: PgQueryable,
  params: Readonly<{
    orderId: string;
    paymentId: string | null;
    amount: string | null;
    status: string;
    failureMessage?: string | null;
    now: string;
  }>,
) {
  const result = await db.query<{ order_id: string }>(
    `INSERT INTO payments_order_cancellation_refund_effects (
       order_id,
       payment_id,
       requested_amount,
       status,
       failure_message,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $6)
     ON CONFLICT (order_id) DO NOTHING
     RETURNING order_id`,
    [
      params.orderId,
      params.paymentId,
      params.amount,
      params.status,
      params.failureMessage ?? null,
      params.now,
    ],
  );

  return (result.rowCount ?? 0) > 0;
}

export function buildPaymentsOrderCancellationRefundEffectHandlers(
  db: PgQueryable,
  refunds: RefundServices,
): ProjectorHandlerMap {
  return {
    "ordering.order.cancelled": async (event) => {
      const data = event.data as {
        orderId: string;
        cancelledAt: string;
      };

      const [payment, orderInput] = await Promise.all([
        getCapturedPaymentByOrderId(db, data.orderId),
        getOrderPaymentInput(db, data.orderId),
      ]);
      if (!payment || !orderInput) {
        await claimCancellationRefundEffect(db, {
          orderId: data.orderId,
          paymentId: payment?.payment_id ?? null,
          amount: null,
          status: "skipped",
          failureMessage: "Captured payment was not found for self-service cancellation.",
          now: data.cancelledAt,
        });
        return;
      }

      const orderTotals = await loadOrderTotals(db, payment.order_ids);
      const checkoutFeeCents = moneyToCents(payment.marketplace_checkout_fee_amount);
      const allocatedCheckoutFeeCents = allocateCheckoutFeeCents({
        orderId: data.orderId,
        paymentOrderIds: payment.order_ids,
        orderTotals,
        checkoutFeeCents,
      });
      const amount = centsToMoney(
        moneyToCents(orderInput.total_amount) + allocatedCheckoutFeeCents,
      );

      const claimed = await claimCancellationRefundEffect(db, {
        orderId: data.orderId,
        paymentId: payment.payment_id,
        amount,
        status: "processing",
        now: data.cancelledAt,
      });
      if (!claimed) {
        return;
      }

      try {
        const result = await refunds.issueRefund(
          {
            paymentId: payment.payment_id as PaymentId,
            orderIds: [data.orderId],
            amount,
            reason: `Self-service purchase cancellation for order ${data.orderId}.`,
          },
          {
            tenantId: event.tenantId,
            audit: event.audit,
            trace: event.trace,
          },
        );
        await db.query(
          `UPDATE payments_order_cancellation_refund_effects
           SET refund_id = $2,
               status = 'refund-requested',
               failure_message = NULL,
               updated_at = $3
           WHERE order_id = $1`,
          [data.orderId, result.refundId, new Date().toISOString()],
        );
      } catch (error) {
        await db.query(
          `UPDATE payments_order_cancellation_refund_effects
           SET status = 'failed',
               failure_message = $2,
               updated_at = $3
           WHERE order_id = $1`,
          [
            data.orderId,
            error instanceof Error ? error.message : "Self-service cancellation refund failed.",
            new Date().toISOString(),
          ],
        );
        throw error;
      }
    },
  };
}
