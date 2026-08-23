import type { ChaseSetsEventPayloads } from "@chase-sets/event-core/public-event-payloads";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { decideReviewEligibility, type ReviewDirectionEligibility } from "@chase-sets/review-eligibility";

// Recomputes the order's review-eligibility rows (the order-detail review
// hint) from the source projections. Applies the resolution-class × direction
// matrix owned by the reputation slice — see
// `@chase-sets/review-eligibility` for the documented matrix.
async function syncOrderReviewEligibility(db: PgQueryable, orderId: string, updatedAt: string) {
  const orderResult = await db.query<{
    buyer_account_id: string;
    seller_account_id: string;
  }>(
    `SELECT buyer_account_id, seller_account_id
     FROM ordering_order_pages
     WHERE order_id = $1`,
    [orderId],
  );
  const order = orderResult.rows[0];
  if (!order) {
    return;
  }

  const deliveredResult = await db.query<{ delivered_at: string | null }>(
    `SELECT MIN(delivered_at)::text AS delivered_at
     FROM ordering_order_review_shipment_sources
     WHERE order_id = $1
       AND delivered_at IS NOT NULL`,
    [orderId],
  );
  const deliveredAt = deliveredResult.rows[0]?.delivered_at ?? null;

  const supportResult = await db.query<{
    status: string;
    resolution_type: string | null;
    flow_type: string | null;
    resolved_at: string | null;
  }>(
    `SELECT
       status,
       resolution_type,
       flow_type,
       resolved_at::text AS resolved_at
     FROM ordering_order_review_support_request_sources
     WHERE order_id = $1`,
    [orderId],
  );

  const decision = decideReviewEligibility({
    deliveredAt,
    supportRequests: supportResult.rows.map((row) => ({
      status: row.status,
      resolutionType: row.resolution_type,
      flowType: row.flow_type,
      resolvedAt: row.resolved_at,
    })),
  });

  await applyEligibilityDirection(db, {
    orderId,
    authorAccountId: order.buyer_account_id,
    subjectAccountId: order.seller_account_id,
    authorRole: "buyer",
    direction: decision.buyerToSeller,
    updatedAt,
  });
  await applyEligibilityDirection(db, {
    orderId,
    authorAccountId: order.seller_account_id,
    subjectAccountId: order.buyer_account_id,
    authorRole: "seller",
    direction: decision.sellerToBuyer,
    updatedAt,
  });
}

async function applyEligibilityDirection(
  db: PgQueryable,
  params: Readonly<{
    orderId: string;
    authorAccountId: string;
    subjectAccountId: string;
    authorRole: "buyer" | "seller";
    direction: ReviewDirectionEligibility;
    updatedAt: string;
  }>,
) {
  if (params.direction.eligible && params.direction.eligibleAt !== null) {
    await db.query(
      `INSERT INTO ordering_order_review_eligibility_pages (
         order_id,
         author_account_id,
         subject_account_id,
         author_role,
         eligible_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (order_id, author_account_id, subject_account_id) DO UPDATE
       SET author_role = EXCLUDED.author_role,
           eligible_at = EXCLUDED.eligible_at,
           updated_at = EXCLUDED.updated_at`,
      [
        params.orderId,
        params.authorAccountId,
        params.subjectAccountId,
        params.authorRole,
        params.direction.eligibleAt,
        params.updatedAt,
      ],
    );
    return;
  }

  await db.query(
    `DELETE FROM ordering_order_review_eligibility_pages
     WHERE order_id = $1
       AND author_account_id = $2
       AND subject_account_id = $3`,
    [params.orderId, params.authorAccountId, params.subjectAccountId],
  );
}

export function buildOrderingReputationProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "ordering.order.created": async (event) => {
      const data = event.data as { orderId: string };
      await syncOrderReviewEligibility(db, data.orderId, event.timing.recordedAt);
    },
    ...defineProjectorHandlers<
      Pick<ChaseSetsEventPayloads, "fulfillment.shipment.created" | "fulfillment.shipment.delivered">
    >({
      "fulfillment.shipment.created": async (event) => {
        const { data } = event;

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
        const { data } = event;

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
          await syncOrderReviewEligibility(db, orderId, data.deliveredAt);
        }
      },
    }),
    "support.support-request.opened": async (event) => {
      const data = event.data as { supportRequestId: string; orderId: string; openedAt: string };

      await db.query(
        `INSERT INTO ordering_order_review_support_request_sources (
           support_request_id,
           order_id,
           status,
           resolution_type,
           flow_type,
           opened_at,
           updated_at,
           cancelled_at,
           resolved_at
         ) VALUES ($1, $2, 'open', NULL, NULL, $3, $3, NULL, NULL)
         ON CONFLICT (support_request_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             status = EXCLUDED.status,
             resolution_type = EXCLUDED.resolution_type,
             flow_type = EXCLUDED.flow_type,
             opened_at = COALESCE(ordering_order_review_support_request_sources.opened_at, EXCLUDED.opened_at),
             updated_at = EXCLUDED.updated_at,
             cancelled_at = EXCLUDED.cancelled_at,
             resolved_at = EXCLUDED.resolved_at`,
        [data.supportRequestId, data.orderId, data.openedAt],
      );

      await syncOrderReviewEligibility(db, data.orderId, data.openedAt);
    },
    "support.support-request.cancelled": async (event) => {
      const data = event.data as { supportRequestId: string; orderId: string; cancelledAt: string };
      await db.query(
        `INSERT INTO ordering_order_review_support_request_sources (
           support_request_id,
           order_id,
           status,
           resolution_type,
           flow_type,
           opened_at,
           updated_at,
           cancelled_at,
           resolved_at
         ) VALUES ($1, $2, 'cancelled', NULL, NULL, NULL, $3, $3, NULL)
         ON CONFLICT (support_request_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             status = EXCLUDED.status,
             resolution_type = EXCLUDED.resolution_type,
             flow_type = EXCLUDED.flow_type,
             updated_at = EXCLUDED.updated_at,
             cancelled_at = EXCLUDED.cancelled_at,
             resolved_at = EXCLUDED.resolved_at`,
        [data.supportRequestId, data.orderId, data.cancelledAt],
      );
      await syncOrderReviewEligibility(db, data.orderId, data.cancelledAt);
    },
    "support.support-request.resolved": async (event) => {
      const data = event.data as {
        supportRequestId: string;
        orderId: string;
        flowType?: string | null;
        resolution: { resolutionType: string; resolvedAt: string };
      };
      await db.query(
        `INSERT INTO ordering_order_review_support_request_sources (
           support_request_id,
           order_id,
           status,
           resolution_type,
           flow_type,
           opened_at,
           updated_at,
           cancelled_at,
           resolved_at
         ) VALUES ($1, $2, 'resolved', $3, $4, NULL, $5, NULL, $5)
         ON CONFLICT (support_request_id) DO UPDATE
         SET order_id = EXCLUDED.order_id,
             status = EXCLUDED.status,
             resolution_type = EXCLUDED.resolution_type,
             flow_type = EXCLUDED.flow_type,
             updated_at = EXCLUDED.updated_at,
             cancelled_at = EXCLUDED.cancelled_at,
             resolved_at = EXCLUDED.resolved_at`,
        [
          data.supportRequestId,
          data.orderId,
          data.resolution.resolutionType,
          data.flowType ?? null,
          data.resolution.resolvedAt,
        ],
      );
      await syncOrderReviewEligibility(db, data.orderId, data.resolution.resolvedAt);
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
