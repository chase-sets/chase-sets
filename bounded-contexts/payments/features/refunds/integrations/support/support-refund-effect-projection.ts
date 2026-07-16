import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createId, type PaymentId } from "@chase-sets/primitives/typed-ids";
import { normalizeSupportRequestRefundReleasedV1 } from "@chase-sets/event-core/platform-coverage-facts";
import type { RefundId } from "../../../../support/runtime-support/common";
import type { RefundServices } from "../../api/runtime";
import type { RefundCausationInput } from "../../domain/causation";
import { refundIdForRemedy } from "../../domain/causation";
import { getCapturedPaymentByOrderId, getOrderPaymentInput } from "../../../payments/read-model/queries";
import { recordRefundEffectFailure } from "../refund-effect-retry";

// `cancel-order` is intentionally excluded: it is driven through order
// cancellation (ordering emits `ordering.order.cancelled`, which the
// cancellation refund effect handles), so the buyer is refunded — including the
// checkout fee — only once the order actually transitions to cancelled and its
// inventory holds are released.
const refundResolutionTypes = new Set(["full-refund", "partial-refund", "return-for-refund"]);

/** Structured, non-free-form reason carried as refund causation when a platform-coverage remedy releases its refund. */
const REMEDY_REFUND_RELEASED_REASON_CODE = "platform-coverage-remedy-refund-released";

/**
 * `return-for-refund` records a pending refund effect instead of issuing one
 * immediately: the buyer is not refunded until the returned item's delivery
 * is recorded (`support.support-request.return-delivered`) and the 5-day
 * inspection window elapses without a seller condition dispute
 * (`support.support-request.return-refund-released`). Every other resolution
 * type keeps issuing its refund immediately at resolution time.
 */
const immediateRefundResolutionTypes = new Set(["full-refund", "partial-refund"]);

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
  await db.query(
    `UPDATE payments_support_refund_effects effect
     SET return_shipping_deduction_amount = source.postage_amount,
         updated_at = GREATEST(effect.updated_at, source.updated_at)
     FROM payments_return_label_sources source
     WHERE effect.support_request_id = $1
       AND source.support_request_id = effect.support_request_id
       AND source.cost_payer = 'buyer'
       AND source.label_status = 'ready'`,
    [params.supportRequestId],
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

/**
 * Opens the gate for a platform-coverage remedy refund. The refund id is derived
 * from the stable remedy id (not request timing), so a redelivered release resolves
 * to the same refund and the provider is invoked at most once. The claim is guarded
 * to statuses that have not yet reached the provider so a replay after a successful
 * claim is a no-op, and it returns the row's order/payment binding recorded when the
 * case was resolved.
 */
async function claimRemedyRefundRelease(
  db: PgQueryable,
  params: Readonly<{ supportRequestId: string; refundId: RefundId; now: string }>,
) {
  const result = await db.query<{ order_id: string; payment_id: string | null; refund_id: string | null }>(
    `UPDATE payments_support_refund_effects
     SET refund_id = COALESCE(refund_id, $2),
         status = 'processing',
         failure_message = NULL,
         updated_at = $3
     WHERE support_request_id = $1
       AND payment_id IS NOT NULL
       AND status NOT IN ('processing', 'refund-requested', 'skipped', 'manual-review')
     RETURNING order_id, payment_id, refund_id`,
    [params.supportRequestId, params.refundId, params.now],
  );

  const row = result.rows[0];
  if (!row || !row.payment_id) {
    return null;
  }
  return {
    orderId: row.order_id,
    paymentId: row.payment_id,
    refundId: (row.refund_id ?? params.refundId) as RefundId,
  };
}

async function markRemedyRefundManualReview(
  db: PgQueryable,
  params: Readonly<{ supportRequestId: string; failureMessage: string; now: string }>,
) {
  await db.query(
    `UPDATE payments_support_refund_effects
     SET status = 'manual-review',
         failure_message = $2,
         updated_at = $3
     WHERE support_request_id = $1
       AND status NOT IN ('refund-requested', 'processing')`,
    [params.supportRequestId, params.failureMessage, params.now],
  );
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
    causation?: RefundCausationInput | null;
    capToRemainingRefundable?: boolean;
    context: EventStoreContext;
  }>,
) {
  let result: Awaited<ReturnType<RefundServices["issueRefund"]>>;
  try {
    result = await refunds.issueRefund(
      {
        refundId: params.refundId,
        paymentId: params.paymentId as PaymentId,
        orderIds: [params.orderId],
        amount: params.amount,
        reason: params.reason,
        causation: params.causation ?? null,
        capToRemainingRefundable: params.capToRemainingRefundable ?? false,
      },
      params.context,
    );
  } catch (error) {
    await recordRefundEffectFailure(db, {
      table: "payments_support_refund_effects",
      keyColumn: "support_request_id",
      keyValue: params.supportRequestId,
      failureMessage: error instanceof Error ? error.message : "Support refund failed.",
      now: new Date().toISOString(),
    });
    return;
  }

  if (result.outcome === "not-refundable") {
    await db.query(
      `UPDATE payments_support_refund_effects
       SET status = 'skipped',
           failure_message = $2,
           updated_at = $3
       WHERE support_request_id = $1
         AND status = 'processing'`,
      [params.supportRequestId, result.reason, new Date().toISOString()],
    );
    return;
  }

  if (result.outcome === "gateway-failed") {
    await recordRefundEffectFailure(db, {
      table: "payments_support_refund_effects",
      keyColumn: "support_request_id",
      keyValue: params.supportRequestId,
      failureMessage: result.failureMessage,
      now: new Date().toISOString(),
    });
    return;
  }

  await db.query(
    `UPDATE payments_support_refund_effects
     SET payment_id = $2,
         refund_id = $3,
         requested_amount = $4,
         status = 'refund-requested',
         failure_message = NULL,
         updated_at = $5
     WHERE support_request_id = $1`,
    [params.supportRequestId, params.paymentId, result.refundId, result.amount, new Date().toISOString()],
  );
}

export function buildPaymentsSupportRefundEffectHandlers(
  db: PgQueryable,
  refunds: RefundServices,
): ProjectorHandlerMap {
  return {
    "fulfillment.return-shipment.requested.v2": async (event) => {
      const data = event.data as {
        returnShipmentId: string;
        supportRequestId: string;
        costPayer: string;
        requestedAt: string;
      };
      await db.query(
        `INSERT INTO payments_return_label_sources (
           return_shipment_id, support_request_id, cost_payer, updated_at
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (return_shipment_id) DO NOTHING`,
        [data.returnShipmentId, data.supportRequestId, data.costPayer, data.requestedAt],
      );
    },
    "fulfillment.return-shipment.label-ready.v1": async (event) => {
      const data = event.data as {
        returnShipmentId: string;
        postageAmountCents: number | null;
        postageCurrency: string | null;
        readyAt: string;
      };
      const amount = centsToMoney(data.postageAmountCents ?? 0);
      await db.query(
        `WITH source AS (
           UPDATE payments_return_label_sources
           SET postage_amount = $2::numeric,
               currency_code = $3,
               label_status = 'ready',
               updated_at = $4
           WHERE return_shipment_id = $1
           RETURNING support_request_id, cost_payer
         )
         UPDATE payments_support_refund_effects effect
         SET return_shipping_deduction_amount = $2::numeric,
             updated_at = $4
         WHERE effect.support_request_id = (SELECT support_request_id FROM source)
           AND (SELECT cost_payer FROM source) = 'buyer'
           AND effect.status IN ('awaiting-return', 'return-received', 'return-condition-disputed')`,
        [data.returnShipmentId, amount, data.postageCurrency, data.readyAt],
      );
    },
    "fulfillment.return-shipment.label-voided.v1": async (event) => {
      const data = event.data as { returnShipmentId: string; refundStatus: string; voidedAt: string };
      if (data.refundStatus.trim().toLowerCase() !== "refunded") return;
      await db.query(
        `WITH source AS (
           UPDATE payments_return_label_sources
           SET postage_amount = 0,
               label_status = 'voided',
               updated_at = $2
           WHERE return_shipment_id = $1
           RETURNING support_request_id, cost_payer
         )
         UPDATE payments_support_refund_effects effect
         SET return_shipping_deduction_amount = 0,
             updated_at = $2
         WHERE effect.support_request_id = (SELECT support_request_id FROM source)
           AND (SELECT cost_payer FROM source) = 'buyer'
           AND effect.status IN ('awaiting-return', 'return-received', 'return-condition-disputed')`,
        [data.returnShipmentId, data.voidedAt],
      );
    },
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
        capToRemainingRefundable: true,
        context: { tenantId: event.tenantId, audit: event.audit, trace: event.trace },
      });
    },
    "support.support-request.refund-released.v1": async (event) => {
      // Remedy-scoped refund release from a platform-covered resolution. The fact
      // carries the authorized allocation and (for platform-funded remedies) the
      // approved coverage reference; the normalizer rejects a platform-funded
      // release that lacks coverage before any provider work is attempted.
      const fact = normalizeSupportRequestRefundReleasedV1(
        event.data as Parameters<typeof normalizeSupportRequestRefundReleasedV1>[0],
      );

      const existing = await db.query<{ order_id: string; payment_id: string | null; status: string }>(
        `SELECT order_id, payment_id, status
         FROM payments_support_refund_effects
         WHERE support_request_id = $1`,
        [fact.supportRequestId],
      );
      const row = existing.rows[0];
      if (!row || !row.payment_id) {
        // No captured-payment-backed effect is registered for this remedy; Payments
        // cannot resolve the original rail. Fail closed: leave the remedy's
        // refund-completion effect unsatisfied for Support to surface, never a
        // silently misdirected or duplicated refund.
        return;
      }
      if (row.status === "refund-requested" || row.status === "processing") {
        // Already claimed/executed for this remedy; idempotent replay.
        return;
      }

      const [payment, orderInput] = await Promise.all([
        getCapturedPaymentByOrderId(db, row.order_id),
        getOrderPaymentInput(db, row.order_id),
      ]);
      if (!payment || !orderInput) {
        await db.query(
          `UPDATE payments_support_refund_effects
           SET status = 'failed',
               failure_message = $2,
               updated_at = $3
           WHERE support_request_id = $1`,
          [fact.supportRequestId, "Captured payment was not found when the remedy refund released.", fact.occurredAt],
        );
        return;
      }

      const remainingOrderAmount = remainingRefundableOrderAmount(payment, row.order_id, orderInput.total_amount);
      if (compareMoney(remainingOrderAmount, "0.00") <= 0) {
        await db.query(
          `UPDATE payments_support_refund_effects
           SET status = 'skipped',
               failure_message = $2,
               updated_at = $3
           WHERE support_request_id = $1`,
          [
            fact.supportRequestId,
            "Order had no remaining refundable amount when the remedy refund released.",
            fact.occurredAt,
          ],
        );
        return;
      }
      if (compareMoney(fact.refundAmount, remainingOrderAmount) > 0) {
        // The authorized remedy amount no longer fits the order's remaining
        // refundable balance. Payments cannot re-split seller vs platform liability
        // to fit a smaller refund, so it refuses rather than issue a refund whose
        // carried allocation would not sum to the amount. Surface for review.
        await markRemedyRefundManualReview(db, {
          supportRequestId: fact.supportRequestId,
          failureMessage: "Authorized remedy amount exceeds the order's remaining refundable balance.",
          now: fact.occurredAt,
        });
        return;
      }

      const claimed = await claimRemedyRefundRelease(db, {
        supportRequestId: fact.supportRequestId,
        refundId: refundIdForRemedy(fact.remedyId) as RefundId,
        now: fact.occurredAt,
      });
      if (!claimed) {
        return;
      }

      await issueClaimedRefund(db, refunds, {
        supportRequestId: fact.supportRequestId,
        paymentId: claimed.paymentId,
        refundId: claimed.refundId,
        orderId: claimed.orderId,
        amount: fact.refundAmount,
        reason: `Support ${fact.supportRequestId}: platform-coverage remedy refund released.`,
        causation: {
          remedyId: fact.remedyId,
          coverageId: fact.coverageId,
          allocation: fact.allocation,
          reasonCode: REMEDY_REFUND_RELEASED_REASON_CODE,
          refundTrigger: fact.refundTrigger,
          refundTriggerEvidenceRef: fact.causationId,
          policyVersion: fact.policyVersion,
        },
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

      const existing = await db.query<{
        requested_amount: string | null;
        return_shipping_deduction_amount: string;
        resolution_type: string;
      }>(
        `SELECT requested_amount::text AS requested_amount,
                return_shipping_deduction_amount::text AS return_shipping_deduction_amount,
                resolution_type
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
      const grossAmount = minMoney(pending.requested_amount, remainingOrderAmount);
      const amount = centsToMoney(
        Math.max(0, moneyToCents(grossAmount) - moneyToCents(pending.return_shipping_deduction_amount ?? "0.00")),
      );
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
        capToRemainingRefundable: true,
        context: { tenantId: event.tenantId, audit: event.audit, trace: event.trace },
      });
    },
  };
}
