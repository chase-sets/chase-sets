import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { decideReviewEligibility, type ReviewDirectionEligibility } from "@chase-sets/review-eligibility";
import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { mapReviewOpportunityToNotification } from "../notifications/notification-intents";
import { normalizeReviewRole } from "../../domain/common";
import { getReviewOrderBuyerEmail } from "../../read-model/queries";

export type ReviewEligibilityNotify = Readonly<{ outbox: NotificationOutbox }>;

// Recomputes the review-eligibility rows for one order from the source
// projections (order, shipments, support requests). Convergent by design:
// every handler that changes an input re-runs the same computation, so
// replays and out-of-order interleavings across support requests settle on
// the matrix documented in `@chase-sets/review-eligibility`.
//
// `notify` (m108) is optional so every existing caller (and every
// test constructing this function directly) keeps working unchanged; wiring
// it through fires the post-delivery review-opportunity notification the
// instant a direction becomes newly eligible -- whether that is the first
// grant after delivery or a re-arm after a suspend/restore cycle.
export async function syncReviewEligibilityForOrder(
  db: PgQueryable,
  orderId: string,
  updatedAt: string,
  notify?: ReviewEligibilityNotify,
) {
  const orderResult = await db.query<{
    buyer_account_id: string;
    seller_account_id: string;
  }>(
    `SELECT buyer_account_id, seller_account_id
     FROM marketplace_review_order_sources
     WHERE order_id = $1`,
    [orderId],
  );
  const order = orderResult.rows[0];
  if (!order) {
    return;
  }

  // `delivered_at` (not status = 'delivered') so a shipment that later flips
  // to 'returned' — the return leg of a return-for-refund — still proves the
  // original delivery happened.
  const deliveredResult = await db.query<{ delivered_at: string | null }>(
    `SELECT MIN(delivered_at)::text AS delivered_at
     FROM marketplace_review_shipment_sources
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
     FROM marketplace_review_support_request_sources
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

  await applyDirection(db, {
    orderId,
    authorAccountId: order.buyer_account_id,
    subjectAccountId: order.seller_account_id,
    authorRole: "buyer",
    direction: decision.buyerToSeller,
    updatedAt,
    notify,
  });
  await applyDirection(db, {
    orderId,
    authorAccountId: order.seller_account_id,
    subjectAccountId: order.buyer_account_id,
    authorRole: "seller",
    direction: decision.sellerToBuyer,
    updatedAt,
    notify,
  });
}

async function applyDirection(
  db: PgQueryable,
  params: Readonly<{
    orderId: string;
    authorAccountId: string;
    subjectAccountId: string;
    authorRole: "buyer" | "seller";
    direction: ReviewDirectionEligibility;
    updatedAt: string;
    notify?: ReviewEligibilityNotify;
  }>,
) {
  if (params.direction.eligible && params.direction.eligibleAt !== null) {
    // Read-before-write (mirrors the pre-check idiom already used by other
    // notification-intent projectors in this codebase, e.g. discovery's
    // product-alert projector loading market activity before its upsert):
    // a row already present means this is an update to an already-armed
    // direction (no new opportunity to notify); no row means this grant is
    // either the first one for this order/direction or a re-arm after a
    // suspend/restore cycle deleted the prior row -- both fire the
    // opportunity notification.
    const existingResult = await db.query(
      `SELECT 1
       FROM marketplace_review_eligibility_pages
       WHERE order_id = $1
         AND author_account_id = $2
         AND subject_account_id = $3`,
      [params.orderId, params.authorAccountId, params.subjectAccountId],
    );
    const isNewGrant = existingResult.rows.length === 0;

    await db.query(
      `INSERT INTO marketplace_review_eligibility_pages (
         order_id,
         author_account_id,
         subject_account_id,
         author_role,
         resolution_context,
         eligible_at,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (order_id, author_account_id, subject_account_id) DO UPDATE
       SET author_role = EXCLUDED.author_role,
           resolution_context = EXCLUDED.resolution_context,
           eligible_at = EXCLUDED.eligible_at,
           updated_at = EXCLUDED.updated_at`,
      [
        params.orderId,
        params.authorAccountId,
        params.subjectAccountId,
        params.authorRole,
        params.direction.resolutionContext,
        params.direction.eligibleAt,
        params.updatedAt,
      ],
    );

    if (isNewGrant && params.notify) {
      await notifyReviewOpportunity(db, params.notify.outbox, params);
    }
    return;
  }

  await db.query(
    `DELETE FROM marketplace_review_eligibility_pages
     WHERE order_id = $1
       AND author_account_id = $2
       AND subject_account_id = $3`,
    [params.orderId, params.authorAccountId, params.subjectAccountId],
  );
}

async function notifyReviewOpportunity(
  db: PgQueryable,
  outbox: NotificationOutbox,
  params: Readonly<{
    orderId: string;
    authorAccountId: string;
    subjectAccountId: string;
    authorRole: "buyer" | "seller";
    updatedAt: string;
  }>,
) {
  const authorRole = normalizeReviewRole(params.authorRole);
  const [subjectResult, buyerEmail] = await Promise.all([
    db.query<{ display_name: string | null }>(
      `SELECT display_name FROM marketplace_review_account_sources WHERE account_id = $1`,
      [params.subjectAccountId],
    ),
    authorRole === "buyer" ? getReviewOrderBuyerEmail(db, params.orderId) : Promise.resolve(null),
  ]);

  await outbox.enqueueNotification({
    message: mapReviewOpportunityToNotification({
      orderId: params.orderId,
      authorAccountId: params.authorAccountId as AccountId,
      authorRole,
      subjectDisplayName: subjectResult.rows[0]?.display_name ?? null,
      buyerEmail,
      armedAt: params.updatedAt,
      correlationId: `marketplace-review-eligibility:${params.orderId}:${params.authorAccountId}:${params.updatedAt}`,
    }),
    source: {
      sourceEventId: `marketplace-review-eligibility:${params.orderId}:${params.authorAccountId}`,
      sourceGlobalPosition: "0",
      projectionName: "marketplace-review-eligibility-notify",
      occurredAt: params.updatedAt,
    },
  });
}
