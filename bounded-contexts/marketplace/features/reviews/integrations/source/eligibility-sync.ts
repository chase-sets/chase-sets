import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import { isBuyerRemedyKind } from "@chase-sets/primitives/platform-coverage";
import { parseTypedId, type AccountId } from "@chase-sets/primitives/typed-ids";
import { mapReviewOpportunityToNotification } from "../notifications/notification-intents";
import { normalizeReviewRole } from "../../domain/common";
import {
  decideDirectionalReviewDisposition,
  type DirectionalReviewDisposition,
} from "../../domain/directional-review-disposition";
import { getReviewOrderBuyerEmail } from "../../read-model/queries";

export type ReviewEligibilityNotify = Readonly<{ outbox: NotificationOutbox }>;

// Recomputes the review-eligibility rows for one order from the source
// projections (order, shipments, support requests). Convergent by design:
// every handler that changes an input re-runs the same computation, so
// replays and out-of-order interleavings across support requests settle on
// Marketplace's canonical directional disposition policy.
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
    cancelled_at: string | null;
  }>(
    `SELECT buyer_account_id, seller_account_id, cancelled_at::text AS cancelled_at
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
    responsibility: string | null;
    resolution_type: string | null;
    resolved_at: string | null;
    remedy_id: string | null;
    coverage_id: string | null;
    remedy_kind: string | null;
  }>(
    `SELECT
       support.status,
       support.responsibility,
       support.resolution_type,
       support.resolved_at::text AS resolved_at,
       remedy.remedy_id,
       remedy.coverage_id,
       remedy.remedy_kind
     FROM marketplace_review_support_request_sources AS support
     LEFT JOIN marketplace_review_remedy_sources AS remedy
       ON remedy.support_request_id = support.support_request_id
     WHERE support.order_id = $1`,
    [orderId],
  );

  const decision = decideDirectionalReviewDisposition({
    deliveredAt,
    cancelledAt: order.cancelled_at ?? null,
    evaluatedAt: updatedAt,
    supportRequests: supportResult.rows.map((row) => ({
      status: row.status,
      responsibility: row.responsibility,
      resolvedAt: row.resolved_at,
      resolutionType: row.resolution_type,
      remedy:
        row.remedy_id !== null && row.remedy_kind !== null && isBuyerRemedyKind(row.remedy_kind)
          ? {
              remedyId: parseTypedId(row.remedy_id, "rmd"),
              coverageId: row.coverage_id === null ? null : parseTypedId(row.coverage_id, "cov"),
              kind: row.remedy_kind,
            }
          : null,
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
    direction: DirectionalReviewDisposition;
    updatedAt: string;
    notify?: ReviewEligibilityNotify;
  }>,
) {
  if (params.direction.submissionState === "allowed") {
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
