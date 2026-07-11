import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId, type PaymentId } from "@chase-sets/primitives/typed-ids";
import type { RefundId } from "../../../../support/runtime-support/common";
import type { RefundServices } from "../../api/runtime";
import { getCapturedPaymentByOrderId, getOrderPaymentInput } from "../../../payments/read-model/queries";

const refundResolutionTypes = new Set(["full-refund", "partial-refund", "return-for-refund", "cancel-order"]);

/**
 * `return-for-refund` records a pending refund effect instead of issuing one
 * immediately: the buyer is not refunded until the returned item's delivery
 * is recorded (`support.support-request.return-delivered`) and the 5-day
 * inspection window elapses without a seller condition dispute
 * (`support.support-request.return-refund-released`). Every other resolution
 * type keeps issuing its refund immediately at resolution time.
 */
const immediateRefundResolutionTypes = new Set(["full-refund", "partial-refund", "cancel-order"]);

function compareMoney(left: string, right: string) {
  return Number.parseFloat(left) - Number.parseFloat(right);
}

function minMoney(left: string, right: string) {
  return Math.min(Number.parseFloat(left), Number.parseFloat(right)).toFixed(2);
}

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
  payment: Readonly<{
    order_refund_caps: readonly { orderId: string; amount: string }[];
    order_refunded_amounts: readonly { orderId: string; amount: string }[];
  }>,
  orderId: string,
  fallbackCap: string,
) {
  const cap = payment.order_refund_caps.length > 0 ? orderMoneyAmount(payment.order_refund_caps, orderId) : fallbackCap;
  const refunded = orderMoneyAmount(payment.order_refunded_amounts, orderId);
  return centsToMoney(Math.max(0, moneyToCents(cap) - moneyToCents(refunded)));
}

export function createPaymentsSupportRefundEffectId(supportRequestId: string): string {
  return `sre_${supportRequestId.replace(/^sup_/, "")}`;
}

async function insertSkippedSupportRefundEffect(
  db: PgQueryable,
  params: Readonly<{
    supportRequestId: string;
    orderId: string;
    paymentId: string | null;
    resolutionType: string;
    failureMessage: string;
    now: string;
  }>,
) {
  await db.query(
    `INSERT INTO payments_support_refund_effects (
       support_request_id,
       refund_effect_id,
       order_id,
       payment_id,
       resolution_type,
       requested_amount,
       status,
       failure_message,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, NULL, 'skipped', $6, $7, $7)
     ON CONFLICT (support_request_id) DO NOTHING`,
    [
      params.supportRequestId,
      createPaymentsSupportRefundEffectId(params.supportRequestId),
      params.orderId,
      params.paymentId,
      params.resolutionType,
      params.failureMessage,
      params.now,
    ],
  );
}

async function claimSupportRefundEffect(
  db: PgQueryable,
  params: Readonly<{
    supportRequestId: string;
    orderId: string;
    paymentId: string;
    refundId: RefundId;
    resolutionType: string;
    amount: string;
    now: string;
  }>,
) {
  const result = await db.query<{ support_request_id: string; refund_id: string }>(
    `INSERT INTO payments_support_refund_effects (
       support_request_id,
       refund_effect_id,
       order_id,
       payment_id,
       refund_id,
       resolution_type,
       requested_amount,
       status,
       failure_message,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing', NULL, $8, $8)
     ON CONFLICT (support_request_id) DO UPDATE
     SET payment_id = EXCLUDED.payment_id,
         refund_id = COALESCE(payments_support_refund_effects.refund_id, EXCLUDED.refund_id),
         resolution_type = EXCLUDED.resolution_type,
         requested_amount = EXCLUDED.requested_amount,
         status = EXCLUDED.status,
         failure_message = NULL,
         updated_at = EXCLUDED.updated_at
     WHERE payments_support_refund_effects.status = 'failed'
     RETURNING support_request_id, refund_id`,
    [
      params.supportRequestId,
      createPaymentsSupportRefundEffectId(params.supportRequestId),
      params.orderId,
      params.paymentId,
      params.refundId,
      params.resolutionType,
      params.amount,
      params.now,
    ],
  );

  return (result.rows[0]?.refund_id ?? null) as RefundId | null;
}

/** First-time pending-return insert at resolution time; a replay of the same resolved event must not clobber later gate progress. */
async function insertPendingReturnRefundEffect(
  db: PgQueryable,
  params: Readonly<{
    supportRequestId: string;
    orderId: string;
    paymentId: string;
    amount: string;
    now: string;
  }>,
) {
  await db.query(
    `INSERT INTO payments_support_refund_effects (
       support_request_id,
       refund_effect_id,
       order_id,
       payment_id,
       resolution_type,
       requested_amount,
       status,
       failure_message,
       created_at,
       updated_at
     ) VALUES ($1, $2, $3, $4, 'return-for-refund', $5, 'awaiting-return', NULL, $6, $6)
     ON CONFLICT (support_request_id) DO NOTHING`,
    [
      params.supportRequestId,
      createPaymentsSupportRefundEffectId(params.supportRequestId),
      params.orderId,
      params.paymentId,
      params.amount,
      params.now,
    ],
  );
}

/** Opens the gate for a claimed (but not yet issued) return refund; guarded so a replay after a successful claim is a no-op, matching `claimSupportRefundEffect`'s retry semantics. */
async function claimReturnRefundRelease(
  db: PgQueryable,
  params: Readonly<{ supportRequestId: string; refundId: RefundId; now: string }>,
) {
  const result = await db.query<{ refund_id: string }>(
    `UPDATE payments_support_refund_effects
     SET refund_id = COALESCE(refund_id, $2),
         status = 'processing',
         failure_message = NULL,
         updated_at = $3
     WHERE support_request_id = $1
       AND status IN ('return-received', 'return-condition-disputed')
     RETURNING refund_id`,
    [params.supportRequestId, params.refundId, params.now],
  );

  return (result.rows[0]?.refund_id ?? null) as RefundId | null;
}

async function issueClaimedRefund(
  db: PgQueryable,
  refunds: RefundServices,
  params: Readonly<{
    supportRequestId: string;
    paymentId: string;
    refundId: RefundId;
    orderId: string;
    amount: string;
    reason: string;
    context: EventStoreContext;
  }>,
) {
  try {
    const result = await refunds.issueRefund(
      {
        refundId: params.refundId,
        paymentId: params.paymentId as PaymentId,
        orderIds: [params.orderId],
        amount: params.amount,
        reason: params.reason,
      },
      params.context,
    );
    await db.query(
      `UPDATE payments_support_refund_effects
       SET payment_id = $2,
           refund_id = $3,
           status = 'refund-requested',
           failure_message = NULL,
           updated_at = $4
       WHERE support_request_id = $1`,
      [params.supportRequestId, params.paymentId, result.refundId, new Date().toISOString()],
    );
  } catch (error) {
    await db.query(
      `UPDATE payments_support_refund_effects
       SET payment_id = $2,
           status = 'failed',
           failure_message = $3,
           updated_at = $4
       WHERE support_request_id = $1`,
      [
        params.supportRequestId,
        params.paymentId,
        error instanceof Error ? error.message : "Support refund failed.",
        new Date().toISOString(),
      ],
    );
    throw error;
  }
}

export function buildPaymentsSupportRefundEffectHandlers(
  db: PgQueryable,
  refunds: RefundServices,
): ProjectorHandlerMap {
  return {
    "support.support-request.resolved": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        orderId: string;
        resolution: {
          resolutionType: string;
          refundAmount: string | null;
          summary: string;
          resolvedAt: string;
        };
      };
      if (!refundResolutionTypes.has(data.resolution.resolutionType)) {
        return;
      }

      const [payment, orderInput] = await Promise.all([
        getCapturedPaymentByOrderId(db, data.orderId),
        getOrderPaymentInput(db, data.orderId),
      ]);
      if (!payment || !orderInput) {
        await insertSkippedSupportRefundEffect(db, {
          supportRequestId: data.supportRequestId,
          orderId: data.orderId,
          paymentId: null,
          resolutionType: data.resolution.resolutionType,
          failureMessage: "Captured payment was not found for support refund.",
          now: data.resolution.resolvedAt,
        });
        return;
      }

      const requestedAmount =
        data.resolution.resolutionType === "partial-refund"
          ? data.resolution.refundAmount
          : (data.resolution.refundAmount ?? orderInput.total_amount);
      if (!requestedAmount || compareMoney(requestedAmount, "0.00") <= 0) {
        await insertSkippedSupportRefundEffect(db, {
          supportRequestId: data.supportRequestId,
          orderId: data.orderId,
          paymentId: payment.payment_id,
          resolutionType: data.resolution.resolutionType,
          failureMessage: "Support resolution did not include a refundable amount.",
          now: data.resolution.resolvedAt,
        });
        return;
      }

      const remainingOrderAmount = remainingRefundableOrderAmount(payment, data.orderId, orderInput.total_amount);
      const amount = minMoney(minMoney(requestedAmount, orderInput.total_amount), remainingOrderAmount);
      if (compareMoney(amount, "0.00") <= 0) {
        await insertSkippedSupportRefundEffect(db, {
          supportRequestId: data.supportRequestId,
          orderId: data.orderId,
          paymentId: payment.payment_id,
          resolutionType: data.resolution.resolutionType,
          failureMessage: "Order has no remaining refundable amount.",
          now: data.resolution.resolvedAt,
        });
        return;
      }

      if (!immediateRefundResolutionTypes.has(data.resolution.resolutionType)) {
        // return-for-refund: no issueRefund yet, the money gate opens on
        // support.support-request.return-refund-released.
        await insertPendingReturnRefundEffect(db, {
          supportRequestId: data.supportRequestId,
          orderId: data.orderId,
          paymentId: payment.payment_id,
          amount,
          now: data.resolution.resolvedAt,
        });
        return;
      }

      const claimed = await claimSupportRefundEffect(db, {
        supportRequestId: data.supportRequestId,
        orderId: data.orderId,
        paymentId: payment.payment_id,
        refundId: createId("rfd") as RefundId,
        resolutionType: data.resolution.resolutionType,
        amount,
        now: data.resolution.resolvedAt,
      });
      if (!claimed) {
        return;
      }

      await issueClaimedRefund(db, refunds, {
        supportRequestId: data.supportRequestId,
        paymentId: payment.payment_id,
        refundId: claimed,
        orderId: data.orderId,
        amount,
        reason: `Support ${data.supportRequestId}: ${data.resolution.summary}`,
        context: { tenantId: event.tenantId, audit: event.audit, trace: event.trace },
      });
    },
    "support.support-request.return-delivered": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        deliveredAt: string;
        returnRefundReleaseDueAt: string;
      };

      await db.query(
        `UPDATE payments_support_refund_effects
         SET status = 'return-received',
             return_delivered_at = $2,
             refund_release_due_at = $3,
             updated_at = $2
         WHERE support_request_id = $1
           AND status = 'awaiting-return'`,
        [data.supportRequestId, data.deliveredAt, data.returnRefundReleaseDueAt],
      );
    },
    "support.support-request.return-condition-disputed": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        disputedAt: string;
      };

      await db.query(
        `UPDATE payments_support_refund_effects
         SET status = 'return-condition-disputed',
             return_condition_disputed_at = $2,
             updated_at = $2
         WHERE support_request_id = $1
           AND status = 'return-received'`,
        [data.supportRequestId, data.disputedAt],
      );
    },
    "support.support-request.return-refund-released": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        orderId: string;
        releasedAt: string;
      };

      const existing = await db.query<{ requested_amount: string | null; resolution_type: string }>(
        `SELECT requested_amount::text AS requested_amount, resolution_type
         FROM payments_support_refund_effects
         WHERE support_request_id = $1
           AND status IN ('return-received', 'return-condition-disputed')`,
        [data.supportRequestId],
      );
      const pending = existing.rows[0];
      if (!pending || !pending.requested_amount) {
        // Already released (replay), never claimed, or nothing was pending;
        // idempotent no-op either way.
        return;
      }

      const [payment, orderInput] = await Promise.all([
        getCapturedPaymentByOrderId(db, data.orderId),
        getOrderPaymentInput(db, data.orderId),
      ]);
      if (!payment || !orderInput) {
        await db.query(
          `UPDATE payments_support_refund_effects
           SET status = 'failed',
               failure_message = $2,
               updated_at = $3
           WHERE support_request_id = $1`,
          [data.supportRequestId, "Captured payment was not found when the return refund released.", data.releasedAt],
        );
        return;
      }

      // Re-derive the safe-to-refund amount against live payment state: the
      // promised amount was capped once already at resolution time, but
      // other refunds on this order may have landed while the return was in
      // transit, so cap it again before ever calling issueRefund.
      const remainingOrderAmount = remainingRefundableOrderAmount(payment, data.orderId, orderInput.total_amount);
      const amount = minMoney(pending.requested_amount, remainingOrderAmount);
      if (compareMoney(amount, "0.00") <= 0) {
        await db.query(
          `UPDATE payments_support_refund_effects
           SET status = 'skipped',
               failure_message = $2,
               updated_at = $3
           WHERE support_request_id = $1`,
          [
            data.supportRequestId,
            "Order had no remaining refundable amount when the return refund released.",
            data.releasedAt,
          ],
        );
        return;
      }

      const claimed = await claimReturnRefundRelease(db, {
        supportRequestId: data.supportRequestId,
        refundId: createId("rfd") as RefundId,
        now: data.releasedAt,
      });
      if (!claimed) {
        return;
      }

      await issueClaimedRefund(db, refunds, {
        supportRequestId: data.supportRequestId,
        paymentId: payment.payment_id,
        refundId: claimed,
        orderId: data.orderId,
        amount,
        reason: `Support ${data.supportRequestId}: return refund released after inspection window.`,
        context: { tenantId: event.tenantId, audit: event.audit, trace: event.trace },
      });
    },
  };
}
