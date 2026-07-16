import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { recordRefundEffectFailure } from "../refund-effect-retry";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId, type PaymentId } from "@chase-sets/primitives/typed-ids";
import type { RefundId } from "../../../../support/runtime-support/common";
import type { RefundServices } from "../../api/runtime";
import {
  getCapturedPaymentByOrderId,
  getOrderPaymentInput,
  type PaymentDetailRow,
} from "../../../payments/read-model/queries";

type CapturedPaymentForCancellationRefund = Pick<
  PaymentDetailRow,
  "payment_id" | "order_ids" | "marketplace_checkout_fee_amount" | "order_refund_caps" | "order_refunded_amounts"
>;

type PaymentOrderInputForRefund = Readonly<{
  order_id: string;
  total_amount: string;
  status: string;
}>;

function moneyToCents(value: string) {
  return Math.round(Number.parseFloat(value) * 100);
}

function centsToMoney(cents: number) {
  return (cents / 100).toFixed(2);
}

function orderMoneyAmount(entries: readonly { orderId: string; amount: string }[] | undefined, orderId: string) {
  return entries?.find((entry) => entry.orderId === orderId)?.amount ?? "0.00";
}

function remainingRefundableOrderAmount(
  payment: CapturedPaymentForCancellationRefund,
  orderId: string,
  fallbackCap: string,
) {
  const cap = payment.order_refund_caps.length > 0 ? orderMoneyAmount(payment.order_refund_caps, orderId) : fallbackCap;
  const refunded = orderMoneyAmount(payment.order_refunded_amounts, orderId);
  return centsToMoney(Math.max(0, moneyToCents(cap) - moneyToCents(refunded)));
}

async function loadOrderInputs(
  db: PgQueryable,
  orderIds: readonly string[],
): Promise<Map<string, PaymentOrderInputForRefund>> {
  if (orderIds.length === 0) {
    return new Map();
  }

  const result = await db.query<PaymentOrderInputForRefund>(
    `SELECT
       order_id,
       total_amount::text AS total_amount,
       status
     FROM payments_order_inputs
     WHERE order_id = ANY($1)`,
    [orderIds],
  );

  return new Map(result.rows.map((row) => [row.order_id, row]));
}

function orderTotalsFromInputs(orderInputs: ReadonlyMap<string, PaymentOrderInputForRefund>): Map<string, number> {
  return new Map([...orderInputs.values()].map((row) => [row.order_id, moneyToCents(row.total_amount)]));
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

  const orderedIds = params.paymentOrderIds.filter((orderId) => params.orderTotals.has(orderId));
  const totalCents = orderedIds.reduce((sum, orderId) => sum + (params.orderTotals.get(orderId) ?? 0), 0);
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
    refundId?: RefundId | null;
    amount: string | null;
    status: string;
    failureMessage?: string | null;
    now: string;
  }>,
) {
  const result = await db.query<{ order_id: string; refund_id: string | null }>(
    `INSERT INTO payments_order_cancellation_refund_effects (
       order_id,
       payment_id,
       refund_id,
       requested_amount,
       status,
       failure_message,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
     ON CONFLICT (order_id) DO UPDATE
     SET payment_id = EXCLUDED.payment_id,
         refund_id = COALESCE(payments_order_cancellation_refund_effects.refund_id, EXCLUDED.refund_id),
         requested_amount = EXCLUDED.requested_amount,
         status = EXCLUDED.status,
         failure_message = EXCLUDED.failure_message,
         updated_at = EXCLUDED.updated_at
     WHERE payments_order_cancellation_refund_effects.status IN ('skipped', 'failed')
       AND EXCLUDED.status = 'processing'
     RETURNING order_id, refund_id`,
    [
      params.orderId,
      params.paymentId,
      params.refundId ?? null,
      params.amount,
      params.status,
      params.failureMessage ?? null,
      params.now,
    ],
  );

  return (result.rows[0]?.refund_id ?? null) as RefundId | null;
}

async function issueCancellationRefund(
  db: PgQueryable,
  refunds: RefundServices,
  params: Readonly<{
    payment: CapturedPaymentForCancellationRefund;
    orderId: string;
    orderInput: Readonly<{ total_amount: string }>;
    now: string;
    tenantId: EventStoreContext["tenantId"];
    audit: EventStoreContext["audit"];
    trace: EventStoreContext["trace"];
  }>,
) {
  const orderInputs = await loadOrderInputs(db, params.payment.order_ids);
  const orderTotals = orderTotalsFromInputs(orderInputs);
  const checkoutFeeCents = moneyToCents(params.payment.marketplace_checkout_fee_amount);
  const allocatedCheckoutFeeCents = allocateCheckoutFeeCents({
    orderId: params.orderId,
    paymentOrderIds: params.payment.order_ids,
    orderTotals,
    checkoutFeeCents,
  });
  const amount = centsToMoney(moneyToCents(params.orderInput.total_amount) + allocatedCheckoutFeeCents);
  const refundableAmount = centsToMoney(
    Math.min(
      moneyToCents(amount),
      moneyToCents(remainingRefundableOrderAmount(params.payment, params.orderId, amount)),
    ),
  );
  if (moneyToCents(refundableAmount) <= 0) {
    await claimCancellationRefundEffect(db, {
      orderId: params.orderId,
      paymentId: params.payment.payment_id,
      amount: null,
      status: "skipped",
      failureMessage: "Order has no remaining refundable amount.",
      now: params.now,
    });
    return;
  }

  const claimed = await claimCancellationRefundEffect(db, {
    orderId: params.orderId,
    paymentId: params.payment.payment_id,
    refundId: createId("rfd") as RefundId,
    amount: refundableAmount,
    status: "processing",
    now: params.now,
  });
  if (!claimed) {
    return;
  }

  let result: Awaited<ReturnType<RefundServices["issueRefund"]>>;
  try {
    result = await refunds.issueRefund(
      {
        refundId: claimed,
        paymentId: params.payment.payment_id as PaymentId,
        orderIds: [params.orderId],
        amount: refundableAmount,
        reason: `Self-service purchase cancellation for order ${params.orderId}.`,
        capToRemainingRefundable: true,
      },
      {
        tenantId: params.tenantId,
        audit: params.audit,
        trace: params.trace,
      },
    );
  } catch (error) {
    await recordRefundEffectFailure(db, {
      table: "payments_order_cancellation_refund_effects",
      keyColumn: "order_id",
      keyValue: params.orderId,
      failureMessage: error instanceof Error ? error.message : "Self-service cancellation refund failed.",
      now: new Date().toISOString(),
    });
    return;
  }

  if (result.outcome === "not-refundable") {
    await db.query(
      `UPDATE payments_order_cancellation_refund_effects
       SET status = 'skipped',
           failure_message = $2,
           updated_at = $3
       WHERE order_id = $1
         AND status = 'processing'`,
      [params.orderId, result.reason, new Date().toISOString()],
    );
    return;
  }

  if (result.outcome === "gateway-failed") {
    await recordRefundEffectFailure(db, {
      table: "payments_order_cancellation_refund_effects",
      keyColumn: "order_id",
      keyValue: params.orderId,
      failureMessage: result.failureMessage,
      now: new Date().toISOString(),
    });
    return;
  }

  await db.query(
    `UPDATE payments_order_cancellation_refund_effects
     SET refund_id = $2,
         requested_amount = $3,
         status = 'refund-requested',
         failure_message = NULL,
         updated_at = $4
     WHERE order_id = $1
       AND status = 'processing'`,
    [params.orderId, result.refundId, result.amount, new Date().toISOString()],
  );
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

      await issueCancellationRefund(db, refunds, {
        payment,
        orderId: data.orderId,
        orderInput,
        now: data.cancelledAt,
        tenantId: event.tenantId,
        audit: event.audit,
        trace: event.trace,
      });
    },
    "payments.payment-captured": async (event) => {
      const data = event.data as {
        paymentId: string;
        orderIds: string[];
        marketplaceCheckoutFeeAmount: string;
        capturedAt: string;
      };
      const orderInputs = await loadOrderInputs(db, data.orderIds ?? []);
      const cancelledOrderInputs = (data.orderIds ?? [])
        .map((orderId) => orderInputs.get(orderId))
        .filter((orderInput): orderInput is PaymentOrderInputForRefund => orderInput?.status === "cancelled");

      for (const orderInput of cancelledOrderInputs) {
        await issueCancellationRefund(db, refunds, {
          payment: {
            payment_id: data.paymentId,
            order_ids: data.orderIds ?? [],
            marketplace_checkout_fee_amount: data.marketplaceCheckoutFeeAmount,
            order_refund_caps:
              (data as { orderRefundCaps?: CapturedPaymentForCancellationRefund["order_refund_caps"] })
                .orderRefundCaps ?? [],
            order_refunded_amounts: [],
          },
          orderId: orderInput.order_id,
          orderInput,
          now: data.capturedAt,
          tenantId: event.tenantId,
          audit: event.audit,
          trace: event.trace,
        });
      }
    },
  };
}
