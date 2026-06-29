import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

async function restoreEligibilityIfDelivered(db: PgQueryable, orderId: string, updatedAt: string) {
  const result = await db.query<{
    buyer_account_id: string;
    seller_account_id: string;
    delivered_at: string;
  }>(
    `SELECT
       order_page.buyer_account_id,
       order_page.seller_account_id,
       shipment_source.delivered_at::text AS delivered_at
     FROM ordering_order_pages AS order_page
     JOIN ordering_order_review_shipment_sources AS shipment_source
       ON shipment_source.order_id = order_page.order_id
      AND shipment_source.status = 'delivered'
     WHERE order_page.order_id = $1
      AND NOT EXISTS (
        SELECT 1
        FROM ordering_order_review_support_request_sources AS support_source
        WHERE support_source.order_id = order_page.order_id
          AND NOT (
            support_source.status = 'cancelled'
            OR (
              support_source.status = 'resolved'
              AND support_source.resolution_type IN ('no-action', 'support-reviewed')
            )
          )
      )
     ORDER BY shipment_source.delivered_at ASC
     LIMIT 1`,
    [orderId],
  );

  const row = result.rows[0];
  if (!row) {
    return;
  }

  await db.query(
    `INSERT INTO ordering_order_review_eligibility_pages (
       order_id,
       author_account_id,
       subject_account_id,
       author_role,
       eligible_at,
       updated_at
     ) VALUES
       ($1, $2, $3, 'buyer', $4, $5),
       ($1, $3, $2, 'seller', $4, $5)
     ON CONFLICT (order_id, author_account_id, subject_account_id) DO UPDATE
     SET eligible_at = EXCLUDED.eligible_at,
         updated_at = EXCLUDED.updated_at`,
    [orderId, row.buyer_account_id, row.seller_account_id, row.delivered_at ?? updatedAt, updatedAt],
  );
}

export function buildOrderingReputationProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "ordering.order.created": async (event) => {
      const data = event.data as { orderId: string };
      await restoreEligibilityIfDelivered(db, data.orderId, event.timing.recordedAt);
    },
    "fulfillment.shipment.created": async (event) => {
      const data = event.data as {
        shipmentId: string;
        orderId: string;
        createdAt: string;
      };

      await db.query(
        `INSERT INTO ordering_order_review_shipment_sources (
           shipment_id,
           order_id,
           status,
           created_at,
           updated_at,
           delivered_at
         ) VALUES ($1, $2, 'awaiting-package', $3, $3, NULL)
         ON CONFLICT (shipment_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             updated_at = EXCLUDED.updated_at`,
        [data.shipmentId, data.orderId, data.createdAt],
      );
    },
    "fulfillment.shipment.delivered": async (event) => {
      const data = event.data as {
        shipmentId: string;
        deliveredAt: string;
      };

      const shipmentResult = await db.query<{ order_id: string }>(
        `UPDATE ordering_order_review_shipment_sources
         SET status = 'delivered',
             delivered_at = $2,
             updated_at = $2
         WHERE shipment_id = $1
         RETURNING order_id`,
        [data.shipmentId, data.deliveredAt],
      );

      const orderId = shipmentResult.rows[0]?.order_id;
      if (orderId) {
        await restoreEligibilityIfDelivered(db, orderId, data.deliveredAt);
      }
    },
    "support.support-request.opened": async (event) => {
      const data = event.data as { supportRequestId: string; orderId: string; openedAt: string };

      await db.query(
        `INSERT INTO ordering_order_review_support_request_sources (
           support_request_id,
           order_id,
           status,
           resolution_type,
           opened_at,
           updated_at,
           cancelled_at,
           resolved_at
         ) VALUES ($1, $2, 'open', NULL, $3, $3, NULL, NULL)
         ON CONFLICT (support_request_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             status = EXCLUDED.status,
             resolution_type = EXCLUDED.resolution_type,
             opened_at = COALESCE(ordering_order_review_support_request_sources.opened_at, EXCLUDED.opened_at),
             updated_at = EXCLUDED.updated_at,
             cancelled_at = EXCLUDED.cancelled_at,
             resolved_at = EXCLUDED.resolved_at`,
        [data.supportRequestId, data.orderId, data.openedAt],
      );

      await db.query(
        `DELETE FROM ordering_order_review_eligibility_pages
         WHERE order_id = $1`,
        [data.orderId],
      );
    },
    "support.support-request.cancelled": async (event) => {
      const data = event.data as { supportRequestId: string; orderId: string; cancelledAt: string };
      await db.query(
        `INSERT INTO ordering_order_review_support_request_sources (
           support_request_id,
           order_id,
           status,
           resolution_type,
           opened_at,
           updated_at,
           cancelled_at,
           resolved_at
         ) VALUES ($1, $2, 'cancelled', NULL, NULL, $3, $3, NULL)
         ON CONFLICT (support_request_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             status = EXCLUDED.status,
             resolution_type = EXCLUDED.resolution_type,
             updated_at = EXCLUDED.updated_at,
             cancelled_at = EXCLUDED.cancelled_at,
             resolved_at = EXCLUDED.resolved_at`,
        [data.supportRequestId, data.orderId, data.cancelledAt],
      );
      await restoreEligibilityIfDelivered(db, data.orderId, data.cancelledAt);
    },
    "support.support-request.resolved": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        orderId: string;
        resolution: { resolutionType: string; resolvedAt: string };
      };
      await db.query(
        `INSERT INTO ordering_order_review_support_request_sources (
           support_request_id,
           order_id,
           status,
           resolution_type,
           opened_at,
           updated_at,
           cancelled_at,
           resolved_at
         ) VALUES ($1, $2, 'resolved', $3, NULL, $4, NULL, $4)
         ON CONFLICT (support_request_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             status = EXCLUDED.status,
             resolution_type = EXCLUDED.resolution_type,
             updated_at = EXCLUDED.updated_at,
             cancelled_at = EXCLUDED.cancelled_at,
             resolved_at = EXCLUDED.resolved_at`,
        [data.supportRequestId, data.orderId, data.resolution.resolutionType, data.resolution.resolvedAt],
      );
      if (data.resolution.resolutionType === "no-action" || data.resolution.resolutionType === "support-reviewed") {
        await restoreEligibilityIfDelivered(db, data.orderId, data.resolution.resolvedAt);
      }
    },
    "marketplace.review.submitted": async (event) => {
      const data = event.data as {
        reviewId: string;
        orderId: string;
        authorAccountId: string;
        subjectAccountId: string;
        authorRole: string;
        submittedAt: string;
      };

      await db.query(
        `INSERT INTO ordering_order_review_pages (
           review_id,
           order_id,
           author_account_id,
           subject_account_id,
           author_role,
           status,
           submitted_at,
           updated_at,
           withdrawn_at
         ) VALUES ($1, $2, $3, $4, $5, 'active', $6, $6, NULL)
         ON CONFLICT (review_id) DO UPDATE
         SET status = EXCLUDED.status,
             updated_at = EXCLUDED.updated_at,
             withdrawn_at = EXCLUDED.withdrawn_at`,
        [data.reviewId, data.orderId, data.authorAccountId, data.subjectAccountId, data.authorRole, data.submittedAt],
      );
    },
    "marketplace.review.updated": async (event) => {
      const data = event.data as { reviewId: string; updatedAt: string };

      await db.query(
        `UPDATE ordering_order_review_pages
         SET updated_at = $2
         WHERE review_id = $1`,
        [data.reviewId, data.updatedAt],
      );
    },
    "marketplace.review.withdrawn": async (event) => {
      const data = event.data as { reviewId: string; withdrawnAt: string };

      await db.query(
        `UPDATE ordering_order_review_pages
         SET status = 'withdrawn',
             withdrawn_at = $2,
             updated_at = $2
         WHERE review_id = $1`,
        [data.reviewId, data.withdrawnAt],
      );
    },
  };
}
