import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import { isBuyerRemedyKind } from "@chase-sets/primitives/platform-coverage";
import { parseTypedId, type AccountId } from "@chase-sets/primitives/typed-ids";
import { mapReviewOpportunityToNotification } from "../notifications/notification-intents";
import { normalizeReviewRole } from "../../domain/common";
import { transitionReviewClock, type ReviewClockSnapshot } from "../../domain/review-clock";
import type { ReviewDirection } from "../../domain/review-hold";
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
    review_directions: readonly ReviewDirection[];
  }>(
    `SELECT
       support.status,
       support.responsibility,
       support.resolution_type,
       support.resolved_at::text AS resolved_at,
       remedy.remedy_id,
       remedy.coverage_id,
       remedy.remedy_kind,
       support.review_directions
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
  const heldDirections = new Set(
    supportResult.rows.filter((row) => row.status === "open").flatMap((row) => row.review_directions),
  );

  await applyDirection(db, {
    orderId,
    authorAccountId: order.buyer_account_id,
    subjectAccountId: order.seller_account_id,
    authorRole: "buyer",
    direction: decision.buyerToSeller,
    directionHeld: heldDirections.has("buyer-to-seller"),
    updatedAt,
    notify,
  });
  await applyDirection(db, {
    orderId,
    authorAccountId: order.seller_account_id,
    subjectAccountId: order.buyer_account_id,
    authorRole: "seller",
    direction: decision.sellerToBuyer,
    directionHeld: heldDirections.has("seller-to-buyer"),
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
    directionHeld: boolean;
    updatedAt: string;
    notify?: ReviewEligibilityNotify;
  }>,
) {
  if (
    params.direction.transactionEligibility === "eligible" &&
    (params.direction.submissionState !== "held" || params.direction.reasonCode === "support-request-open")
  ) {
    // Read-before-write (mirrors the pre-check idiom already used by other
    // notification-intent projectors in this codebase, e.g. discovery's
    // product-alert projector loading market activity before its upsert):
    // a row already present means this is an update to an already-armed
    // direction (no new opportunity to notify); no row means this grant is
    // either the first one for this order/direction or a re-arm after a
    // suspend/restore cycle deleted the prior row -- both fire the
    // opportunity notification.
    const existingResult = await db.query<{
      eligible_at: string;
      effective_deadline_at: string;
      submission_state: "allowed" | "held" | "expired";
      hold_started_at: string | null;
      paused_remaining_ms: string | null;
      reminder_armed_at: string;
      reminder_notified_at: string | null;
      hold_cycle: number;
    }>(
      `SELECT
         eligible_at::text AS eligible_at,
         effective_deadline_at::text AS effective_deadline_at,
         submission_state,
         hold_started_at::text AS hold_started_at,
         paused_remaining_ms::text AS paused_remaining_ms,
         reminder_armed_at::text AS reminder_armed_at,
         reminder_notified_at::text AS reminder_notified_at,
         hold_cycle
       FROM marketplace_review_eligibility_pages
       WHERE order_id = $1
         AND author_account_id = $2
         AND subject_account_id = $3`,
      [params.orderId, params.authorAccountId, params.subjectAccountId],
    );
    const existingRow = existingResult.rows[0];
    const existingClock: ReviewClockSnapshot | null = existingRow
      ? {
          eligibleAt: existingRow.eligible_at,
          effectiveDeadlineAt: existingRow.effective_deadline_at,
          submissionState: existingRow.submission_state,
          holdStartedAt: existingRow.hold_started_at,
          pausedRemainingMs: existingRow.paused_remaining_ms === null ? null : Number(existingRow.paused_remaining_ms),
          reminderArmedAt: existingRow.reminder_armed_at,
          reminderNotifiedAt: existingRow.reminder_notified_at,
          holdCycle: existingRow.hold_cycle,
        }
      : null;
    const { clock } = transitionReviewClock(existingClock, {
      eligibleAt: params.direction.eligibleAt,
      directionHeld: params.directionHeld,
      transitionedAt: params.updatedAt,
    });
    const isNewGrant = existingClock === null && clock.submissionState === "allowed";

    await db.query(
      `INSERT INTO marketplace_review_eligibility_pages (
         order_id,
         author_account_id,
         subject_account_id,
         author_role,
         eligible_at,
         effective_deadline_at,
         submission_state,
         hold_started_at,
         paused_remaining_ms,
         reminder_armed_at,
         reminder_notified_at,
         hold_cycle,
         updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (order_id, author_account_id, subject_account_id) DO UPDATE
       SET author_role = EXCLUDED.author_role,
           eligible_at = EXCLUDED.eligible_at,
           effective_deadline_at = EXCLUDED.effective_deadline_at,
           submission_state = EXCLUDED.submission_state,
           hold_started_at = EXCLUDED.hold_started_at,
           paused_remaining_ms = EXCLUDED.paused_remaining_ms,
           reminder_armed_at = EXCLUDED.reminder_armed_at,
           reminder_notified_at = EXCLUDED.reminder_notified_at,
           hold_cycle = EXCLUDED.hold_cycle,
           updated_at = EXCLUDED.updated_at`,
      [
        params.orderId,
        params.authorAccountId,
        params.subjectAccountId,
        params.authorRole,
        clock.eligibleAt,
        clock.effectiveDeadlineAt,
        clock.submissionState,
        clock.holdStartedAt,
        clock.pausedRemainingMs,
        clock.reminderArmedAt,
        clock.reminderNotifiedAt,
        clock.holdCycle,
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
