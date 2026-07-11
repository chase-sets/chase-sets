import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { TransportEvent } from "@chase-sets/event-core/transport";
import type { NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import { mapReviewRevealedToNotification } from "./notification-intents";
import { normalizeReviewRole, type ReviewRole } from "../../domain/common";
import { getReviewOrderBuyerEmail } from "../../read-model/queries";

export const MARKETPLACE_REVIEW_NOTIFICATION_PROJECTION = "marketplace-review-notification-projection";

function correlationIdFromEvent(event: TransportEvent) {
  return event.trace.traceId ?? event.id;
}

function counterpartRole(role: ReviewRole): ReviewRole {
  return role === "buyer" ? "seller" : "buyer";
}

type ReviewRevealedEventData = Readonly<{
  reviewId: string;
  revealedAt: string;
  reason: string;
}>;

type ReviewRow = Readonly<{
  order_id: string;
  author_role: string;
  subject_account_id: string;
  author_display_name: string | null;
}>;

/**
 * Reveal-notice nudge (m108): notifies the review's SUBJECT once the
 * double-blind reveal makes it visible to them for the first time -- the
 * subject-reply feature only becomes available post-reveal, so this
 * is the moment the subject actually has something new they can act on. The
 * review row this reads (`marketplace_review_pages`) is owned by
 * `marketplace-review-projection`, populated from the earlier `submitted`
 * event on the same review's stream -- by the time any projector reaches
 * `revealed` (necessarily a later event on that same stream), the row from
 * the earlier `submitted` event is present; other notification-intent
 * projectors in this codebase already read tables owned by a different
 * projection within the same context on this same assumption (e.g. the
 * payments refund transactional-email projector reads
 * `payments_order_inputs`).
 */
export async function projectReviewRevealedToNotification(
  db: PgQueryable,
  outbox: NotificationOutbox,
  event: TransportEvent,
  projectionName = MARKETPLACE_REVIEW_NOTIFICATION_PROJECTION,
) {
  if (event.type !== "marketplace.review.revealed") {
    return;
  }

  const data = event.data as ReviewRevealedEventData;
  const reviewResult = await db.query<ReviewRow>(
    `SELECT
       page.order_id,
       page.author_role,
       page.subject_account_id,
       subject_author.display_name AS author_display_name
     FROM marketplace_review_pages AS page
     LEFT JOIN marketplace_review_account_sources AS subject_author
       ON subject_author.account_id = page.author_account_id
     WHERE page.review_id = $1`,
    [data.reviewId],
  );
  const review = reviewResult.rows[0];
  if (!review) {
    return;
  }

  const subjectRole = counterpartRole(normalizeReviewRole(review.author_role));
  const buyerEmail = subjectRole === "buyer" ? await getReviewOrderBuyerEmail(db, review.order_id) : null;

  await outbox.enqueueNotification({
    message: mapReviewRevealedToNotification({
      reviewId: data.reviewId,
      orderId: review.order_id,
      subjectAccountId: review.subject_account_id as AccountId,
      subjectRole,
      authorDisplayName: review.author_display_name,
      buyerEmail,
      correlationId: correlationIdFromEvent(event),
    }),
    source: {
      sourceEventId: event.id,
      sourceGlobalPosition: event.globalPosition,
      projectionName,
      occurredAt: event.timing.occurredAt,
    },
  });
}

export function buildReviewNotificationProjectionHandlers(
  db: PgQueryable,
  outbox: NotificationOutbox,
  projectionName = MARKETPLACE_REVIEW_NOTIFICATION_PROJECTION,
): ProjectorHandlerMap {
  return {
    "marketplace.review.revealed": (event) => projectReviewRevealedToNotification(db, outbox, event, projectionName),
  };
}
