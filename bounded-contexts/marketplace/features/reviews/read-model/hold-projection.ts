import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ReviewDirection } from "../domain/review-hold";
import { refreshReviewSummary } from "./projection";

type ReviewHoldTransitionData = Readonly<{
  orderId: string;
  activeSupportRequestIds: readonly string[];
  heldDirections: readonly ReviewDirection[];
  holdStartedAt: string | null;
  lifecycleAt: string;
}>;

const reviewHoldEventTypes = [
  "marketplace.review-hold.placed",
  "marketplace.review-hold.extended",
  "marketplace.review-hold.reduced",
  "marketplace.review-hold.released",
  "marketplace.review-hold.terminal-recorded",
] as const;

async function projectReviewHold(db: PgQueryable, data: ReviewHoldTransitionData, contributionVersion: string) {
  const stored = await db.query<{ order_id: string }>(
    `INSERT INTO marketplace_review_hold_pages (
       order_id,
       active_support_request_ids,
       held_directions,
       held_at,
       released_at,
       last_stream_version,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (order_id) DO UPDATE SET
       active_support_request_ids = EXCLUDED.active_support_request_ids,
       held_directions = EXCLUDED.held_directions,
       held_at = EXCLUDED.held_at,
       released_at = EXCLUDED.released_at,
       last_stream_version = EXCLUDED.last_stream_version,
       updated_at = EXCLUDED.updated_at
     WHERE marketplace_review_hold_pages.last_stream_version <= EXCLUDED.last_stream_version
     RETURNING order_id`,
    [
      data.orderId,
      data.activeSupportRequestIds,
      data.heldDirections,
      data.holdStartedAt,
      data.holdStartedAt === null ? data.lifecycleAt : null,
      contributionVersion,
      data.lifecycleAt,
    ],
  );
  if (!stored.rows[0]) return;

  const affected = await db.query<{ subject_account_id: string }>(
    `UPDATE marketplace_review_pages
     SET held = CASE
       WHEN author_role = 'buyer' THEN 'buyer-to-seller' = ANY($2::text[])
       ELSE 'seller-to-buyer' = ANY($2::text[])
     END,
         rating_contribution_status =
           status = 'active' AND revealed_at IS NOT NULL AND scoring_disposition = 'included' AND NOT (
             CASE
               WHEN author_role = 'buyer' THEN 'buyer-to-seller' = ANY($2::text[])
               ELSE 'seller-to-buyer' = ANY($2::text[])
             END
           ),
         rating_contribution_version = GREATEST(rating_contribution_version, $4::bigint),
         updated_at = GREATEST(updated_at, $3::timestamptz)
     WHERE order_id = $1
       AND EXISTS (
         SELECT 1
         FROM marketplace_review_hold_pages AS hold
         WHERE hold.order_id = marketplace_review_pages.order_id
           AND hold.last_stream_version = $4::bigint
           AND hold.updated_at = $3::timestamptz
       )
     RETURNING subject_account_id`,
    [data.orderId, data.heldDirections, data.lifecycleAt, contributionVersion],
  );

  for (const subjectAccountId of new Set(affected.rows.map((row) => row.subject_account_id))) {
    await refreshReviewSummary(db, subjectAccountId, data.lifecycleAt);
  }
}

export function buildReviewHoldProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return Object.fromEntries(
    reviewHoldEventTypes.map((eventType) => [
      eventType,
      async (event: Parameters<ProjectorHandlerMap[string]>[0]) => {
        await projectReviewHold(
          db,
          event.data as ReviewHoldTransitionData,
          String(event.globalPosition ?? event.streamVersion ?? 0),
        );
      },
    ]),
  );
}
