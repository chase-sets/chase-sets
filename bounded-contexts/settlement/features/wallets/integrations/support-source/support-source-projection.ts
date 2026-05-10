import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

const refundResolutionTypes = new Set([
  "full-refund",
  "partial-refund",
  "return-for-refund",
  "cancel-order",
]);

export function buildSettlementSupportHoldProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
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
        `INSERT INTO settlement_support_holds (
           support_request_id,
           order_id,
           buyer_account_id,
           seller_account_id,
           flow_type,
           status,
           resolution_type,
           active,
           opened_at,
           updated_at,
           released_at,
           release_reason,
           last_stream_version
         ) VALUES ($1, $2, $3, $4, $5, $6, NULL, TRUE, $7, $7, NULL, NULL, $8)
         ON CONFLICT (support_request_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             buyer_account_id = EXCLUDED.buyer_account_id,
             seller_account_id = EXCLUDED.seller_account_id,
             flow_type = EXCLUDED.flow_type,
             status = EXCLUDED.status,
             active = TRUE,
             updated_at = EXCLUDED.updated_at,
             released_at = NULL,
             release_reason = NULL,
             last_stream_version = EXCLUDED.last_stream_version
         WHERE settlement_support_holds.last_stream_version < EXCLUDED.last_stream_version`,
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
    "support.support-request.escalated": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        escalatedAt: string;
      };

      await db.query(
        `UPDATE settlement_support_holds
         SET status = 'ready-for-support',
             updated_at = $2,
             last_stream_version = $3
         WHERE support_request_id = $1
           AND last_stream_version < $3`,
        [data.supportRequestId, data.escalatedAt, event.streamVersion],
      );
    },
    "support.support-request.resolved": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        resolution: {
          resolutionType: string;
          resolvedAt: string;
        };
      };
      const keepHold = refundResolutionTypes.has(data.resolution.resolutionType);

      await db.query(
        `UPDATE settlement_support_holds
         SET status = 'resolved',
             resolution_type = $2,
             active = $3,
             updated_at = $4,
             released_at = CASE WHEN $3 THEN released_at ELSE $4 END,
             release_reason = CASE WHEN $3 THEN release_reason ELSE 'support-resolved' END,
             last_stream_version = $5
         WHERE support_request_id = $1
           AND last_stream_version < $5`,
        [
          data.supportRequestId,
          data.resolution.resolutionType,
          keepHold,
          data.resolution.resolvedAt,
          event.streamVersion,
        ],
      );
    },
    "support.support-request.closed": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        closedAt: string;
      };

      await db.query(
        `UPDATE settlement_support_holds
         SET status = 'closed',
             active = CASE
               WHEN resolution_type IN ('full-refund', 'partial-refund', 'return-for-refund', 'cancel-order') THEN active
               ELSE FALSE
             END,
             updated_at = $2,
             released_at = CASE
               WHEN resolution_type IN ('full-refund', 'partial-refund', 'return-for-refund', 'cancel-order') THEN released_at
               ELSE $2
             END,
             release_reason = CASE
               WHEN resolution_type IN ('full-refund', 'partial-refund', 'return-for-refund', 'cancel-order') THEN release_reason
               ELSE 'support-closed'
             END,
             last_stream_version = $3
         WHERE support_request_id = $1
           AND last_stream_version < $3`,
        [data.supportRequestId, data.closedAt, event.streamVersion],
      );
    },
    "support.support-request.cancelled": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        cancelledAt: string;
      };

      await db.query(
        `UPDATE settlement_support_holds
         SET status = 'cancelled',
             active = FALSE,
             updated_at = $2,
             released_at = $2,
             release_reason = 'support-cancelled',
             last_stream_version = $3
         WHERE support_request_id = $1
           AND last_stream_version < $3`,
        [data.supportRequestId, data.cancelledAt, event.streamVersion],
      );
    },
  };
}
