import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

const refundResolutionTypes = new Set(["full-refund", "partial-refund", "return-for-refund", "cancel-order"]);

function currencyCode(value: unknown): string {
  return (
    String(value ?? "USD")
      .trim()
      .toUpperCase() || "USD"
  );
}

export function buildOrderingMoneyTimelineProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "payments.refund-requested": async (event) => {
      const data = event.data as {
        refundId: string;
        paymentId: string;
        orderIds: readonly string[];
        amount: string;
        currencyCode: string;
        requestedAt: string;
      };
      const orderAmount = data.orderIds.length === 1 ? data.amount : null;

      for (const orderId of data.orderIds) {
        await db.query(
          `INSERT INTO ordering_order_refund_timeline_pages (
             refund_id,
             order_id,
             payment_id,
             amount,
             currency_code,
             status,
             requested_at,
             issued_at,
             failed_at,
             last_stream_version
           ) VALUES ($1, $2, $3, $4, $5, 'requested', $6, NULL, NULL, $7)
           ON CONFLICT (refund_id, order_id) DO UPDATE
           SET payment_id = EXCLUDED.payment_id,
               amount = EXCLUDED.amount,
               currency_code = EXCLUDED.currency_code,
               status = EXCLUDED.status,
               requested_at = EXCLUDED.requested_at,
               issued_at = NULL,
               failed_at = NULL,
               last_stream_version = EXCLUDED.last_stream_version
           WHERE ordering_order_refund_timeline_pages.last_stream_version < EXCLUDED.last_stream_version`,
          [
            data.refundId,
            orderId,
            data.paymentId,
            orderAmount,
            currencyCode(data.currencyCode),
            data.requestedAt,
            event.streamVersion,
          ],
        );
      }
    },
    "payments.refund-issued": async (event) => {
      const data = event.data as { refundId: string; issuedAt: string };
      await db.query(
        `UPDATE ordering_order_refund_timeline_pages
         SET status = 'issued',
             issued_at = $2,
             failed_at = NULL,
             last_stream_version = $3
         WHERE refund_id = $1
           AND last_stream_version < $3`,
        [data.refundId, data.issuedAt, event.streamVersion],
      );
    },
    "payments.refund-failed": async (event) => {
      const data = event.data as { refundId: string; failedAt: string };
      await db.query(
        `UPDATE ordering_order_refund_timeline_pages
         SET status = 'failed',
             failed_at = $2,
             last_stream_version = $3
         WHERE refund_id = $1
           AND last_stream_version < $3`,
        [data.refundId, data.failedAt, event.streamVersion],
      );
    },
    "payments.payment-refunded": async (event) => {
      const data = event.data as {
        currencyCode: string;
        refundedOrderAmounts?: readonly Readonly<{ orderId: string; amount: string }>[];
        orderRefundAmounts?: readonly Readonly<{ orderId: string; amount: string }>[];
        refundedAt: string;
      };
      const cumulativeAmounts = data.refundedOrderAmounts ?? data.orderRefundAmounts ?? [];

      for (const orderAmount of cumulativeAmounts) {
        await db.query(
          `INSERT INTO ordering_order_refund_totals (
             order_id,
             refunded_amount,
             currency_code,
             refunded_at
           ) VALUES ($1, $2, $3, $4)
           ON CONFLICT (order_id) DO UPDATE
           SET refunded_amount = EXCLUDED.refunded_amount,
               currency_code = EXCLUDED.currency_code,
               refunded_at = EXCLUDED.refunded_at
           WHERE ordering_order_refund_totals.refunded_at < EXCLUDED.refunded_at`,
          [orderAmount.orderId, orderAmount.amount, currencyCode(data.currencyCode), data.refundedAt],
        );
      }
    },
    "support.support-request.opened": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        orderId: string;
        buyerAccountId: string;
        sellerAccountId: string;
        flowType: string;
        status: string;
        openedAt: string;
      };
      await db.query(
        `INSERT INTO ordering_order_support_money_pages (
           support_request_id,
           order_id,
           buyer_account_id,
           seller_account_id,
           flow_type,
           status,
           resolution_type,
           refund_amount,
           active_hold,
           opened_at,
           resolved_at,
           released_at,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, TRUE, $7, NULL, NULL, $8)
         ON CONFLICT (support_request_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             buyer_account_id = EXCLUDED.buyer_account_id,
             seller_account_id = EXCLUDED.seller_account_id,
             flow_type = EXCLUDED.flow_type,
             status = EXCLUDED.status,
             resolution_type = NULL,
             refund_amount = NULL,
             active_hold = TRUE,
             opened_at = EXCLUDED.opened_at,
             resolved_at = NULL,
             released_at = NULL,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE ordering_order_support_money_pages.last_stream_version < EXCLUDED.last_stream_version`,
        [
          data.supportRequestId,
          data.orderId,
          data.buyerAccountId,
          data.sellerAccountId,
          data.flowType,
          data.status,
          data.openedAt,
          event.streamVersion,
        ],
      );
    },
    "support.support-request.resolved": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        resolution: { resolutionType: string; refundAmount?: string | null; resolvedAt: string };
      };
      const activeHold = refundResolutionTypes.has(data.resolution.resolutionType);
      await db.query(
        `UPDATE ordering_order_support_money_pages
         SET status = 'resolved',
             resolution_type = $2,
             refund_amount = $3,
             active_hold = $4,
             resolved_at = $5,
             released_at = CASE WHEN $4 THEN released_at ELSE $5 END,
             last_stream_version = $6
         WHERE support_request_id = $1
           AND last_stream_version < $6`,
        [
          data.supportRequestId,
          data.resolution.resolutionType,
          data.resolution.refundAmount ?? null,
          activeHold,
          data.resolution.resolvedAt,
          event.streamVersion,
        ],
      );
    },
    "support.support-request.closed": async (event) => {
      const data = event.data as { supportRequestId: string; closedAt: string };
      await db.query(
        `UPDATE ordering_order_support_money_pages
         SET status = 'closed',
             active_hold = CASE
               WHEN resolution_type IN ('full-refund', 'partial-refund', 'return-for-refund', 'cancel-order')
                 THEN active_hold
               ELSE FALSE
             END,
             released_at = CASE
               WHEN resolution_type IN ('full-refund', 'partial-refund', 'return-for-refund', 'cancel-order')
                 THEN released_at
               ELSE $2
             END,
             last_stream_version = $3
         WHERE support_request_id = $1
           AND last_stream_version < $3`,
        [data.supportRequestId, data.closedAt, event.streamVersion],
      );
    },
    "support.support-request.cancelled": async (event) => {
      const data = event.data as { supportRequestId: string; cancelledAt: string };
      await db.query(
        `UPDATE ordering_order_support_money_pages
         SET status = 'cancelled',
             active_hold = FALSE,
             released_at = $2,
             last_stream_version = $3
         WHERE support_request_id = $1
           AND last_stream_version < $3`,
        [data.supportRequestId, data.cancelledAt, event.streamVersion],
      );
    },
    "settlement.protection-coverage.settled.v1": async (event) => {
      const data = event.data as { supportRequestId: string; occurredAt: string };
      await db.query(
        `INSERT INTO ordering_order_hold_reconciliations (
           support_request_id,
           reconciled_at,
           last_stream_version
         ) VALUES ($1, $2, $3)
         ON CONFLICT (support_request_id) DO UPDATE
         SET reconciled_at = EXCLUDED.reconciled_at,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE ordering_order_hold_reconciliations.reconciled_at < EXCLUDED.reconciled_at`,
        [data.supportRequestId, data.occurredAt, event.streamVersion],
      );
    },
  };
}
