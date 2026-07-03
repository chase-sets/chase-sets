import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId, type PaymentId } from "@chase-sets/primitives/typed-ids";
import type { RefundId } from "../../../../support/runtime-support/common";
import type { RefundServices } from "../../api/runtime";
import { getCapturedPaymentByOrderId, getOrderPaymentInput } from "../../../payments/read-model/queries";

const refundResolutionTypes = new Set(["full-refund", "partial-refund", "return-for-refund", "cancel-order"]);

function compareMoney(left: string, right: string) {
  return Number.parseFloat(left) - Number.parseFloat(right);
}

function minMoney(left: string, right: string) {
  return Math.min(Number.parseFloat(left), Number.parseFloat(right)).toFixed(2);
}

export function createPaymentsSupportRefundEffectId(supportRequestId: string): string {
  return `sre_${supportRequestId.replace(/^sup_/, "")}`;
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
        await db.query(
          `INSERT INTO payments_support_refund_effects (
             support_request_id,
             refund_effect_id,
             order_id,
             resolution_type,
             requested_amount,
             status,
             failure_message,
             created_at,
             updated_at
           ) VALUES ($1, $2, $3, $4, NULL, 'skipped', $5, $6, $6)
           ON CONFLICT (support_request_id) DO NOTHING`,
          [
            data.supportRequestId,
            createPaymentsSupportRefundEffectId(data.supportRequestId),
            data.orderId,
            data.resolution.resolutionType,
            "Captured payment was not found for support refund.",
            data.resolution.resolvedAt,
          ],
        );
        return;
      }

      const requestedAmount =
        data.resolution.resolutionType === "partial-refund"
          ? data.resolution.refundAmount
          : (data.resolution.refundAmount ?? orderInput.total_amount);
      if (!requestedAmount || compareMoney(requestedAmount, "0.00") <= 0) {
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
            data.supportRequestId,
            createPaymentsSupportRefundEffectId(data.supportRequestId),
            data.orderId,
            payment.payment_id,
            data.resolution.resolutionType,
            "Support resolution did not include a refundable amount.",
            data.resolution.resolvedAt,
          ],
        );
        return;
      }

      const amount = minMoney(requestedAmount, orderInput.total_amount);
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

      try {
        const result = await refunds.issueRefund(
          {
            refundId: claimed,
            paymentId: payment.payment_id as PaymentId,
            orderIds: [data.orderId],
            amount,
            reason: `Support ${data.supportRequestId}: ${data.resolution.summary}`,
          },
          {
            tenantId: event.tenantId,
            audit: event.audit,
            trace: event.trace,
          },
        );
        await db.query(
          `UPDATE payments_support_refund_effects
           SET payment_id = $2,
               refund_id = $3,
               status = 'refund-requested',
               failure_message = NULL,
               updated_at = $4
           WHERE support_request_id = $1`,
          [data.supportRequestId, payment.payment_id, result.refundId, new Date().toISOString()],
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
            data.supportRequestId,
            payment.payment_id,
            error instanceof Error ? error.message : "Support refund failed.",
            new Date().toISOString(),
          ],
        );
        throw error;
      }
    },
  };
}
