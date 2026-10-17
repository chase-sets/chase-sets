import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  isReviewOpportunityChangedV1,
  isReviewOpportunityPosition,
  reviewOpportunityFactType,
} from "@chase-sets/event-core/review-opportunity-facts";

export const orderingOpportunitySourceEvents = {
  ordering: ["ordering.order.created", "ordering.order.cancelled"],
  fulfillment: ["fulfillment.shipment.created", "fulfillment.shipment.delivered"],
  "platform-operations": [
    "support.support-request.opened",
    "support.support-request.resolved",
    "support.support-request.cancelled",
    "support.support-request.remedy-authorized.v1",
  ],
  marketplace: [
    "marketplace.review.submitted",
    "marketplace.review.updated",
    "marketplace.review.withdrawn",
    "marketplace.review.revealed",
    "marketplace.review-hold.placed",
    "marketplace.review-hold.extended",
    "marketplace.review-hold.reduced",
    "marketplace.review-hold.released",
    "marketplace.review-hold.terminal-recorded",
    "marketplace.review-scoring.disposition-projected.v1",
    reviewOpportunityFactType,
  ],
} as const;

export function buildOrderingReputationProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  const handlers: Record<string, ProjectorHandlerMap[string]> = {};
  for (const [source, eventTypes] of Object.entries(orderingOpportunitySourceEvents)) {
    for (const eventType of eventTypes) {
      handlers[eventType] = async (event) => {
        if (eventType === reviewOpportunityFactType) {
          const valid = isReviewOpportunityChangedV1(event.data);
          const data = event.data;
          const orderId = data.orderId;
          if (typeof orderId !== "string" || orderId.length === 0)
            throw new Error("Review opportunity order identity is missing.");
          const generation = isReviewOpportunityPosition(data.generation) ? data.generation : "0";
          await db.query(
            `INSERT INTO ordering_order_review_opportunity_pages (order_id, generation, source_position, fact, valid)
             VALUES ($1, $2, $3, $4::jsonb, $5)
             ON CONFLICT (order_id) DO UPDATE SET generation = GREATEST(ordering_order_review_opportunity_pages.generation, EXCLUDED.generation),
               source_position = EXCLUDED.source_position, fact = EXCLUDED.fact, valid = EXCLUDED.valid
             WHERE EXCLUDED.source_position > ordering_order_review_opportunity_pages.source_position
               AND (NOT EXCLUDED.valid OR EXCLUDED.generation > ordering_order_review_opportunity_pages.generation)`,
            [orderId, generation, event.globalPosition, valid ? JSON.stringify(data) : null, valid],
          );
          return;
        }
        const data = event.data;
        let orderId = typeof data.orderId === "string" ? data.orderId : undefined;
        if (source === "platform-operations" && typeof data.supportRequestId === "string") {
          if (orderId) {
            await db.query(
              `INSERT INTO ordering_order_review_support_request_sources (support_request_id, order_id, status, updated_at)
               VALUES ($1, $2, 'observed', $3) ON CONFLICT (support_request_id) DO UPDATE SET order_id = EXCLUDED.order_id`,
              [data.supportRequestId, orderId, event.timing.recordedAt],
            );
          } else {
            orderId = (
              await db.query<{ order_id: string }>(
                `SELECT order_id FROM ordering_order_review_support_request_sources WHERE support_request_id = $1`,
                [data.supportRequestId],
              )
            ).rows[0]?.order_id;
          }
        }
        if (eventType === "fulfillment.shipment.created") {
          await db.query(
            `INSERT INTO ordering_order_review_shipment_sources (shipment_id, order_id, status, created_at, updated_at, delivered_at)
             VALUES ($1, $2, 'awaiting-package', $3, $3, NULL)
             ON CONFLICT (shipment_id) DO UPDATE SET order_id = EXCLUDED.order_id, updated_at = EXCLUDED.updated_at`,
            [data.shipmentId, data.orderId, data.createdAt],
          );
        }
        if (eventType === "fulfillment.shipment.delivered") {
          orderId = (
            await db.query<{ order_id: string }>(
              `UPDATE ordering_order_review_shipment_sources SET status = 'delivered', delivered_at = $2, updated_at = $2
             WHERE shipment_id = $1 RETURNING order_id`,
              [data.shipmentId, data.deliveredAt],
            )
          ).rows[0]?.order_id;
        }
        if (eventType === "marketplace.review.submitted") {
          await db.query(
            `INSERT INTO ordering_order_review_pages (review_id, order_id, author_account_id, subject_account_id, author_role,
               status, submitted_at, updated_at, withdrawn_at)
             VALUES ($1, $2, $3, $4, $5, 'active', $6, $6, NULL)
             ON CONFLICT (review_id) DO NOTHING`,
            [
              data.reviewId,
              data.orderId,
              data.authorAccountId,
              data.subjectAccountId,
              data.authorRole,
              data.submittedAt,
            ],
          );
        }
        if (!orderId && typeof data.reviewId === "string") {
          orderId = (
            await db.query<{ order_id: string }>(
              `SELECT order_id FROM ordering_order_review_pages WHERE review_id = $1`,
              [data.reviewId],
            )
          ).rows[0]?.order_id;
        }
        if (eventType === "marketplace.review.withdrawn") {
          await db.query(
            `UPDATE ordering_order_review_pages SET status = 'withdrawn', withdrawn_at = $2, updated_at = $2 WHERE review_id = $1`,
            [data.reviewId, data.withdrawnAt],
          );
        }
        if (!orderId) return;
        await db.query(
          `INSERT INTO ordering_order_review_opportunity_sources (order_id, source_context_name, source_position)
           VALUES ($1, $2, $3) ON CONFLICT (order_id, source_context_name) DO UPDATE
           SET source_position = GREATEST(ordering_order_review_opportunity_sources.source_position, EXCLUDED.source_position)`,
          [orderId, source, event.globalPosition],
        );
      };
    }
  }
  return handlers;
}
